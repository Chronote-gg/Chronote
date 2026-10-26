import { cleanupOwnedTables } from "./ownedDynamoTables";
import { randomUUID, createHash } from "node:crypto";
import {
  DynamoDBClient,
  CreateTableCommand,
  GetItemCommand,
  ScanCommand,
  TransactWriteItemsCommand,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import * as builders from "../../../src/services/deploymentControlTransactions";
import * as types from "../../../src/types/deploymentControl";
import { createBootstrap } from "../../../scripts/deployment/bootstrap-sandbox.cjs";

export const client = new DynamoDBClient({
  endpoint: process.env.DEPLOYMENT_TEST_DYNAMODB_ENDPOINT,
  region: "local",
  credentials: { accessKeyId: "dummy", secretAccessKey: "dummy" },
});
const created: string[] = [];
afterAll(() => cleanupOwnedTables(client, created));
export async function fixture() {
  const account = "123456789012",
    region = "us-east-1";
  const prefix = `test-sandbox-${randomUUID()}-`;
  const table = `${prefix}DeploymentControlTable`;
  const leaseTable = `${prefix}ActiveMeetingTable`;
  for (const [TableName, keys] of [
    [table, ["pk", "sk"]],
    [leaseTable, ["guildId"]],
  ] as const) {
    await client.send(
      new CreateTableCommand({
        TableName,
        BillingMode: "PAY_PER_REQUEST",
        KeySchema: keys.map((AttributeName, index) => ({
          AttributeName,
          KeyType: index ? "RANGE" : "HASH",
        })),
        AttributeDefinitions: keys.map((AttributeName) => ({
          AttributeName,
          AttributeType: "S",
        })),
      }),
    );
    created.push(TableName);
  }
  const ecs = `arn:aws:ecs:${region}:${account}`;
  const elb = `arn:aws:elasticloadbalancing:${region}:${account}`;
  const manifest = {
    environment: "sandbox",
    accountId: account,
    region,
    principalArn: `arn:aws:iam::${account}:user/test-deployer`,
    operationId: randomUUID(),
    sourceCommit: "a".repeat(40),
    tablePrefix: prefix,
    bucket: "test-sandbox-bucket",
    cluster: "test-sandbox-cluster",
    service: "test-sandbox-service",
    legacyTaskDefinition: `${ecs}:task-definition/test-sandbox-task:1`,
    taskDefinition: `${ecs}:task-definition/test-sandbox-task:2`,
    imageDigest: `sha256:${"b".repeat(64)}`,
    containerName: "test-sandbox-bot",
    runtimeMode: "all",
    containerPort: 3001,
    listenerArn: `${elb}:listener/app/test-sandbox/1/2`,
    targetGroupA: `${elb}:targetgroup/test-sandbox-a/1`,
    targetGroupB: `${elb}:targetgroup/test-sandbox-b/2`,
    maintenance: {
      testOnly: true,
      workSettled: true,
      receiptSha256: "c".repeat(64),
      confirmedAt: new Date(1000 * 1000).toISOString(),
    },
  };
  const hash = createHash("sha256")
    .update(JSON.stringify(manifest))
    .digest("hex");
  const state = {
    desired: 0,
    running: false,
    nativeProtected: true,
    proofExpires: 2000,
    launchUnknown: false,
    transactionLost: false,
    updates: 0,
  };
  const taskArn = `${ecs}:task/test-sandbox-cluster/test-task`;
  const identity = {
    kind: "ecs",
    instanceId: "runtime",
    protocolVersion: 1,
    candidateId: manifest.operationId,
    imageDigest: manifest.imageDigest,
    taskArn,
  };
  const controlKey = { pk: "ENV", sk: "CONTROL" };
  async function get(sk: string) {
    const out = await client.send(
      new GetItemCommand({
        TableName: table,
        Key: marshall({ pk: "ENV", sk }),
        ConsistentRead: true,
      }),
    );
    return out.Item ? unmarshall(out.Item) : undefined;
  }
  async function dynamodb(operation: string, input: Record<string, never>) {
    if (operation === "get-item") return client.send(new GetItemCommand(input));
    if (operation === "scan") return client.send(new ScanCommand(input));
    if (operation === "transact-write-items") {
      const result = await client.send(new TransactWriteItemsCommand(input));
      if (state.transactionLost) {
        state.transactionLost = false;
        throw new Error("ACK lost after apply");
      }
      return result;
    }
    throw new Error(`Unexpected dynamodb.${operation}`);
  }
  async function ecsResponse(operation: string) {
    if (operation === "describe-services")
      return {
        failures: [],
        services: [
          {
            serviceName: manifest.service,
            taskDefinition: state.desired
              ? manifest.taskDefinition
              : manifest.legacyTaskDefinition,
            desiredCount: state.desired,
            runningCount: state.running ? 1 : 0,
            pendingCount: 0,
            loadBalancers: [
              {
                targetGroupArn: manifest.targetGroupA,
                containerName: manifest.containerName,
                containerPort: 3001,
              },
            ],
          },
        ],
      };
    if (operation === "list-tasks")
      return { taskArns: state.running ? [taskArn] : [] };
    if (operation === "describe-tasks")
      return {
        failures: [],
        tasks: state.running
          ? [
              {
                taskArn,
                taskDefinitionArn: manifest.taskDefinition,
                lastStatus: "RUNNING",
                containers: [
                  {
                    name: manifest.containerName,
                    imageDigest: manifest.imageDigest,
                    networkInterfaces: [{ privateIpv4Address: "10.0.0.1" }],
                  },
                ],
              },
            ]
          : [],
      };
    if (operation === "describe-task-definition")
      return {
        taskDefinition: {
          taskDefinitionArn: manifest.taskDefinition,
          status: "ACTIVE",
          containerDefinitions: [
            {
              name: manifest.containerName,
              image: `test.invalid/sandbox@${manifest.imageDigest}`,
              command: ["node", "dist/index.js"],
              stopTimeout: 120,
              environment: [
                { name: "DDB_TABLE_PREFIX", value: prefix },
                { name: "TRANSCRIPTS_BUCKET", value: manifest.bucket },
                {
                  name: "DEPLOYMENT_CANDIDATE_ID",
                  value: manifest.operationId,
                },
              ],
            },
          ],
        },
      };
    if (operation === "get-task-protection")
      return {
        failures: [],
        protectedTasks: [
          {
            taskArn,
            protectionEnabled: state.nativeProtected,
            expirationDate: new Date(state.proofExpires * 1000).toISOString(),
          },
        ],
      };
    if (operation === "update-service") return launchCandidate();
    throw new Error(`Unexpected ecs.${operation}`);
  }
  async function launchCandidate() {
    state.updates++;
    state.desired = 1;
    state.running = true;
    const ctl = await get("CONTROL");
    await client.send(
      new PutItemCommand({
        TableName: table,
        Item: marshall({
          pk: "ENV",
          sk: "RUNTIME#runtime",
          recordType: "runtime",
          identity,
          role: "candidate",
          authorizedGeneration: 0,
          heartbeatAt: 1000,
          readiness: {
            identity,
            runtimeMode: "all",
            observedEpoch: ctl!.coordinatorEpoch,
            observedGeneration: 0,
            gatewayReady: true,
            cacheReady: true,
            dependenciesReady: true,
            provenAt: 1000,
            expiresAt: 1030,
          },
          protection: { identity, provenAt: 1000, expiresAt: 2000 },
          workCounts: {
            pending_admission: 0,
            recording: 0,
            finalization: 0,
            personal_processing: 0,
            recovery_processing: 0,
            voice_operation: 0,
            ancillary_delivery: 0,
          },
        }),
      }),
    );
    if (state.launchUnknown) throw new Error("UpdateService response lost");
    return { service: { taskDefinition: manifest.taskDefinition } };
  }
  async function elbv2(operation: string, input: Record<string, never>) {
    if (operation === "describe-listeners")
      return {
        Listeners: [
          {
            ListenerArn: manifest.listenerArn,
            Protocol: "HTTPS",
            LoadBalancerArn: "lb",
            DefaultActions: [
              {
                Type: "forward",
                ForwardConfig: {
                  TargetGroups: [
                    { TargetGroupArn: manifest.targetGroupA, Weight: 100 },
                    { TargetGroupArn: manifest.targetGroupB, Weight: 0 },
                  ],
                  TargetGroupStickinessConfig: { Enabled: false },
                },
              },
            ],
          },
        ],
      };
    if (operation === "describe-rules") return { Rules: [{ IsDefault: true }] };
    if (operation === "describe-target-groups")
      return {
        TargetGroups: [manifest.targetGroupA, manifest.targetGroupB].map(
          (TargetGroupArn) => ({
            TargetGroupArn,
            TargetType: "ip",
            Protocol: "HTTP",
            Port: 3001,
            VpcId: "sandbox-vpc",
            HealthCheckPath: "/health",
            LoadBalancerArns: ["lb"],
          }),
        ),
      };
    if (operation === "describe-target-group-attributes")
      return { Attributes: [{ Key: "stickiness.enabled", Value: "false" }] };
    if (operation === "describe-target-health") {
      const group = (input as Record<string, unknown>).TargetGroupArn;
      return {
        TargetHealthDescriptions:
          state.running && group === manifest.targetGroupA
            ? [
                {
                  Target: { Id: "10.0.0.1", Port: 3001 },
                  TargetHealth: { State: "healthy" },
                },
              ]
            : [],
      };
    }
    throw new Error(`Unexpected elbv2.${operation}`);
  }
  async function aws(
    service: string,
    operation: string,
    input: Record<string, never>,
  ) {
    switch (service) {
      case "dynamodb":
        return dynamodb(operation, input);
      case "sts":
        return { Account: account, Arn: manifest.principalArn };
      case "ecs":
        return ecsResponse(operation);
      case "elbv2":
        return elbv2(operation, input);
      default:
        throw new Error(`Unexpected ${service}.${operation}`);
    }
  }
  const bootstrap = createBootstrap({
    manifest,
    expectedSha256: hash,
    aws,
    builders,
    types,
    now: () => 1000,
  });
  return {
    manifest,
    hash,
    state,
    bootstrap,
    get,
    table,
    leaseTable,
    controlKey,
    aws,
  };
}

export function bootstrapFor(
  f: Awaited<ReturnType<typeof fixture>>,
  options = {},
) {
  return createBootstrap({
    manifest: f.manifest,
    expectedSha256: f.hash,
    aws: f.aws,
    builders,
    types,
    now: () => 1000,
    ...options,
  });
}

export async function putRecord(
  f: { table: string },
  row: Parameters<typeof marshall>[0],
) {
  await client.send(
    new PutItemCommand({ TableName: f.table, Item: marshall(row) }),
  );
}

export async function writeIntroduction(
  f: Awaited<ReturnType<typeof fixture>>,
  overrides = {},
) {
  await putRecord(f, {
    pk: "ENV",
    sk: "INTRODUCTION",
    operationId: f.manifest.operationId,
    manifestSha256: f.hash,
    principalArn: f.manifest.principalArn,
    stage: "routing_acknowledged",
    ...overrides,
  });
}
