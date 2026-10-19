/** @jest-environment node */
import { introductionFixture } from "../fixtures/productionIntroduction";
import { createMockDeploymentControlRepository } from "../../src/repositories/deploymentControlRepository";
import { controlRecordSchema } from "../../src/types/deploymentControl";
import { context, control, runtime, promotion } from "./controlFixtures";

const maintenance = { holdId: "hold", introductionId: "intro", revision: 1 };

test("a durable maintenance pointer is accepted without TTL", () => {
  expect(
    controlRecordSchema.safeParse({ ...control, maintenance }).success,
  ).toBe(true);
  expect(
    controlRecordSchema.safeParse({
      ...control,
      maintenance: { ...maintenance, expiresAt: 101 },
    }).success,
  ).toBe(false);
});

test("ordinary admission remains held after promotion and coordinator expiry", async () => {
  const repository = createMockDeploymentControlRepository();
  await repository.initializeControl({ ...control, maintenance });
  await repository.writeRuntime(runtime("old"));
  await repository.writeRuntime(runtime("new", "candidate"));
  expect(await repository.promote(promotion)).toBe("applied");
  expect(
    await repository.checkAdmission({
      ...context,
      identity: runtime("new").identity,
      instanceId: "new",
      authorizedGeneration: 8,
      now: 150,
    }),
  ).toEqual({ kind: "blocked", reason: "not_serving" });
});

test("ordinary admission without a maintenance hold is unchanged after coordinator expiry", async () => {
  const repository = createMockDeploymentControlRepository();
  await repository.initializeControl({ ...control, coordinatorExpiresAt: 99 });
  await repository.writeRuntime(runtime("old"));
  expect(await repository.checkAdmission(context)).toEqual({
    kind: "admitted",
  });
});

import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";
import {
  createDynamoDeploymentControlRepository,
  mockWorkAdmissionAllowed,
} from "../../src/repositories/deploymentControlRepository";
import {
  buildRuntimeAdmissionChecks,
  buildSessionReservationTransaction,
} from "../../src/services/deploymentControlTransactions";
import {
  parseDeploymentControlRecord,
  type DeploymentControlRecord,
  type SessionReservationInput,
} from "../../src/types/deploymentControl";
import {
  fixtureGrantSchema,
  introductionHoldSchema,
  newWorkScopeSchema,
  type FixtureGrant,
  type NewWorkScope,
} from "../../src/types/productionIntroduction";
import { history } from "./controlFixtures";
import type { ActiveMeetingLease } from "../../src/types/db";

const scope: Extract<NewWorkScope, { kind: "fixture" }> = {
  kind: "fixture",
  reference: {
    holdId: "hold",
    grantId: "grant",
    introductionId: "intro",
    revision: 1,
  },
  commandId: "command",
  meetingId: "meeting",
  guildId: "guild",
  voiceChannelId: "channel",
  textChannelId: "text",
  actorUserId: "actor",
  sessionMode: "meeting",
};
const grant: FixtureGrant = {
  pk: "FIXTURE#grant",
  sk: "AUTHORITY",
  recordType: "fixture_grant",
  protocolVersion: 1,
  grantId: "grant",
  ...maintenance,
  commandId: "command",
  meetingId: "meeting",
  guildId: "guild",
  voiceChannelId: "channel",
  textChannelId: "text",
  actorUserId: "actor",
  sessionMode: "meeting",
  state: "issued",
};
const hold = introductionFixture(maintenance);
const tables = {
  deploymentControl: "control",
  activeMeeting: "leases",
  meetingHistory: "histories",
};
function request(): SessionReservationInput {
  return {
    context,
    scope,
    lease: {
      guildId: "guild",
      meetingId: "meeting",
      ownerInstanceId: "old",
      executionVersion: 1,
      sessionMode: "meeting",
      voiceOperationAttemptId: "attempt",
      voiceChannelId: "channel",
      textChannelId: "text",
      startTriggeredByUserId: "actor",
      isAutoRecording: false,
      status: "starting",
      leaseExpiresAt: 130,
      expiresAt: 250,
      createdAt: "now",
      updatedAt: "now",
    },
    voice: {
      pk: "VOICE#guild",
      sk: "STATE",
      recordType: "voice",
      protocolVersion: 1,
      guildId: "guild",
      meetingId: "meeting",
      ownerInstanceId: "old",
      attemptId: "attempt",
      executionVersion: 1,
      sessionMode: "meeting",
      state: "joining",
      updatedAt: 100,
    },
    history,
    requestToken: "request",
  };
}
function seeded(grantRecord: FixtureGrant = grant) {
  const records = new Map<string, DeploymentControlRecord>();
  for (const row of [
    { ...control, maintenance },
    runtime("old"),
    grantRecord,
    hold,
  ])
    records.set(JSON.stringify([row.pk, row.sk]), structuredClone(row));
  const leases = new Map<string, ActiveMeetingLease>();
  return {
    records,
    leases,
    repository: createMockDeploymentControlRepository(
      records,
      new Map(),
      leases,
    ),
  };
}

test.each([0, -1, 1.5])("maintenance revision rejects %s", (revision) => {
  expect(
    controlRecordSchema.safeParse({
      ...control,
      maintenance: { ...maintenance, revision },
    }).success,
  ).toBe(false);
});
test("strict durable records reject TTL and missing release receipts", () => {
  for (const field of ["expiresAt", "ttl"]) {
    expect(
      fixtureGrantSchema.safeParse({ ...grant, [field]: 101 }).success,
    ).toBe(false);
    expect(
      introductionHoldSchema.safeParse({ ...hold, [field]: 101 }).success,
    ).toBe(false);
  }
  expect(
    introductionHoldSchema.safeParse({
      ...hold,
      admission: { state: "reopened" },
    }).success,
  ).toBe(false);
  expect(
    introductionHoldSchema.safeParse({
      ...hold,
      deployment: { state: "released" },
    }).success,
  ).toBe(false);
  expect(
    introductionHoldSchema.safeParse({
      ...hold,
      admission: { state: "reopened", receiptId: "reopen" },
      deployment: { state: "released", receiptId: "release" },
    }).success,
  ).toBe(true);
  expect(
    fixtureGrantSchema.safeParse({ ...grant, pk: "FIXTURE#wrong" }).success,
  ).toBe(false);
  expect(
    newWorkScopeSchema.safeParse({ ...scope, sessionMode: "tts_only" }).success,
  ).toBe(false);
});
test("ordinary Dynamo admission carries the durable maintenance fence", () => {
  const checks = buildRuntimeAdmissionChecks(context, tables);
  expect(checks[0].ConditionCheck?.ConditionExpression).toContain(
    "attribute_not_exists(maintenance)",
  );
});
test("fixture admission requires its exact durable grant and preserves runtime fences", async () => {
  const { repository, records } = seeded();
  expect(await repository.checkAdmission(context, scope)).toEqual({
    kind: "admitted",
  });
  records.delete(JSON.stringify([grant.pk, grant.sk]));
  expect(await repository.checkAdmission(context, scope)).toEqual({
    kind: "blocked",
    reason: "not_serving",
  });
  const checks = buildRuntimeAdmissionChecks(context, tables, scope);
  expect(checks).toHaveLength(3);
  expect(checks[1].ConditionCheck?.ConditionExpression).toContain(
    "protection.expiresAt > :now",
  );
  expect(checks[2].ConditionCheck?.Key).toEqual(
    marshall({ pk: "FIXTURE#grant", sk: "AUTHORITY" }),
  );
});
test.each([
  "commandId",
  "meetingId",
  "guildId",
  "voiceChannelId",
  "textChannelId",
  "actorUserId",
] as const)(
  "wrong grant %s is refused without a reservation",
  async (field) => {
    const { repository, leases } = seeded({ ...grant, [field]: "wrong" });
    expect(await repository.reserveSession(request())).toEqual({
      kind: "blocked",
      reason: "not_serving",
    });
    expect(leases.get("guild")).toBeUndefined();
  },
);
test.each(["holdId", "introductionId", "revision"] as const)(
  "wrong grant %s is refused",
  async (field) => {
    const mismatch =
      field === "revision"
        ? { ...grant, revision: 2 }
        : { ...grant, [field]: "wrong" };
    expect(await seeded(mismatch).repository.reserveSession(request())).toEqual(
      { kind: "blocked", reason: "not_serving" },
    );
  },
);
test.each([
  "meetingId",
  "guildId",
  "voiceChannelId",
  "textChannelId",
  "startTriggeredByUserId",
  "sessionMode",
] as const)("fixture reservation cannot change lease %s", (field) => {
  const input = request();
  const changed = {
    ...input,
    lease: {
      ...input.lease,
      [field]: field === "sessionMode" ? "tts_only" : "wrong",
    },
  };
  expect(() => buildSessionReservationTransaction(changed, tables)).toThrow();
});
test("fixture grant is consumed atomically once and retains exact original ownership", async () => {
  const { repository, records } = seeded();
  const input = request();
  const results = await Promise.all([
    repository.reserveSession(input),
    repository.reserveSession({ ...input, requestToken: "competitor" }),
  ]);
  expect(results).toEqual([
    { kind: "admitted" },
    { kind: "blocked", reason: "not_serving" },
  ]);
  expect(
    await repository.getRecord("FIXTURE#grant", "AUTHORITY"),
  ).toMatchObject({
    state: "consumed",
    ownership: {
      guildId: "guild",
      meetingId: "meeting",
      ownerInstanceId: "old",
      executionVersion: 1,
      voiceOperationAttemptId: "attempt",
      sessionMode: "meeting",
    },
  });
  expect(await repository.reserveSession(input)).toEqual({ kind: "admitted" });
  const restarted = createMockDeploymentControlRepository(new Map(records));
  expect(
    await restarted.reserveSession({ ...input, requestToken: "replay" }),
  ).toEqual({ kind: "blocked", reason: "not_serving" });
});
test("fixture transaction uses one grant action with exact binding and owner, never a duplicate item action", () => {
  const transaction = buildSessionReservationTransaction(request(), tables);
  const grantActions = transaction.TransactItems?.filter(
    (item) =>
      item.Update?.Key?.pk?.S === "FIXTURE#grant" ||
      item.ConditionCheck?.Key?.pk?.S === "FIXTURE#grant",
  );
  expect(grantActions).toHaveLength(1);
  const update = grantActions?.[0].Update;
  expect(update?.UpdateExpression).toBe(
    "SET #state = :consumed, ownership = :ownership, historyKey = :historyKey",
  );
  expect(unmarshall(update?.ExpressionAttributeValues ?? {})).toMatchObject({
    ":issued": "issued",
    ":actorUserId": "actor",
    ":commandId": "command",
    ":voiceChannelId": "channel",
    ":textChannelId": "text",
    ":ownership": {
      ownerInstanceId: "old",
      voiceOperationAttemptId: "attempt",
    },
  });
});
test("held ordinary work refuses but existing session owners retain completion authority", async () => {
  const { records, repository, leases } = seeded();
  expect(await repository.reserveSession(request())).toEqual({
    kind: "admitted",
  });
  const lease = leases.get("guild");
  expect(
    mockWorkAdmissionAllowed({ kind: "serving", context }, records, new Map()),
  ).toBe(false);
  expect(
    mockWorkAdmissionAllowed(
      {
        kind: "session",
        now: 100,
        ownership: {
          guildId: "guild",
          meetingId: "meeting",
          ownerInstanceId: "old",
          executionVersion: 1,
          voiceOperationAttemptId: "attempt",
        },
      },
      records,
      new Map(lease ? [["guild", lease]] : []),
    ),
  ).toBe(true);
});
test.each([grant, hold])(
  "grant and hold records use the existing consistent point-read and strict parse contract",
  async (record) => {
    expect(parseDeploymentControlRecord(record)).toEqual(record);
    const client = new DynamoDBClient({
      region: "local",
      credentials: { accessKeyId: "dummy", secretAccessKey: "dummy" },
    });
    const send = jest
      .spyOn(client, "send")
      .mockResolvedValue({ Item: marshall(record) });
    const repository = createDynamoDeploymentControlRepository(client, tables);
    expect(await repository.getRecord(record.pk, record.sk)).toEqual(record);
    expect(send).toHaveBeenCalledWith(expect.any(GetItemCommand));
    expect(send.mock.calls[0][0].input).toMatchObject({
      ConsistentRead: true,
      Key: marshall({ pk: record.pk, sk: record.sk }),
    });
    client.destroy();
  },
);

test("omitted new-work scope defaults to ordinary", () => {
  expect(newWorkScopeSchema.parse(undefined)).toEqual({ kind: "ordinary" });
});

test("consumption binds the original history key for exact restart recovery", async () => {
  const { repository } = seeded();
  expect(await repository.reserveSession(request())).toEqual({
    kind: "admitted",
  });
  expect(await repository.getRecord(grant.pk, grant.sk)).toMatchObject({
    state: "consumed",
    historyKey: {
      guildId: history.guildId,
      channelId_timestamp: history.channelId_timestamp,
    },
  });
});
