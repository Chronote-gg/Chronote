import { meetingUpdateIndexMetadata } from "../../fixtures/productionMeetingUpdateIndex.js";
import { randomUUID } from "node:crypto";
import { jest } from "@jest/globals";
import { reviewedRoutes } from "../../fixtures/productionReviewedSource.js";
import { GetItemCommand, QueryCommand } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import {
  introductionClient as client,
  createIntroductionTable,
  readIntroductionDocument,
  putIntroductionDocument,
  writeIntroduction,
} from "./introductionStore";
import { completeManifest } from "../../fixtures/productionCompleteManifest.js";
import { bound } from "../../fixtures/productionManifest.js";
import { canonicalHash } from "../../../scripts/deployment/production-manifest.cjs";
import {
  definitionMetadata,
  createInventoryReader,
} from "../../../scripts/deployment/production-inventory-adapter.cjs";
import {
  createCandidateInspection,
  candidateSlot,
} from "../../../scripts/deployment/production-candidate.cjs";
import { verifyDeclaredRoutes } from "../../../scripts/deployment/production-source-routes.cjs";
import { counts } from "./coordinatorFixture";
jest.mock("node:fs", () => ({
  ...jest.requireActual("node:fs"),
  readFileSync: (...args) =>
    jest
      .requireActual("../../fixtures/productionReviewedSource.js")
      .sourceTransport.read(...args),
}));
export async function productionOrchestrationFixture(settings = {}) {
  const m = completeManifest();
  m.runtime.continuationDigest = m.runtime.candidateDigest;
  const prefix = `task5-${randomUUID()}-`;
  for (const [name, suffix] of Object.entries({
    deploymentControl: "DeploymentControlTable",
    activeMeeting: "ActiveMeetingTable",
    meetingHistory: "MeetingHistoryTable",
    meetingControl: "MeetingControlCommandTable",
    personalJob: "PersonalMediaUploadJobTable",
    personalSegment: "PersonalRecordingSegmentTable",
    notion: "NotionIntegrationTable",
    stripeWebhook: "StripeWebhookEventTable",
    guildSubscription: "GuildSubscriptionTable",
  }))
    m.resources.tables[name] = prefix + suffix;
  const table = m.resources.tables.deploymentControl;
  await createIntroductionTable(table);
  await createIntroductionTable(m.resources.tables.meetingControl, [
    "requestId",
  ]);
  await createIntroductionTable(m.resources.tables.meetingHistory, [
    "guildId",
    "channelId_timestamp",
  ]);
  const state = {
    time: 150,
    lose: undefined,
    failReady: false,
    timed: false,
    pauseWarming: false,
    expireOnSubmitted: undefined,
    expireAfterControlRead: undefined,
    expireAfterDirectAck: undefined,
    delayFailedRetirement: 0,
    failedRetirementAt: undefined,
    delayReplacementLaunch: 0,
    replacementVisibleAt: undefined,
    recordings: [],
    writeTimes: [],
    attachedB: false,
    tasks: [],
    revisions: [],
    writes: [],
  };
  const service = {
    serviceArn: m.runtime.serviceArn,
    taskDefinition: m.runtime.legacyDefinition,
    desiredCount: 1,
    runningCount: 1,
    pendingCount: 0,
    deploymentController: { type: "ECS" },
    deploymentConfiguration: {
      minimumHealthyPercent: 100,
      maximumPercent: 200,
    },
    loadBalancers: [
      {
        targetGroupArn: m.resources.targetGroupA,
        containerName: m.runtime.container,
        containerPort: 3001,
      },
    ],
    deployments: [{ rolloutState: "COMPLETED" }],
  };
  let actions = [{ Type: "forward", TargetGroupArn: m.resources.targetGroupA }];
  const definitions = new Map();
  for (const slot of ["bootstrap", "replacement", "handoff"]) {
    const s = candidateSlot(m, slot),
      environment = [
        { name: "DDB_TABLE_PREFIX", value: prefix },
        { name: "TRANSCRIPTS_BUCKET", value: m.resources.bucket },
        { name: "DEPLOYMENT_CANDIDATE_ID", value: s.candidateId },
      ];
    definitions.set(s.definition, {
      taskDefinitionArn: s.definition,
      family: m.runtime.family,
      status: "ACTIVE",
      cpu: "512",
      memory: "1024",
      taskRoleArn: m.resources.taskRoleArn,
      executionRoleArn: m.resources.executionRoleArn,
      networkMode: "awsvpc",
      containerDefinitions: [
        {
          name: m.runtime.container,
          image: `123456789012.dkr.ecr.us-east-1.amazonaws.com/app@${s.digest}`,
          command: ["node", "dist/index.js"],
          stopTimeout: 120,
          portMappings: [{ containerPort: 3001, protocol: "tcp" }],
          environment,
          environmentNames: environment.map((e) => e.name),
        },
      ],
    });
  }
  const legacy = JSON.parse(
    JSON.stringify(definitions.get(m.runtime.candidateDefinition)),
  );
  legacy.taskDefinitionArn = m.runtime.legacyDefinition;
  legacy.containerDefinitions[0].environment =
    legacy.containerDefinitions[0].environment.filter(
      (e) => e.name !== "DEPLOYMENT_CANDIDATE_ID",
    );
  legacy.containerDefinitions[0].environmentNames =
    legacy.containerDefinitions[0].environment.map((e) => e.name);
  definitions.set(m.runtime.legacyDefinition, legacy);
  m.runtime.configurationHash = canonicalHash(definitionMetadata(legacy));
  m.launcherRoutes = reviewedRoutes(m);
  settings.configure?.(m);
  const instanceId = (slot) => settings.instanceIds?.[slot] ?? slot;
  const binding = bound(m),
    read = async (key) => {
      const row = await readIntroductionDocument(table, key);
      if (key.sk === "CONTROL" && state.expireAfterControlRead) {
        const action = await readIntroductionDocument(table, {
          pk: `INTRODUCTION#${m.introductionId}`,
          sk: `ACTION#${state.expireAfterControlRead}`,
        });
        if (action?.phase === "submitted")
          state.time = row.coordinatorExpiresAt;
      }
      return row;
    },
    put = (value) => putIntroductionDocument(table, value);
  const task = (slot, index) => {
    const s =
      slot === "legacy"
        ? {
            definition: m.runtime.legacyDefinition,
            digest: m.runtime.candidateDigest,
          }
        : candidateSlot(m, slot);
    return {
      taskArn:
        slot === "legacy"
          ? m.runtime.legacyTaskArns[0]
          : m.runtime.clusterArn.replace("cluster/", "task/") + `/${slot}`,
      taskDefinitionArn: s.definition,
      group: "service:app",
      lastStatus: "RUNNING",
      desiredStatus: "RUNNING",
      slot,
      address: `10.0.0.${index}`,
      containers: [
        {
          name: m.runtime.container,
          imageDigest: s.digest,
          networkInterfaces: [{ privateIpv4Address: `10.0.0.${index}` }],
        },
      ],
    };
  };
  state.tasks.push(task("legacy", 1));
  async function registerRuntime(t) {
    const s = candidateSlot(m, t.slot),
      ctl = await read({ pk: "ENV", sk: "CONTROL" });
    const identity = {
      kind: "ecs",
      instanceId: instanceId(t.slot),
      protocolVersion: 1,
      candidateId: s.candidateId,
      imageDigest: s.digest,
      taskArn: t.taskArn,
    };
    await put({
      pk: "ENV",
      sk: `RUNTIME#${instanceId(t.slot)}`,
      recordType: "runtime",
      identity,
      role: "candidate",
      authorizedGeneration: ctl.servingGeneration,
      heartbeatAt: state.time,
      workCounts: counts(),
      readiness: {
        identity,
        runtimeMode: "all",
        observedEpoch: ctl.coordinatorEpoch,
        observedGeneration: ctl.servingGeneration,
        gatewayReady: true,
        cacheReady: true,
        dependenciesReady: true,
        provenAt: state.time,
        expiresAt: state.time + 30,
      },
      protection: {
        identity,
        provenAt: state.time,
        expiresAt: state.time + 600,
      },
    });
  }
  function retireRuntime(r, t, ctl) {
    const recording = state.recordings.find(
      (x) => x.instanceId === instanceId(t.slot),
    );
    if (r.retirementRequest && ctl.servingGeneration === 0)
      state.failedRetirementAt ??= state.time + state.delayFailedRetirement;
    if (
      (ctl.servingGeneration !== 0 || state.time >= state.failedRetirementAt) &&
      r.retirementRequest &&
      (!recording || state.time >= recording.endsAt)
    ) {
      r.role = "retired";
      r.workCounts = counts();
      r.retirementAcknowledgment ??= {
        request: r.retirementRequest,
        retiredAt: state.time,
      };
      if (
        (t.slot !== "bootstrap" || ctl.servingGeneration > 0) &&
        (!recording || state.time >= r.retirementAcknowledgment.retiredAt + 300)
      ) {
        t.lastStatus = t.desiredStatus = "STOPPED";
      }
    }
  }
  async function refreshRuntime() {
    const ctl = await read({ pk: "ENV", sk: "CONTROL" });
    if (!ctl) return;
    for (const t of state.tasks.filter((t) => t.slot !== "legacy")) {
      const r = await read({ pk: "ENV", sk: `RUNTIME#${instanceId(t.slot)}` });
      if (!r) continue;
      Object.assign(r.readiness, {
        observedEpoch: ctl.coordinatorEpoch,
        observedGeneration: ctl.servingGeneration,
        provenAt: state.time,
        expiresAt: state.time + 30,
      });
      Object.assign(r.protection, {
        provenAt: state.time,
        expiresAt: state.time + 600,
      });
      const recording = state.recordings.find(
        (item) => item.instanceId === r.identity.instanceId,
      );
      if (recording && state.time >= recording.endsAt) r.workCounts = counts();
      retireRuntime(r, t, ctl);
      await put(r);
    }
    service.runningCount = state.tasks.filter(
      (t) => t.lastStatus === "RUNNING",
    ).length;
  }
  async function write(input) {
    const response = await writeIntroduction(input);
    if (
      input.TransactItems.some(
        (item) =>
          item.Put?.Item.phase?.S === "submitted" &&
          item.Put.Item.actionId?.S === state.expireOnSubmitted,
      )
    ) {
      state.time = (
        await read({ pk: "ENV", sk: "CONTROL" })
      ).coordinatorExpiresAt;
    }
    await refreshRuntime();
    return response;
  }
  async function consumeGrants(input) {
    for (const item of input.TransactItems) {
      if (!item.Put) continue;
      const grant = unmarshall(item.Put.Item);
      if (grant.recordType !== "fixture_grant") continue;
      const ctl = await read({ pk: "ENV", sk: "CONTROL" }),
        owner = Object.values(ctl.servingMembers)[0];
      await put({
        ...grant,
        state: "consumed",
        ownership: {
          guildId: grant.guildId,
          meetingId: grant.meetingId,
          ownerInstanceId: owner.instanceId,
          executionVersion: 1,
          voiceOperationAttemptId: "voice-attempt",
          sessionMode: "meeting",
        },
        historyKey: {
          guildId: grant.guildId,
          channelId_timestamp: grant.meetingId,
        },
      });
      const row = await read({ pk: "ENV", sk: `RUNTIME#${owner.instanceId}` });
      if (state.timed)
        state.recordings.push({
          instanceId: owner.instanceId,
          startedAt: state.time,
          endsAt: state.time + (settings.recordingDuration ?? 180),
        });
      row.workCounts = counts(1);
      await put(row);
    }
  }
  function targetHealth(group) {
    return state.tasks
      .filter(
        (t) =>
          t.lastStatus === "RUNNING" &&
          (t.slot === "handoff"
            ? m.resources.targetGroupB
            : m.resources.targetGroupA) === group,
      )
      .map((t) => ({
        Target: { Id: t.address, Port: 3001 },
        TargetHealth: { State: "healthy" },
      }));
  }
  async function serviceState() {
    const ctl = await read({ pk: "ENV", sk: "CONTROL" });
    const launched = await read({
      pk: `INTRODUCTION#${m.introductionId}`,
      sk: "ACTION#bootstrap-c4",
    });
    if (
      state.pauseWarming &&
      ctl?.deployment?.phase === "warming" &&
      launched?.phase === "observed"
    ) {
      state.pauseWarming = false;
      throw Error("known warming interruption");
    }
    return { services: [service], failures: [] };
  }
  async function ecs(operation, input) {
    switch (operation) {
      case "describe-services":
        return serviceState();
      case "describe-task-definition":
        return { taskDefinition: definitions.get(input.taskDefinition) };
      case "validate-update-service":
        return {};
      case "list-tasks":
        return {
          taskArns: state.tasks
            .filter((t) => t.desiredStatus === input.desiredStatus)
            .map((t) => t.taskArn),
        };
      case "list-services":
        return { serviceArns: [m.runtime.serviceArn] };
      case "describe-tasks":
        return {
          tasks: state.tasks.filter((t) => input.tasks.includes(t.taskArn)),
          failures: [],
        };
      case "get-task-protection":
        return {
          protectedTasks: await Promise.all(
            input.tasks.map(async (taskArn) => {
              const t = state.tasks.find((t) => t.taskArn === taskArn),
                r = await read({
                  pk: "ENV",
                  sk: `RUNTIME#${instanceId(t.slot)}`,
                });
              return {
                taskArn,
                protectionEnabled: r?.role !== "retired" && t.slot !== "legacy",
                expirationDate: new Date(
                  (state.time + 600) * 1000,
                ).toISOString(),
              };
            }),
          ),
          failures: [],
        };
      case "list-service-deployments":
        return {
          serviceDeployments: state.revisions.map((r) => ({
            serviceDeploymentArn: r.serviceRevisionArn,
          })),
        };
      case "describe-service-deployments":
        return {
          serviceDeployments: state.revisions.map((r) => ({
            targetServiceRevision: { arn: r.serviceRevisionArn },
            sourceServiceRevisions: [],
          })),
        };
      case "describe-service-revisions":
        return {
          serviceRevisions: state.revisions.filter((r) =>
            input.serviceRevisionArns.includes(r.serviceRevisionArn),
          ),
          failures: [],
        };
      default:
        throw Error(`unexpected ecs ${operation}`);
    }
  }
  function elb(operation, input) {
    switch (operation) {
      case "describe-listeners":
        return {
          Listeners: [
            {
              ListenerArn: m.resources.listenerArn,
              Protocol: "HTTPS",
              LoadBalancerArn: "alb",
              DefaultActions: actions,
            },
          ],
        };
      case "describe-rules":
        return { Rules: [{ IsDefault: true }] };
      case "describe-target-groups":
        return {
          TargetGroups: [
            m.resources.targetGroupA,
            m.resources.targetGroupB,
          ].map((TargetGroupArn) => ({
            TargetGroupArn,
            TargetType: "ip",
            Protocol: "HTTP",
            Port: 3001,
            HealthCheckPath: "/health",
            LoadBalancerArns:
              TargetGroupArn === m.resources.targetGroupB && !state.attachedB
                ? []
                : ["alb"],
            VpcId: "vpc",
          })),
        };
      case "describe-target-group-attributes":
        return { Attributes: [{ Key: "stickiness.enabled", Value: "false" }] };
      case "describe-target-health":
        return { TargetHealthDescriptions: targetHealth(input.TargetGroupArn) };
      default:
        throw Error(`unexpected elb ${operation}`);
    }
  }
  function dynamoMetadata(operation, input, query) {
    if (operation === "describe-table") {
      if (input.TableName !== m.resources.tables.meetingHistory || query)
        throw Error("unexpected history index metadata request");
      return meetingUpdateIndexMetadata(m);
    }
    return client.send(
      operation === "get-item"
        ? new GetItemCommand(input)
        : new QueryCommand(input),
    );
  }
  async function aws(serviceName, operation, input, query) {
    let response;
    if (serviceName === "dynamodb")
      return dynamoMetadata(operation, input, query);
    if (serviceName === "ecs") response = await ecs(operation, input);
    else if (serviceName === "elbv2") response = elb(operation, input);
    else if (serviceName === "ecr")
      response = {
        imageDetails: [
          {
            imageDigest:
              input.imageIds[0].imageTag === m.identity.sourceCommit
                ? m.runtime.candidateDigest
                : undefined,
          },
        ],
      };
    else return { items: [] };
    if (!query) return response;
    if (operation === "describe-services")
      return {
        items: response.services.map(
          ({ serviceArn, desiredCount, runningCount, pendingCount }) => ({
            serviceArn,
            desiredCount,
            runningCount,
            pendingCount,
          }),
        ),
        failures: [],
      };
    if (operation === "describe-tasks")
      return {
        items: response.tasks.map(
          ({
            taskArn,
            taskDefinitionArn,
            group,
            lastStatus,
            desiredStatus,
          }) => ({
            taskArn,
            taskDefinitionArn,
            group,
            lastStatus,
            desiredStatus,
          }),
        ),
        failures: [],
      };
    if (operation === "describe-target-health")
      return response.TargetHealthDescriptions.map((t) => ({
        targetId: t.Target.Id,
        state: t.TargetHealth.State,
      }));
    return response;
  }
  async function invoke(operation, input) {
    const pending = (
      await client.send(
        new QueryCommand({
          TableName: table,
          KeyConditionExpression: "pk = :pk",
          ExpressionAttributeValues: {
            ":pk": { S: `INTRODUCTION#${m.introductionId}` },
          },
          ConsistentRead: true,
        }),
      )
    ).Items.map(unmarshall).find((r) => r.phase === "submitted");
    state.writes.push(pending?.actionId ?? operation);
    state.writeTimes.push({ actionId: pending?.actionId, at: state.time });
    let response;
    if (operation === "transactWriteItems") {
      response = await write(input);
      await consumeGrants(input);
    } else if (operation === "modifyListener") {
      actions = input.DefaultActions;
      state.attachedB = true;
      response = elb("describe-listeners", {});
    } else if (operation === "updateService") {
      Object.assign(service, input);
      if (input.desiredCount === 0) {
        for (const t of state.tasks) t.lastStatus = t.desiredStatus = "STOPPED";
        service.runningCount = 0;
      } else {
        const slot = ["bootstrap", "replacement", "handoff"].find(
            (slot) =>
              candidateSlot(m, slot).definition === input.taskDefinition,
          ),
          t = task(slot, state.tasks.length + 1);
        state.tasks.push(t);
        if (slot === "replacement")
          state.replacementVisibleAt =
            state.time + state.delayReplacementLaunch;
        await registerRuntime(t);
        service.runningCount = state.tasks.filter(
          (t) => t.lastStatus === "RUNNING",
        ).length;
        state.revisions.push({
          serviceRevisionArn: `revision-${slot}`,
          taskDefinition: input.taskDefinition,
          loadBalancers: service.loadBalancers,
        });
      }
      response = { service };
    } else throw Error(`unexpected invoke ${operation}`);
    if (state.expireAfterDirectAck === pending?.actionId)
      state.time = (
        await read({ pk: "ENV", sk: "CONTROL" })
      ).coordinatorExpiresAt;
    if (state.lose === pending?.actionId)
      throw Error("ACK lost after provider committed");
    return response;
  }
  const inventory = createInventoryReader(m, aws),
    options = {
      binding,
      read,
      write,
      invoke,
      aws,
      now: () => state.time,
      nowMilliseconds: () => state.time * 1000,
      sleep: async (ms) => {
        state.time += ms / 1000;
        await refreshRuntime();
      },
      scan: async () => ({ Items: [] }),
      inventory,
      declaredRoutes: verifyDeclaredRoutes(binding),
      evidence: {
        retainedDisposition: {
          schemaVersion: 1,
          predicate: "missing-owner-or-version-v1",
          sourceCommit: m.identity.sourceCommit,
          records: [],
        },
      },
      compatibilityBinding: {
        consumerSourceCommit: m.identity.sourceCommit,
        ownershipEvidenceHash: "f".repeat(64),
        reviewedDispositionHash: "f".repeat(64),
      },
    };
  options.candidate = createCandidateInspection({
    ...options,
    definition: inventory.definition,
  });
  const inspect = options.candidate.inspect;
  options.candidate.inspect = async (slot, settings) => {
    if (slot === "replacement" && state.time < state.replacementVisibleAt)
      throw Error("candidate_waiting");
    if (state.failReady && settings?.ready)
      throw Error("known readiness failure");
    return inspect(slot, settings);
  };
  // All candidates in this local fixture use the same tested image; slots remain separately pinned.
  return { options, state, m, binding, read, service, definitions };
}
