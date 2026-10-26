import { cleanupOwnedTables } from "./ownedDynamoTables";
import { randomUUID } from "node:crypto";
import type { Service } from "@aws-sdk/client-ecs";
import {
  DynamoDBClient,
  CreateTableCommand,
  GetItemCommand,
  PutItemCommand,
  ScanCommand,
  TransactWriteItemsCommand,
  type GetItemCommandInput,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import * as builders from "../../../src/services/deploymentControlTransactions";
import * as types from "../../../src/types/deploymentControl";
import {
  introductionFixture,
  phaseAuthorization,
} from "../../fixtures/deployment/productionIntroduction.js";
import { createProductionIntroduction } from "../../../scripts/deployment/introduce-production.cjs";
import { stateDigest } from "../../../scripts/deployment/production-evidence.cjs";
import { manifestHash } from "../../../scripts/deployment/sandbox-manifest.cjs";
import { runtime } from "../controlFixtures";
type FixtureAuthorization = Omit<
  ReturnType<typeof phaseAuthorization>,
  "envelope"
> & {
  envelope: Omit<
    ReturnType<typeof phaseAuthorization>["envelope"],
    "recovery"
  > & {
    recovery: null | {
      submittedReceiptSha256: string;
      evidenceSha256: string;
      target: "fallback" | "inspect";
    };
  };
};

type NativeFixture = ReturnType<typeof introductionFixture>;
type NativeProbeResult = Awaited<ReturnType<NativeFixture["options"]["probe"]>>;
type ProbeResult = Omit<
  NativeProbeResult,
  "probes" | "settlements" | "compatibility"
> & {
  probes: NativeProbeResult["probes"] | null;
  settlements: {
    table: string;
    rowDigest: string;
    effects: "acknowledged";
    evidenceId: string;
  }[];
  compatibility: Omit<NativeProbeResult["compatibility"], "uploads"> & {
    uploads: {
      uploadId: string;
      rowDigest: string;
      sourceInput: "verified";
      token: "verified";
      schema: "verified";
      ownership: "verified";
      claimProtocol: "verified";
      evidenceId: string;
      validUntil: number;
    }[];
  };
};

export const client = new DynamoDBClient({
  endpoint: process.env.DEPLOYMENT_TEST_DYNAMODB_ENDPOINT,
  region: "local",
  credentials: { accessKeyId: "dummy", secretAccessKey: "dummy" },
  maxAttempts: 1,
});
const created: string[] = [];
afterAll(() => cleanupOwnedTables(client, created));
export async function readStored(
  TableName: string,
  Key: NonNullable<GetItemCommandInput["Key"]>,
) {
  const result = await client.send(
    new GetItemCommand({ TableName, Key, ConsistentRead: true }),
  );
  return result.Item;
}
export async function readControl(TableName: string) {
  const item = await readStored(
    TableName,
    marshall({ pk: "ENV", sk: "CONTROL" }),
  );
  return item ? unmarshall(item) : undefined;
}

export async function fixture(
  sameDefinition = false,
  startCandidate?: (
    identity: types.RuntimeIdentity,
    controlTable: string,
  ) => Promise<void>,
) {
  const f: NativeFixture & { svc: Pick<Service, "deployments"> } =
      introductionFixture(marshall, unmarshall, stateDigest),
    m = f.m;
  if (sameDefinition) {
    m.fallbackTaskDefinition = m.taskDefinition;
    m.fallbackSourceSha = m.binding.sourceSha;
    m.fallbackDigest = m.binding.candidateDigest;
  }
  const physical = new Map<string, string>(),
    prefix = "introduction-" + randomUUID() + "-";
  const entries = [
    ...Object.entries(m.binding.tableArns),
    ["control", m.controlTableArn],
  ];
  const keys: Record<string, string[]> = {
    leases: ["guildId"],
    history: ["guildId", "channelId_timestamp"],
    controls: ["requestId"],
    uploads: ["uploadId"],
    segments: ["uploadId", "segmentKey"],
    billing: ["guildId"],
    webhooks: ["eventId"],
    payments: ["TransactionID"],
    control: ["pk", "sk"],
  };
  for (const [slot, arn] of entries) {
    const TableName =
      prefix + arn.split("/").at(-1)!.slice(m.tablePrefix.length);
    physical.set(arn, TableName);
    await client.send(
      new CreateTableCommand({
        TableName,
        BillingMode: "PAY_PER_REQUEST",
        KeySchema: keys[slot].map((AttributeName, i) => ({
          AttributeName,
          KeyType: i ? "RANGE" : "HASH",
        })),
        AttributeDefinitions: keys[slot].map((AttributeName) => ({
          AttributeName,
          AttributeType: "S",
        })),
      }),
    );
    created.push(TableName);
  }
  const controlTable = physical.get(m.controlTableArn)!;
  const candidateArn = m.legacyTaskArn.slice(0, -32) + "a".repeat(32);
  const row = runtime("candidate", "candidate");
  row.identity = {
    ...row.identity,
    kind: "ecs",
    taskArn: candidateArn,
    imageDigest: m.binding.candidateDigest,
    candidateId: m.binding.operationId,
  };
  row.authorizedGeneration = 0;
  row.heartbeatAt = 1000;
  row.readiness = {
    ...row.readiness,
    identity: row.identity,
    observedEpoch: 1,
    observedGeneration: 0,
    provenAt: 1000,
    expiresAt: 2000,
  };
  row.protection = { identity: row.identity, provenAt: 1000, expiresAt: 2000 };
  row.workCounts = {
    pending_admission: 0,
    recording: 0,
    finalization: 0,
    personal_processing: 0,
    recovery_processing: 0,
    voice_operation: 0,
    ancillary_delivery: 0,
  };
  let candidate = false,
    failed = false,
    selectedDefinition = m.taskDefinition,
    activeArn = candidateArn,
    principal = "",
    listenerActions = [{ Type: "forward", TargetGroupArn: m.targetGroupA }],
    fault = "";
  m.originalRoutingSha256 = stateDigest(listenerActions);
  f.options.expectedSha256 = manifestHash(m);
  const native = f.options.aws,
    originalProbe = f.options.probe;
  const probe = async (request: Parameters<typeof originalProbe>[0]) => {
    const result: ProbeResult = await originalProbe(request);
    if (candidate) {
      result.tasks = [
        {
          taskArn: m.legacyTaskArn,
          taskDefinitionArn: m.legacyTaskDefinition,
          sourceSha: m.binding.legacySha,
          lastStatus: "STOPPED",
        },
        {
          taskArn: activeArn,
          taskDefinitionArn: selectedDefinition,
          sourceSha:
            selectedDefinition === m.taskDefinition
              ? m.binding.sourceSha
              : m.fallbackSourceSha,
          lastStatus: failed ? "STOPPED" : "RUNNING",
        },
      ];
      result.owners = ["candidate"];
      result.probes = {
        meetingAcquire: f.isOwned() ? "iam_denied" : "condition_refused",
        uploadClaim: f.isOwned() ? "iam_denied" : "condition_refused",
        uploadRenew: "condition_refused",
        uploadProgress: "condition_refused",
        meetingRelease: "condition_refused",
        meetingRenew: "condition_refused",
      };
    }
    if (failed) {
      result.owners = [];
      result.probes = null;
    }
    return result;
  };
  probe.capture = originalProbe.capture;
  probe.readCapture = originalProbe.readCapture;
  const calls: string[] = [];
  async function dynamo(operation: string, input: object) {
    let serialized = JSON.stringify(input);
    for (const [arn, name] of physical)
      serialized = serialized.replaceAll(arn, name);
    const request = JSON.parse(serialized);
    if (operation === "get-item")
      return client.send(new GetItemCommand(request));
    if (operation === "scan") return client.send(new ScanCommand(request));
    if (operation === "transact-write-items") {
      const result = await client.send(new TransactWriteItemsCommand(request));
      if (fault === "receipt") throw new Error("Lost receipt acknowledgment");
      if (
        fault === "initialize" &&
        request.TransactItems.some(
          (entry: { Put?: { Item: { sk: { S: string } } } }) =>
            entry.Put?.Item.sk.S === "CONTROL",
        )
      )
        throw new Error("Lost initialize acknowledgment");
      if (
        fault === "promotion" &&
        request.TransactItems.some(
          (entry: { Update?: { UpdateExpression: string } }) =>
            entry.Update?.UpdateExpression.includes(
              "servingGeneration = :next",
            ),
        )
      )
        throw new Error("Lost promotion acknowledgment");
      return result;
    }
  }
  const serviceRequests: object[] = [];
  async function launchCandidate(request: { taskDefinition: string }) {
    const replacing = candidate;
    candidate = true;
    selectedDefinition = request.taskDefinition;
    failed = fault === "failed";
    if (replacing && selectedDefinition === m.fallbackTaskDefinition) {
      activeArn = candidateArn.slice(0, -32) + "b".repeat(32);
      row.identity = {
        ...row.identity,
        kind: "ecs",
        taskArn: activeArn,
        imageDigest: m.fallbackDigest,
        candidateId: m.binding.operationId,
      };
      row.readiness.identity = row.identity;
      row.protection.identity = row.identity;
    }
    f.svc.taskDefinition = selectedDefinition;
    f.svc.desiredCount = 1;
    f.svc.runningCount = failed ? 0 : 1;
    f.svc.deployments = [
      {
        id: "deployment",
        status: "PRIMARY",
        taskDefinition: selectedDefinition,
        rolloutState: failed ? "FAILED" : "COMPLETED",
      },
    ];
    if (startCandidate) await startCandidate(row.identity, controlTable);
    else
      await client.send(
        new PutItemCommand({ TableName: controlTable, Item: marshall(row) }),
      );
  }
  async function updateService(input: object) {
    const request = JSON.parse(JSON.stringify(input));
    serviceRequests.push(request);
    if (
      failed &&
      request.taskDefinition === selectedDefinition &&
      !request.forceNewDeployment
    )
      return {};
    if (request.desiredCount === 0) {
      f.svc.desiredCount = f.svc.runningCount = 0;
      f.legacy.lastStatus = "STOPPED";
    } else {
      await launchCandidate(request);
    }
    if (fault === "shutdown" && !candidate)
      throw new Error("Lost shutdown acknowledgment");
    if (fault === "launch" && candidate)
      throw new Error("Lost launch acknowledgment");
    return {};
  }
  async function elbv2(operation: string, input: object) {
    if (operation === "describe-listeners")
      return {
        Listeners: [
          {
            ListenerArn: m.listenerArn,
            LoadBalancerArn: "lb",
            DefaultActions: listenerActions,
          },
        ],
      };
    if (operation === "modify-listener") {
      listenerActions = JSON.parse(JSON.stringify(input)).DefaultActions;
      if (fault === "routing") throw new Error("Lost routing acknowledgment");
      return {};
    }
    if (operation === "describe-target-groups")
      return {
        TargetGroups: [m.targetGroupA, m.targetGroupB].map(
          (TargetGroupArn) => ({
            TargetGroupArn,
            TargetType: "ip",
            Protocol: "HTTP",
            Port: 3001,
            VpcId: "vpc",
            HealthCheckPath: "/health",
            LoadBalancerArns: TargetGroupArn === m.targetGroupB ? [] : ["lb"],
          }),
        ),
      };
    if (operation === "describe-target-group-attributes")
      return { Attributes: [{ Key: "stickiness.enabled", Value: "false" }] };
    if (operation === "describe-target-health")
      return {
        TargetHealthDescriptions: [
          {
            Target: { Id: "10.0.0.1", Port: 3001 },
            TargetHealth: { State: "healthy" },
          },
        ],
      };
    throw new Error("Unexpected ELB operation");
  }
  function adaptFallback(
    operation: string,
    input: object,
    result: ReturnType<typeof JSON.parse>,
  ) {
    if (
      operation === "describe-task-definition" &&
      JSON.parse(JSON.stringify(input)).taskDefinition ===
        m.fallbackTaskDefinition
    ) {
      result.taskDefinition.taskDefinitionArn = m.fallbackTaskDefinition;
      result.taskDefinition.containerDefinitions[0].image =
        result.taskDefinition.containerDefinitions[0].image.replace(
          m.binding.candidateDigest,
          m.fallbackDigest,
        );
    }
    if (
      operation === "describe-images" &&
      JSON.parse(JSON.stringify(input)).imageIds[0].imageTag ===
        m.fallbackSourceSha
    )
      result.imageDetails[0].imageDigest = m.fallbackDigest;
  }
  async function aws(service: string, operation: string, input: object) {
    calls.push(operation);
    if (service === "sts")
      return { Account: m.binding.accountId, Arn: principal };
    if (service === "dynamodb") return dynamo(operation, input);
    if (operation === "update-service") return updateService(input);
    if (operation === "list-tasks")
      return {
        taskArns: candidate ? [m.legacyTaskArn, activeArn] : [m.legacyTaskArn],
      };
    if (operation === "describe-tasks" && candidate) {
      const request = JSON.parse(JSON.stringify(input));
      return {
        tasks: request.tasks.map((arn: string) =>
          arn === m.legacyTaskArn
            ? f.legacy
            : {
                taskArn: activeArn,
                taskDefinitionArn: selectedDefinition,
                lastStatus: failed ? "STOPPED" : "RUNNING",
                containers: [
                  {
                    name: m.containerName,
                    imageDigest:
                      selectedDefinition === m.taskDefinition
                        ? m.binding.candidateDigest
                        : m.fallbackDigest,
                    networkInterfaces: [{ privateIpv4Address: "10.0.0.1" }],
                  },
                ],
              },
        ),
      };
    }
    if (service === "elbv2") return elbv2(operation, input);
    if (operation === "get-task-protection")
      return {
        protectedTasks: [
          {
            taskArn: activeArn,
            protectionEnabled: true,
            expirationDate: new Date(2000000).toISOString(),
          },
        ],
      };
    const result = await native(service, operation, input);
    adaptFallback(operation, input, result);
    if (fault === "fence" && operation === "put-role-policy")
      throw new Error("Lost fence acknowledgment");
    if (fault === "removal" && operation === "delete-role-policy")
      throw new Error("Lost removal acknowledgment");
    return result;
  }
  const options: Omit<typeof f.options, "aws" | "probe"> & {
    aws: typeof aws;
    probe: typeof probe;
    builders: typeof builders;
    types: typeof types;
    authorization?: FixtureAuthorization;
  } = { ...f.options, aws, probe, builders, types };
  async function head() {
    const result = await client.send(
      new GetItemCommand({
        TableName: controlTable,
        Key: marshall({ pk: "ENV", sk: "PRODUCTION_INTRODUCTION" }),
        ConsistentRead: true,
      }),
    );
    return result.Item ? unmarshall(result.Item) : null;
  }
  async function run(phase: string, runId: string, recovery = false) {
    options.authorization = phaseAuthorization(
      m,
      phase,
      (await head())?.receiptSha256 ?? null,
      runId,
    );
    if (recovery) {
      const current = await head();
      const stored = await client.send(
        new GetItemCommand({
          TableName: controlTable,
          Key: marshall({ pk: "ENV", sk: current!.receiptKey }),
        }),
      );
      const receipt = JSON.parse(unmarshall(stored.Item!).bodyJson);
      options.authorization.envelope.recovery = {
        submittedReceiptSha256: current!.receiptSha256,
        evidenceSha256: receipt.proof.captures.at(-1).capture.sha256,
        target: phase === "activate" ? "fallback" : "inspect",
      };
      options.authorization.expectedSha256 = options.authorization.bindSha256 =
        manifestHash(options.authorization.envelope);
    }
    principal = options.authorization.envelope.principalArn;
    return createProductionIntroduction(options).run(phase);
  }
  return {
    ...f,
    options,
    row,
    run,
    head,
    controlTable,
    physical,
    serviceRequests,
    calls,
    setFault: (value: string) => {
      fault = value;
    },
  };
}
