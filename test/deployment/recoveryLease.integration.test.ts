import { createCoordinator } from "../../scripts/deployment/coordinator.cjs";
import * as builders from "../../src/services/deploymentControlTransactions";
import * as types from "../../src/types/deploymentControl";
import type {
  GetItemCommandInput,
  PutItemCommandInput,
  UpdateItemCommandInput,
} from "@aws-sdk/client-dynamodb";
import { randomUUID } from "node:crypto";
import {
  DynamoDBClient,
  CreateTableCommand,
  DeleteTableCommand,
  PutItemCommand,
  GetItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { createDynamoDeploymentControlRepository } from "../../src/repositories/deploymentControlRepository";
import { history, control, context, runtime } from "./controlFixtures";
import type { MeetingHistory } from "../../src/types/db";
const prefix = `recovery-test-${randomUUID()}-`;
const tables = {
  deploymentControl: `${prefix}Control`,
  meetingHistory: `${prefix}History`,
  activeMeeting: `${prefix}Lease`,
};
const client = new DynamoDBClient({
  endpoint: process.env.DEPLOYMENT_TEST_DYNAMODB_ENDPOINT,
  region: "local",
  credentials: { accessKeyId: "dummy", secretAccessKey: "dummy" },
});
const repository = createDynamoDeploymentControlRepository(client, tables);
const created: string[] = [];
beforeAll(async () => {
  for (const [name, keys] of [
    [tables.deploymentControl, ["pk", "sk"]],
    [tables.meetingHistory, ["guildId", "channelId_timestamp"]],
    [tables.activeMeeting, ["guildId"]],
  ] as const) {
    await client.send(
      new CreateTableCommand({
        TableName: name,
        BillingMode: "PAY_PER_REQUEST",
        KeySchema: keys.map((key, index) => ({
          AttributeName: key,
          KeyType: index === 0 ? "HASH" : "RANGE",
        })),
        AttributeDefinitions: keys.map((key) => ({
          AttributeName: key,
          AttributeType: "S",
        })),
      }),
    );
    created.push(name);
  }
});
afterAll(async () => {
  for (const table of created)
    await client.send(new DeleteTableCommand({ TableName: table }));
  client.destroy();
});
async function put(table: string, item: object) {
  await client.send(
    new PutItemCommand({
      TableName: table,
      Item: marshall(item, { removeUndefinedValues: true }),
    }),
  );
}
async function fixture() {
  const guildId = randomUUID();
  const row: MeetingHistory = {
    ...history,
    guildId,
    status: "interrupted",
    recovery: {
      disposition: "pending",
      stage: "verification",
      executionVersion: 1,
      attempt: 0,
      retry: { maxAttempts: 4, nextAttemptAt: null },
    },
  };
  await put(tables.deploymentControl, control);
  await put(tables.deploymentControl, runtime("old"));
  await put(tables.meetingHistory, row);
  return row;
}
test("atomic recovery claim has one winner, advances history and never changes original voice uncertainty", async () => {
  const row = await fixture();
  const voice = {
    pk: `VOICE#${row.guildId}`,
    sk: "STATE",
    recordType: "voice",
    protocolVersion: 1,
    guildId: row.guildId,
    meetingId: row.meetingId,
    ownerInstanceId: "old",
    attemptId: "original-voice",
    executionVersion: 1,
    sessionMode: "meeting",
    state: "uncertain",
    updatedAt: 99,
  };
  await put(tables.deploymentControl, voice);
  const claims = await Promise.all(
    ["first", "second"].map(() =>
      repository.claimRecordingRecovery({
        history: row,
        lease: undefined,
        context,
        attemptId: randomUUID(),
      }),
    ),
  );
  expect(claims.filter(Boolean)).toHaveLength(1);
  const claim = claims.find(Boolean)!;
  expect(claim.lease).toMatchObject({
    sessionMode: "recovery",
    executionVersion: 2,
  });
  expect(claim.lease).not.toHaveProperty("voiceOperationAttemptId");
  expect(await repository.getRecord(voice.pk, voice.sk)).toEqual(voice);
  expect(
    await repository.transitionMeetingHistory({
      key: {
        guildId: row.guildId,
        channelId_timestamp: row.channelId_timestamp,
      },
      expectedMeetingId: row.meetingId,
      expectedOwnerInstanceId: "old",
      expectedExecutionVersion: 1,
      expectedStatus: "interrupted",
      patch: { status: "processing" },
    }),
  ).toBe("stale");
  expect(await repository.renewRecordingRecovery(claim, 110)).toMatchObject({
    leaseExpiresAt: 140,
  });
  const updated = await repository.updateRecordingRecovery(
    claim,
    { notes: "acknowledged", processing: { notes: "generated" } },
    111,
  );
  expect(updated?.notes).toBe("acknowledged");
  claim.history = updated!;
  expect(await repository.releaseRecordingRecovery(claim, 112)).toBe(true);
  expect(await repository.getRecoveryLease(row.guildId)).toBeUndefined();
  expect(await repository.getRecord(voice.pk, voice.sk)).toEqual(voice);
});
test("newer live lease and exact observed history beat stale recovery claims", async () => {
  const row = await fixture();
  const lease = {
    guildId: row.guildId,
    meetingId: "newer",
    ownerInstanceId: "newer",
    executionVersion: 2,
    sessionMode: "meeting",
    voiceOperationAttemptId: "newer-voice",
    voiceChannelId: "channel",
    textChannelId: "text",
    isAutoRecording: false,
    createdAt: "now",
    updatedAt: "now",
    leaseExpiresAt: 150,
    expiresAt: 200,
  };
  await put(tables.activeMeeting, lease);
  expect(
    await repository.claimRecordingRecovery({
      history: row,
      lease: undefined,
      context,
      attemptId: randomUUID(),
    }),
  ).toBeUndefined();
  expect(await repository.getRecoveryLease(row.guildId)).toEqual(lease);
  const other = await fixture();
  await put(tables.meetingHistory, {
    ...other,
    completionPolicy: { decision: "cancel" },
  });
  expect(
    await repository.claimRecordingRecovery({
      history: other,
      lease: undefined,
      context,
      attemptId: randomUUID(),
    }),
  ).toBeUndefined();
});
test("cursor publication is exact observed serving Control CAS without duplicate targets", async () => {
  await fixture();
  const cursor = { guildId: "cursor", channelId_timestamp: "cursor" };
  expect(await repository.saveRecoveryCursor(context, undefined, cursor)).toBe(
    true,
  );
  expect(
    await repository.saveRecoveryCursor(context, undefined, {
      guildId: "wrong",
      channelId_timestamp: "wrong",
    }),
  ).toBe(false);
  expect(await repository.saveRecoveryCursor(context, cursor, undefined)).toBe(
    true,
  );
  const read = await client.send(
    new GetItemCommand({
      TableName: tables.deploymentControl,
      Key: marshall({ pk: "ENV", sk: "CONTROL" }),
      ConsistentRead: true,
    }),
  );
  expect(unmarshall(read.Item!)).not.toHaveProperty("recoveryScanCursor");
});

test("cursor acknowledgment lost after commit is readable and newer coordinator refuses the old writer", async () => {
  await fixture();
  const cursor = {
    guildId: "generated-cursor",
    channelId_timestamp: "generated-key",
  };
  await expect(
    (async () => {
      expect(
        await repository.saveRecoveryCursor(context, undefined, cursor),
      ).toBe(true);
      throw new Error("lost cursor ACK");
    })(),
  ).rejects.toThrow("lost cursor ACK");
  const restarted = createDynamoDeploymentControlRepository(client, tables);
  expect(await restarted.getRecord("ENV", "CONTROL")).toMatchObject({
    recoveryScanCursor: cursor,
  });
  await put(tables.deploymentControl, {
    ...control,
    coordinatorEpoch: control.coordinatorEpoch + 1,
    recoveryScanCursor: cursor,
  });
  expect(await restarted.saveRecoveryCursor(context, cursor, undefined)).toBe(
    false,
  );
});

test("coordinator renewal preserves a cursor acknowledged between its read and write", async () => {
  await fixture();
  const config = {
    cluster: "cluster",
    service: "service",
    family: "family",
    runToken: "coordinator",
    candidateId: "candidate",
    image: `repo@sha256:${"a".repeat(64)}`,
    tablePrefix: prefix,
  };
  await put(tables.deploymentControl, {
    ...control,
    deployment: {
      ...config,
      runtimeMode: "all",
      phase: "complete",
      originalGeneration: 6,
      originalMembers: [runtime("old").identity],
      outgoing: runtime("old").identity,
      previousTaskDefinition: "previous",
      updatedAt: 100,
    },
  });
  const cursor = { guildId: "acknowledged", channelId_timestamp: "next-page" };
  let raced = false;
  const coordinator = createCoordinator({
    env: {
      SECRETS_PREFIX: prefix.slice(0, -1),
      ECS_CLUSTER: config.cluster,
      ECS_SERVICE: config.service,
      ECS_TASK_FAMILY: config.family,
      DEPLOYMENT_RUN_TOKEN: config.runToken,
      DEPLOYMENT_CANDIDATE_ID: config.candidateId,
      CANDIDATE_IMAGE: config.image,
    },
    builders,
    types,
    now: () => 100,
    aws: async (service: string, operation: string, input: object) => {
      expect(service).toBe("dynamodb");
      const translated = { ...input, TableName: tables.deploymentControl };
      if (operation === "get-item")
        return client.send(
          new GetItemCommand(translated as GetItemCommandInput),
        );
      if (!raced) {
        raced = true;
        expect(
          await repository.saveRecoveryCursor(context, undefined, cursor),
        ).toBe(true);
      }
      if (operation === "put-item")
        return client.send(
          new PutItemCommand(translated as PutItemCommandInput),
        );
      if (operation === "update-item")
        return client.send(
          new UpdateItemCommand(translated as UpdateItemCommandInput),
        );
      throw new Error("Unexpected operation");
    },
  });
  expect(await coordinator.reconcile()).toEqual({ kind: "complete" });
  expect(raced).toBe(true);
  expect(await repository.getRecord("ENV", "CONTROL")).toMatchObject({
    recoveryScanCursor: cursor,
    coordinatorExpiresAt: 280,
  });
});

test("bounded Dynamo scan advances through irrelevant history pages without losing candidates", async () => {
  const row = await fixture();
  for (let batch = 0; batch < 4; batch++) {
    await Promise.all(
      Array.from({ length: 60 }, (_, index) =>
        put(tables.meetingHistory, {
          ...row,
          guildId: `irrelevant-${batch}-${index}`,
          status: "complete",
          recovery: undefined,
        }),
      ),
    );
  }
  const pages = [];
  let cursor;
  do {
    const page = await repository.discoverRecordingRecoveries(cursor);
    pages.push(page);
    cursor = page.cursor;
  } while (cursor && pages.length < 10);
  expect(cursor).toBeUndefined();
  expect(pages.length).toBeGreaterThanOrEqual(3);
  expect(pages.length).toBeLessThanOrEqual(4);
  expect(pages.flatMap((page) => page.keys)).toContainEqual({
    guildId: row.guildId,
    channelId_timestamp: row.channelId_timestamp,
  });
});

test("actual Dynamo discovery includes export receipts and never selects submitted unknown", async () => {
  for (const state of [
    "pending",
    "submitted",
    "acknowledged",
    "skipped",
  ] as const) {
    const row = await fixture();
    const recovery =
      state === "submitted" || state === "acknowledged"
        ? {
            disposition: "needs_reconciliation" as const,
            reason: "export_uncertain" as const,
          }
        : { disposition: "pending" as const };
    await put(tables.meetingHistory, {
      ...row,
      recovery: {
        ...recovery,
        stage: "export",
        attempt: state === "pending" ? 1 : 4,
        executionVersion: 1,
        retry: { maxAttempts: 4, nextAttemptAt: null },
      },
      recoveryExport: {
        state,
        checkpointRevision: 1,
        intentExecutionVersion: 1,
      },
    });
    const keys = [];
    let cursor;
    do {
      const page = await repository.discoverRecordingRecoveries(cursor);
      keys.push(...page.keys);
      cursor = page.cursor;
    } while (cursor);
    const found = keys.some((key) => key.guildId === row.guildId);
    expect(found).toBe(state !== "submitted");
  }
});
