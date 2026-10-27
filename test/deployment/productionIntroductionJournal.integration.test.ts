import { runtime } from "./controlFixtures";
import { createLocalControlTable } from "./fixtures/localControlTable";
import { controlRecordSchema } from "../../src/types/deploymentControl";
import { assertMutationAllowed } from "../../scripts/deployment/introduction-hold.cjs";
import { randomUUID } from "node:crypto";
import {
  DynamoDBClient,
  DeleteTableCommand,
  GetItemCommand,
  TransactWriteItemsCommand,
  PutItemCommand,
  DeleteItemCommand,
  type TransactWriteItemsCommandInput,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import * as builders from "../../src/services/productionIntroductionTransactions";
import { createIntroductionHold } from "../../scripts/deployment/introduction-hold.cjs";
import { createIntroductionJournal } from "../../scripts/deployment/introduction-transitions.cjs";
import { bound, fixture } from "../fixtures/productionManifest.js";
import { authorityFor } from "../../scripts/deployment/introduction-hold.cjs";
import { pausedInitializationSchema } from "../../src/services/productionPausedInitialization";
import { pausedInitializationFixture } from "../fixtures/productionPausedInitialization";
import { createIntroductionTable } from "./fixtures/introductionStore";
const table = "introduction-" + randomUUID();
const client = new DynamoDBClient({
  endpoint: process.env.DEPLOYMENT_TEST_DYNAMODB_ENDPOINT,
  region: "local",
  credentials: { accessKeyId: "dummy", secretAccessKey: "dummy" },
  maxAttempts: 1,
});
const read = async (key: object) => {
  const r = await client.send(
    new GetItemCommand({
      TableName: table,
      Key: marshall(key),
      ConsistentRead: true,
    }),
  );
  return r.Item ? unmarshall(r.Item) : undefined;
};
const write = (input: TransactWriteItemsCommandInput) =>
  client.send(new TransactWriteItemsCommand(input));
let binding: ReturnType<typeof bound>;
let hold: import("../../src/types/productionIntroduction").IntroductionHold;
let authority: builders.IntroductionAuthority;
beforeAll(async () => {
  await createLocalControlTable(client, table);
});
afterAll(async () => {
  await client.send(new DeleteTableCommand({ TableName: table }));
  client.destroy();
});
test("acquires one durable hold before CONTROL exists and refuses reacquisition", async () => {
  const manifest = fixture();
  manifest.resources.tables.deploymentControl = table;
  for (const actionId of [
    "ambiguous",
    "ack_retry",
    "invalid_response",
    "dispatch_expired",
    "late_ack",
  ])
    manifest.actions.push({
      actionId,
      kind: "route_maintenance",
      predecessor: "stop",
      targetGroup: "b",
    });
  binding = bound(manifest);
  const api = createIntroductionHold({
    builders,
    table,
    read,
    write,
    now: () => 150,
  });
  ({ hold, authority } = await api.acquire(binding));
  expect(await api.readState(binding)).toEqual({ hold, authority });
  expect(await read({ pk: "ENV", sk: "CONTROL" })).toBeUndefined();
  expect(await read({ pk: "ENV", sk: "INTRODUCTION" })).toMatchObject({
    admission: { state: "held" },
    deployment: { state: "held" },
    revision: 1,
  });
  await expect(api.acquire(binding)).rejects.toThrow();
  expect(
    (await read({ pk: "ENV", sk: "INTRODUCTION" }))?.expiresAt,
  ).toBeUndefined();
});

test("original initialization atomically pauses two projected drafts and preserves their full rows", async () => {
  const controlTable = "paused-control-" + randomUUID(),
    jobTable = "paused-jobs-" + randomUUID(),
    segmentTable = "paused-segments-" + randomUUID();
  const put = (TableName: string, item: object) =>
    client.send(new PutItemCommand({ TableName, Item: marshall(item) }));
  const get = async (TableName: string, key: object) => {
    const result = await client.send(
      new GetItemCommand({
        TableName,
        Key: marshall(key),
        ConsistentRead: true,
      }),
    );
    return result.Item ? unmarshall(result.Item) : undefined;
  };
  await createIntroductionTable(controlTable);
  await createIntroductionTable(jobTable, ["uploadId"]);
  await createIntroductionTable(segmentTable, ["uploadId", "segmentKey"]);
  const b = bound(),
    a = builders.introductionAuthoritySchema.parse(authorityFor(b));
  const h = builders.introductionHoldSchema.parse({
    pk: "ENV",
    sk: "INTRODUCTION",
    recordType: "production_introduction",
    protocolVersion: 1,
    holdId: a.holdId,
    introductionId: a.introductionId,
    manifestHash: a.manifestHash,
    revision: 1,
    admission: { state: "held" },
    deployment: { state: "held" },
  });
  const initial = controlRecordSchema.parse({
    pk: "ENV",
    sk: "CONTROL",
    recordType: "control",
    protocolVersion: 1,
    runtimeEnvironment: "ecs",
    coordinatorToken: a.runToken,
    coordinatorEpoch: 1,
    coordinatorExpiresAt: 190,
    servingGeneration: 0,
    servingMembers: {},
    maintenance: {
      holdId: h.holdId,
      introductionId: h.introductionId,
      revision: 1,
    },
  });
  const lineage = ["stop", "route"].map((actionId) =>
    builders.introductionActionSchema.parse({
      pk: a.pk,
      sk: `ACTION#${actionId}`,
      recordType: "introduction_action",
      holdId: a.holdId,
      introductionId: a.introductionId,
      manifestHash: a.manifestHash,
      operationId: a.operationId,
      revision: a.revision,
      actor: a.actor,
      runToken: a.runToken,
      actionId,
      kind: a.actions[actionId].kind,
      intentHash: a.actions[actionId].intentHash,
      requestHash: "a".repeat(64),
      predecessor: null,
      reservedAt: 140,
      attemptId: randomUUID(),
      submittedAt: 141,
      acknowledgment: {
        resourceIds: ["synthetic"],
        evidenceHash: "b".repeat(64),
      },
      acknowledgedAt: 142,
      observation: {
        resourceIds: ["synthetic"],
        evidenceHash: "c".repeat(64),
      },
      observedAt: 143,
      phase: "observed",
      version: 4,
    }),
  );
  const paused = pausedInitializationSchema.parse(
    pausedInitializationFixture(a, true),
  );
  const { parents, segments } = paused;
  const fullParents = parents.map((parent) => ({
    ...parent,
    title: "PRIVATE TITLE",
    tags: ["PRIVATE TAG"],
    sourceManifest: parent.sourceManifest.map((source) => ({
      ...source,
      label: "PRIVATE LABEL",
      originalFileName: "PRIVATE FILE",
    })),
  }));
  const fullSegments = segments.map((segment) => ({
    ...segment,
    label: "PRIVATE SEGMENT",
  }));
  await put(controlTable, h);
  await put(controlTable, a);
  for (const row of lineage) await put(controlTable, row);
  for (const row of fullParents) await put(jobTable, row);
  for (const row of fullSegments) await put(segmentTable, row);
  const transaction = builders.buildInitializeIntroductionControl({
    hold: h,
    authority: a,
    control: initial,
    lineage,
    paused,
    tables: {
      deploymentControl: controlTable,
      personalJob: jobTable,
      personalSegment: segmentTable,
    },
  });
  for (const change of [
    { ownerUserId: "other" },
    { status: "queued" },
    { segmentCount: 2 },
    { sourceManifest: [{ sourceId: "changed", kind: "owner_mic" }] },
  ]) {
    await put(jobTable, { ...fullParents[0], ...change });
    await expect(write(transaction)).rejects.toThrow();
    expect(
      await get(controlTable, { pk: "ENV", sk: "CONTROL" }),
    ).toBeUndefined();
    expect(
      await get(controlTable, { pk: "UPLOAD#one", sk: "PAUSED_DRAFT" }),
    ).toBeUndefined();
    await put(jobTable, fullParents[0]);
  }
  await put(segmentTable, { ...fullSegments[0], fileSize: 11 });
  await expect(write(transaction)).rejects.toThrow();
  await put(segmentTable, fullSegments[0]);
  await put(controlTable, paused.markers[0]);
  await expect(write(transaction)).rejects.toThrow();
  expect(await get(controlTable, { pk: "ENV", sk: "CONTROL" })).toBeUndefined();
  await client.send(
    new DeleteItemCommand({
      TableName: controlTable,
      Key: marshall({ pk: "UPLOAD#one", sk: "PAUSED_DRAFT" }),
    }),
  );
  await write(transaction);
  for (let index = 0; index < parents.length; index++) {
    expect(await get(jobTable, { uploadId: parents[index].uploadId })).toEqual(
      fullParents[index],
    );
    expect(
      await get(segmentTable, {
        uploadId: segments[index].uploadId,
        segmentKey: segments[index].segmentKey,
      }),
    ).toEqual(fullSegments[index]);
    expect(
      await get(controlTable, {
        pk: paused.markers[index].pk,
        sk: "PAUSED_DRAFT",
      }),
    ).toEqual(paused.markers[index]);
  }
  expect(
    await get(controlTable, { pk: a.pk, sk: "INITIALIZATION" }),
  ).toMatchObject({
    paused: {
      cohortSha256: paused.cohortSha256,
      captureSha256: paused.captureSha256,
      policyScopeSha256: paused.policyScopeSha256,
    },
  });
});
test("concurrent callers and restarted journals invoke one actual mutation only", async () => {
  let calls = 0;
  const invoke = async () => {
    calls++;
    return {
      task: {
        taskArn: binding.manifest.runtime.legacyTaskArns[0],
        desiredStatus: "STOPPED",
      },
    };
  };
  const options = {
    builders,
    binding,
    hold,
    authority,
    table,
    read,
    write,
    now: () => 150,
    invoke,
  };
  const a = createIntroductionJournal(options),
    b = createIntroductionJournal(options);
  await a.reserveAction("stop");
  const results = await Promise.allSettled([
    a.submitOnce("stop"),
    b.submitOnce("stop"),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(calls).toBe(1);
  await expect(
    createIntroductionJournal(options).submitOnce("stop"),
  ).rejects.toThrow();
  expect((await a.readAction("stop")).phase).toBe("acknowledged");
  await expect(
    a.observe("stop", {
      taskArn: binding.manifest.runtime.legacyTaskArns[0],
      lastStatus: "RUNNING",
    }),
  ).rejects.toThrow();
  await a.observe("stop", {
    taskArn: binding.manifest.runtime.legacyTaskArns[0],
    lastStatus: "STOPPED",
  });
  expect((await a.readAction("stop")).phase).toBe("observed");
});
test("unknown provider outcome stays submitted despite matching readback after restart", async () => {
  const options = {
    builders,
    binding,
    hold,
    authority,
    table,
    read,
    write,
    now: () => 150,
    invoke: async () => {
      throw new Error("private provider error");
    },
  };
  const journal = createIntroductionJournal(options);
  await journal.reserveAction("route");
  await expect(journal.submitOnce("route")).rejects.toThrow(
    "introduction_refused",
  );
  expect((await journal.readAction("route")).phase).toBe("submitted");
  const restarted = createIntroductionJournal(options);
  await expect(restarted.acknowledge("route")).rejects.toThrow();
  await expect(
    restarted.observe("route", {
      listenerArn: binding.manifest.resources.listenerArn,
      targetGroupArn: binding.manifest.resources.targetGroupB,
    }),
  ).rejects.toThrow();
  await expect(restarted.submitOnce("route")).rejects.toThrow();
  expect((await read({ pk: "ENV", sk: "INTRODUCTION" }))?.revision).toBe(1);
});

test("initialization refuses unacknowledged routing and fixture authority requires released bootstrap lineage", async () => {
  const control = controlRecordSchema.parse({
    pk: "ENV",
    sk: "CONTROL",
    recordType: "control",
    runtimeEnvironment: "ecs",
    protocolVersion: 1,
    coordinatorToken: "bootstrap-run",
    coordinatorEpoch: 1,
    coordinatorExpiresAt: 190,
    servingGeneration: 0,
    servingMembers: {},
    maintenance: { holdId: "hold", introductionId: "intro", revision: 1 },
  });
  const stop = builders.introductionActionSchema.parse(
    await read({ pk: "INTRODUCTION#intro", sk: "ACTION#stop" }),
  );
  const route = builders.introductionActionSchema.parse(
    await read({ pk: "INTRODUCTION#intro", sk: "ACTION#route" }),
  );
  expect(() =>
    builders.buildInitializeIntroductionControl({
      hold,
      authority,
      control,
      lineage: [stop, route],
      tables: { deploymentControl: table },
    }),
  ).toThrow();
  const routeObserved = builders.introductionActionSchema.parse({
    ...route,
    phase: "observed",
    version: 4,
    acknowledgedAt: 150,
    observedAt: 150,
    acknowledgment: {
      resourceIds: ["listener", "group"],
      evidenceHash: "a".repeat(64),
    },
    observation: {
      resourceIds: ["listener", "group"],
      evidenceHash: "b".repeat(64),
    },
  });
  await client.send(
    new PutItemCommand({
      TableName: table,
      Item: marshall(routeObserved),
    }),
  );
  await write(
    builders.buildInitializeIntroductionControl({
      hold,
      authority,
      control,
      lineage: [stop, routeObserved],
      tables: { deploymentControl: table },
    }),
  );
  expect((await read({ pk: "ENV", sk: "CONTROL" }))?.maintenance).toEqual(
    control.maintenance,
  );
  expect((await read({ pk: "ENV", sk: "CONTROL" }))?.servingGeneration).toBe(0);
  const expectedControl = controlRecordSchema.parse({
    ...control,
    coordinatorExpiresAt: 0,
    servingGeneration: 1,
    servingMembers: {
      serving: {
        kind: "ecs",
        instanceId: "serving",
        protocolVersion: 1,
        taskArn:
          binding.manifest.runtime.clusterArn.replace(":cluster/", ":task/") +
          "/new",
        imageDigest: binding.manifest.runtime.candidateDigest,
        candidateId: "candidate",
      },
    },
  });
  const operation = builders.fixtureCoordinatorAuthoritySchema.parse({
    pk: "INTRODUCTION#intro",
    sk: "FIXTURE_COORDINATOR",
    recordType: "fixture_coordinator_authority",
    holdId: "hold",
    introductionId: "intro",
    manifestHash: binding.manifestHash,
    revision: 1,
    runToken: "fixture-run",
    priorRunToken: "bootstrap-run",
    priorEpoch: 1,
    priorGeneration: 1,
    priorMember: expectedControl.servingMembers.serving,
    candidateId: "replacement",
    taskDefinition: binding.manifest.runtime.continuationDefinition,
    imageDigest: binding.manifest.runtime.continuationDigest,
  });
  expect(() =>
    builders.buildAuthorizeFixtureCoordinator({
      hold,
      authority,
      expectedControl: { ...expectedControl, coordinatorExpiresAt: 190 },
      operation,
      tables: { deploymentControl: table },
    }),
  ).toThrow();
  const identity = expectedControl.servingMembers.serving;
  const candidate = runtime("serving", "candidate");
  candidate.identity = identity;
  candidate.authorizedGeneration = 0;
  candidate.readiness = {
    ...candidate.readiness!,
    identity,
    observedEpoch: 1,
    observedGeneration: 0,
  };
  candidate.protection = { ...candidate.protection!, identity };
  await client.send(
    new PutItemCommand({ TableName: table, Item: marshall(candidate) }),
  );
  await client.send(
    new PutItemCommand({
      TableName: table,
      Item: marshall({ ...hold, fixtureGrantIds: ["g1"] }),
    }),
  );
  await write(
    builders.buildIntroductionPromotion({
      hold,
      authority,
      promotion: {
        candidate: identity,
        candidateRuntimeMode: "all",
        coordinatorToken: "bootstrap-run",
        coordinatorEpoch: 1,
        expectedServingGeneration: 0,
        expectedServingMembers: [],
        proposedGeneration: 1,
        now: 150,
      },
      tables: { deploymentControl: table, meetingHistory: "unused" },
    }),
  );
  expect(await read({ pk: "ENV", sk: "CONTROL" })).toEqual(expectedControl);
  expect(
    (await read({ pk: "ENV", sk: "INTRODUCTION" }))?.fixtureGrantIds,
  ).toEqual(["g1"]);
  await write(
    builders.buildAuthorizeFixtureCoordinator({
      hold,
      authority,
      expectedControl,
      operation,
      tables: { deploymentControl: table },
    }),
  );
  await expect(
    write(
      builders.buildAuthorizeFixtureCoordinator({
        hold,
        authority,
        expectedControl,
        operation,
        tables: { deploymentControl: table },
      }),
    ),
  ).rejects.toThrow();
  expect(() =>
    assertMutationAllowed({
      builders,
      hold,
      operationAuthority: operation,
      requestedAction: { kind: "fixture_coordinator", runToken: "wrong" },
      currentControl: expectedControl,
    }),
  ).toThrow();
  expect(() =>
    assertMutationAllowed({
      builders,
      hold,
      operationAuthority: operation,
      requestedAction: {
        kind: "fixture_coordinator",
        runToken: "fixture-run",
        candidateId: "replacement",
        taskDefinition: operation.taskDefinition,
        imageDigest: operation.imageDigest,
      },
      currentControl: expectedControl,
    }),
  ).not.toThrow();
  for (const kind of ["deploy", "apply", "publish_prompts"])
    expect(() =>
      assertMutationAllowed({
        builders,
        hold,
        requestedAction: { kind },
        currentControl: expectedControl,
      }),
    ).toThrow();
});

test("ambiguous submission persistence never dispatches, including a matching durable submitted read", async () => {
  let calls = 0;
  const options = {
    builders,
    binding,
    hold,
    authority,
    table,
    read,
    now: () => 150,
    invoke: async () => {
      calls++;
      return {};
    },
    write: async (input: TransactWriteItemsCommandInput) => {
      await write(input);
      if (
        input.TransactItems?.some(
          (item) => item.Put?.Item.phase?.S === "submitted",
        )
      )
        throw new Error("response lost");
    },
  };
  const journal = createIntroductionJournal(options);
  await journal.reserveAction("ambiguous");
  await expect(journal.submitOnce("ambiguous")).rejects.toThrow();
  expect(calls).toBe(0);
  expect((await journal.readAction("ambiguous")).phase).toBe("submitted");
  await expect(
    createIntroductionJournal({ ...options, write }).submitOnce("ambiguous"),
  ).rejects.toThrow();
  expect(calls).toBe(0);
});
test("only the original retained response can retry or reconcile acknowledgment persistence", async () => {
  let calls = 0,
    fail = true;
  const response = {
    Listeners: [
      {
        ListenerArn: binding.manifest.resources.listenerArn,
        DefaultActions: [
          {
            Type: "forward",
            TargetGroupArn: binding.manifest.resources.targetGroupB,
          },
        ],
      },
    ],
  };
  const options = {
    builders,
    binding,
    hold,
    authority,
    table,
    read,
    now: () => 150,
    invoke: async () => {
      calls++;
      return response;
    },
    write: async (input: TransactWriteItemsCommandInput) => {
      if (
        fail &&
        input.TransactItems?.some(
          (item) => item.Put?.Item.phase?.S === "acknowledged",
        )
      )
        throw new Error("write unavailable");
      return write(input);
    },
  };
  const journal = createIntroductionJournal(options);
  await journal.reserveAction("ack_retry");
  await expect(journal.submitOnce("ack_retry")).rejects.toThrow();
  expect((await journal.readAction("ack_retry")).phase).toBe("submitted");
  await expect(
    createIntroductionJournal(options).acknowledge("ack_retry"),
  ).rejects.toThrow();
  fail = false;
  await journal.acknowledge("ack_retry");
  expect(calls).toBe(1);
  expect((await journal.readAction("ack_retry")).phase).toBe("acknowledged");
});
test("provider zero-success equivalent without exact identity leaves outcome unresolved", async () => {
  let calls = 0;
  const journal = createIntroductionJournal({
    builders,
    binding,
    hold,
    authority,
    table,
    read,
    write,
    now: () => 150,
    invoke: async () => {
      calls++;
      return {};
    },
  });
  await journal.reserveAction("invalid_response");
  await expect(journal.submitOnce("invalid_response")).rejects.toThrow();
  expect((await journal.readAction("invalid_response")).phase).toBe(
    "submitted",
  );
  expect(calls).toBe(1);
});

test("authority expiring while submitted persistence awaits prevents actual provider dispatch", async () => {
  let time = 150,
    calls = 0;
  const options = {
    builders,
    binding,
    hold,
    authority,
    table,
    read,
    now: () => time,
    write: async (input: TransactWriteItemsCommandInput) => {
      const response = await write(input);
      if (
        input.TransactItems?.some(
          (item) => item.Put?.Item.phase?.S === "submitted",
        )
      )
        time = binding.manifest.validUntil;
      return response;
    },
    invoke: async () => {
      calls++;
      return {
        Listeners: [
          {
            ListenerArn: binding.manifest.resources.listenerArn,
            DefaultActions: [
              {
                Type: "forward",
                TargetGroupArn: binding.manifest.resources.targetGroupB,
              },
            ],
          },
        ],
      };
    },
  };
  const journal = createIntroductionJournal(options);
  await journal.reserveAction("dispatch_expired");
  await expect(journal.submitOnce("dispatch_expired")).rejects.toThrow();
  expect(calls).toBe(0);
  expect((await journal.readAction("dispatch_expired")).phase).toBe(
    "submitted",
  );
  await expect(
    createIntroductionJournal({ ...options, now: () => 150, write }).submitOnce(
      "dispatch_expired",
    ),
  ).rejects.toThrow();
  expect(calls).toBe(0);
});
test("late direct acknowledgment and read-only observation persist after authority expiry without replay", async () => {
  let time = 150,
    calls = 0;
  const journal = createIntroductionJournal({
    builders,
    binding,
    hold,
    authority,
    table,
    read,
    write,
    now: () => time,
    invoke: async () => {
      calls++;
      time = binding.manifest.validUntil;
      return {
        Listeners: [
          {
            ListenerArn: binding.manifest.resources.listenerArn,
            DefaultActions: [
              {
                Type: "forward",
                TargetGroupArn: binding.manifest.resources.targetGroupB,
              },
            ],
          },
        ],
      };
    },
  });
  await journal.reserveAction("late_ack");
  await journal.submitOnce("late_ack");
  expect((await journal.readAction("late_ack")).phase).toBe("acknowledged");
  await journal.observe("late_ack", {
    listenerArn: binding.manifest.resources.listenerArn,
    targetGroupArn: binding.manifest.resources.targetGroupB,
  });
  expect((await journal.readAction("late_ack")).phase).toBe("observed");
  expect(calls).toBe(1);
});
