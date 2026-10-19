import { randomUUID } from "node:crypto";
import {
  CreateTableCommand,
  DeleteTableCommand,
  DeleteItemCommand,
  DynamoDBClient,
  PutItemCommand,
  GetItemCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { createDynamoDeploymentControlRepository } from "../../src/repositories/deploymentControlRepository";
import {
  context,
  control,
  runtime,
  promotion,
  history,
} from "./controlFixtures";

const prefix = `admission-test-${randomUUID()}-`;
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
beforeAll(async () => {
  for (const [TableName, keys] of [
    [tables.deploymentControl, ["pk", "sk"]],
    [tables.meetingHistory, ["guildId", "channelId_timestamp"]],
    [tables.activeMeeting, ["guildId"]],
  ] as const) {
    await client.send(
      new CreateTableCommand({
        TableName,
        BillingMode: "PAY_PER_REQUEST",
        KeySchema: keys.map((AttributeName, i) => ({
          AttributeName,
          KeyType: i === 0 ? "HASH" : "RANGE",
        })),
        AttributeDefinitions: keys.map((AttributeName) => ({
          AttributeName,
          AttributeType: "S",
        })),
      }),
    );
  }
});
afterAll(async () => {
  for (const TableName of Object.values(tables))
    await client.send(new DeleteTableCommand({ TableName }));
  client.destroy();
});
beforeEach(async () => {
  for (const row of [control, runtime("old"), runtime("new", "candidate")])
    await client.send(
      new PutItemCommand({
        TableName: tables.deploymentControl,
        Item: marshall(row),
      }),
    );
});
function input(mode: "meeting" | "tts_only" = "meeting") {
  const guildId = randomUUID();
  const lease = {
    guildId,
    meetingId: randomUUID(),
    ownerInstanceId: "old",
    executionVersion: 1,
    sessionMode: mode,
    voiceOperationAttemptId: randomUUID(),
    voiceChannelId: "channel",
    textChannelId: "text",
    isAutoRecording: false,
    status: "starting" as const,
    leaseExpiresAt: 130,
    expiresAt: 250,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
  const voice = {
    pk: `VOICE#${guildId}`,
    sk: "STATE" as const,
    recordType: "voice" as const,
    protocolVersion: 1 as const,
    guildId,
    meetingId: lease.meetingId,
    ownerInstanceId: "old",
    attemptId: lease.voiceOperationAttemptId,
    executionVersion: lease.executionVersion,
    sessionMode: mode,
    state: "joining" as const,
    updatedAt: 100,
  };
  return {
    context,
    lease,
    voice,
    history:
      mode === "meeting"
        ? { ...history, guildId, meetingId: lease.meetingId }
        : undefined,
    requestToken: randomUUID(),
  };
}
test.each(["manual", "context_menu", "auto_channel", "auto_all", "remote"])(
  "%s: promotion first seals old admission without partial writes",
  async () => {
    const request = input();
    expect(await repository.promote(promotion)).toBe("applied");
    expect(await repository.reserveSession(request)).toEqual({
      kind: "blocked",
      reason: "not_serving",
    });
    expect(
      await repository.getMeetingHistory({
        guildId: request.lease.guildId,
        channelId_timestamp: history.channelId_timestamp,
      }),
    ).toBeUndefined();
    expect(
      await repository.getRecord(request.voice.pk, "STATE"),
    ).toBeUndefined();
    expect(
      (
        await client.send(
          new GetItemCommand({
            TableName: tables.activeMeeting,
            Key: marshall({ guildId: request.lease.guildId }),
          }),
        )
      ).Item,
    ).toBeUndefined();
  },
);
test.each(["manual", "context_menu", "auto_channel", "auto_all", "remote"])(
  "%s: admission first survives promotion without admitting another session",
  async () => {
    const request = input();
    expect(await repository.reserveSession(request)).toEqual({
      kind: "admitted",
    });
    expect(await repository.promote(promotion)).toBe("applied");
    expect(
      await repository.getMeetingHistory({
        guildId: request.lease.guildId,
        channelId_timestamp: history.channelId_timestamp,
      }),
    ).toMatchObject({ status: "starting", executionVersion: 1 });
    const replacement = input();
    replacement.lease.guildId = request.lease.guildId;
    replacement.voice.guildId = request.lease.guildId;
    replacement.voice.pk = request.voice.pk;
    replacement.context = {
      ...context,
      instanceId: "new",
      identity: promotion.candidate,
      authorizedGeneration: 8,
    };
    replacement.lease.ownerInstanceId = "new";
    replacement.voice.ownerInstanceId = "new";
    replacement.history = {
      ...replacement.history!,
      guildId: request.lease.guildId,
      ownerInstanceId: "new",
    };
    expect((await repository.reserveSession(replacement)).kind).toBe("blocked");
  },
);
test("expiredLeaseWithLateJoinBlocksTakeover and missingTaskDoesNotSettleVoice", async () => {
  const request = input();
  request.lease.leaseExpiresAt = 99;
  expect(await repository.reserveSession(request)).toEqual({
    kind: "admitted",
  });
  await repository.promote(promotion);
  await client.send(
    new DeleteItemCommand({
      TableName: tables.deploymentControl,
      Key: marshall({ pk: "ENV", sk: "RUNTIME#old" }),
    }),
  );
  const replacement = input();
  replacement.lease.guildId = request.lease.guildId;
  replacement.voice.guildId = request.lease.guildId;
  replacement.voice.pk = request.voice.pk;
  replacement.history = {
    ...replacement.history!,
    guildId: request.lease.guildId,
    ownerInstanceId: "new",
  };
  replacement.context = {
    ...context,
    identity: promotion.candidate,
    instanceId: "new",
    authorizedGeneration: 8,
  };
  replacement.lease.ownerInstanceId = "new";
  replacement.voice.ownerInstanceId = "new";
  expect(await repository.reserveSession(replacement)).toEqual({
    kind: "blocked",
    reason: "voice_uncertain",
  });
});
test.each(["meeting", "tts_only"] as const)(
  "%s prevents the other mode from moving its voice session while another guild stays available",
  async (mode) => {
    const first = input(mode);
    expect(await repository.reserveSession(first)).toEqual({
      kind: "admitted",
    });
    const second = input(mode === "meeting" ? "tts_only" : "meeting");
    second.lease.guildId = first.lease.guildId;
    second.voice.guildId = first.lease.guildId;
    second.voice.pk = first.voice.pk;
    if (second.history) second.history.guildId = first.lease.guildId;
    expect(await repository.reserveSession(second)).toEqual({
      kind: "blocked",
      reason: "voice_uncertain",
    });
    expect(await repository.reserveSession(input())).toEqual({
      kind: "admitted",
    });
  },
);
test("ttsAndRecordingCannotMoveEachOther and TTS has no history writes", async () => {
  const request = input("tts_only");
  expect(await repository.reserveSession(request)).toEqual({
    kind: "admitted",
  });
  expect(
    await repository.getMeetingHistory({
      guildId: request.lease.guildId,
      channelId_timestamp: history.channelId_timestamp,
    }),
  ).toBeUndefined();
  const row = await client.send(
    new GetItemCommand({
      TableName: tables.activeMeeting,
      Key: marshall({ guildId: request.lease.guildId }),
    }),
  );
  expect(unmarshall(row.Item!)).toMatchObject({
    sessionMode: "tts_only",
    executionVersion: 1,
  });
});
test("stable transaction retries do not overwrite progressed history", async () => {
  const request = input();
  expect(await repository.reserveSession(request)).toEqual({
    kind: "admitted",
  });
  const key = {
    guildId: request.lease.guildId,
    channelId_timestamp: history.channelId_timestamp,
  };
  expect(
    await repository.transitionMeetingHistory({
      key,
      expectedMeetingId: request.lease.meetingId,
      expectedOwnerInstanceId: "old",
      expectedExecutionVersion: 1,
      expectedStatus: "starting",
      patch: { status: "in_progress" },
    }),
  ).toBe("applied");
  expect(await repository.reserveSession(request)).toEqual({
    kind: "admitted",
  });
  expect(await repository.getMeetingHistory(key)).toMatchObject({
    status: "in_progress",
    executionVersion: 1,
  });
});
test("suppression CAS rejects reservation atomically", async () => {
  const request = {
    ...input(),
    suppression: { channelId: "channel", expectedVersion: 2 },
  };
  await client.send(
    new PutItemCommand({
      TableName: tables.deploymentControl,
      Item: marshall({
        pk: `SUPPRESS#${request.lease.guildId}`,
        sk: "CHANNEL#channel",
        version: 3,
        suppressed: false,
      }),
    }),
  );
  expect(await repository.reserveSession(request)).toEqual({
    kind: "blocked",
    reason: "suppressed",
  });
  expect(await repository.getRecord(request.voice.pk, "STATE")).toBeUndefined();
});

test("ordinary maintenance is still held after promotion and coordinator expiry", async () => {
  await client.send(
    new PutItemCommand({
      TableName: tables.deploymentControl,
      Item: marshall({
        ...control,
        coordinatorExpiresAt: 120,
        maintenance: { holdId: "hold", introductionId: "intro", revision: 1 },
      }),
    }),
  );
  expect(await repository.promote(promotion)).toBe("applied");
  expect(
    await repository.checkAdmission({
      ...context,
      now: 150,
      identity: promotion.candidate,
      instanceId: "new",
      authorizedGeneration: 8,
    }),
  ).toEqual({ kind: "blocked", reason: "not_serving" });
});

function fixtureRequest() {
  const request = input();
  const reference = {
    holdId: "hold",
    introductionId: "intro",
    grantId: randomUUID(),
    revision: 1,
  };
  const bindings = {
    commandId: randomUUID(),
    guildId: request.lease.guildId,
    meetingId: request.lease.meetingId,
    voiceChannelId: request.lease.voiceChannelId,
    textChannelId: request.lease.textChannelId,
    actorUserId: "actor",
    sessionMode: "meeting" as const,
  };
  const scope = { kind: "fixture" as const, reference, ...bindings };
  const grant = {
    pk: `FIXTURE#${reference.grantId}`,
    sk: "AUTHORITY",
    recordType: "fixture_grant",
    protocolVersion: 1,
    ...reference,
    ...bindings,
    state: "issued",
  };
  return {
    request: {
      ...request,
      scope,
      lease: { ...request.lease, startTriggeredByUserId: "actor" },
    },
    grant,
  };
}
async function installFixture(
  grant: ReturnType<typeof fixtureRequest>["grant"],
) {
  await client.send(
    new PutItemCommand({
      TableName: tables.deploymentControl,
      Item: marshall({
        ...control,
        maintenance: { holdId: "hold", introductionId: "intro", revision: 1 },
      }),
    }),
  );
  await client.send(
    new PutItemCommand({
      TableName: tables.deploymentControl,
      Item: marshall(grant),
    }),
  );
}
test("native fixture consumption atomically binds one reservation and cannot be replayed", async () => {
  const { request, grant } = fixtureRequest();
  await installFixture(grant);
  const results = await Promise.all([
    repository.reserveSession(request),
    repository.reserveSession({
      ...request,
      requestToken: randomUUID(),
      lease: { ...request.lease, voiceOperationAttemptId: "other-attempt" },
      voice: { ...request.voice, attemptId: "other-attempt" },
    }),
  ]);
  expect(results.filter((result) => result.kind === "admitted")).toHaveLength(
    1,
  );
  expect(results.filter((result) => result.kind === "blocked")).toHaveLength(1);
  const consumed = await repository.getRecord(grant.pk, grant.sk);
  expect(consumed).toMatchObject({
    state: "consumed",
    ownership: {
      guildId: request.lease.guildId,
      meetingId: request.lease.meetingId,
      ownerInstanceId: "old",
      executionVersion: 1,
      sessionMode: "meeting",
    },
  });
  expect(
    await repository.reserveSession({ ...request, requestToken: randomUUID() }),
  ).toEqual({ kind: "blocked", reason: "not_serving" });
});
test.each([
  "actorUserId",
  "commandId",
  "meetingId",
  "voiceChannelId",
  "textChannelId",
  "introductionId",
  "holdId",
  "revision",
] as const)(
  "native fixture refuses wrong grant %s without partial reservation",
  async (field) => {
    const { request, grant } = fixtureRequest();
    await installFixture({
      ...grant,
      [field]: field === "revision" ? 2 : "wrong",
    });
    expect(await repository.reserveSession(request)).toEqual({
      kind: "blocked",
      reason: "not_serving",
    });
    const lease = await client.send(
      new GetItemCommand({
        TableName: tables.activeMeeting,
        Key: marshall({ guildId: request.lease.guildId }),
        ConsistentRead: true,
      }),
    );
    expect(lease.Item).toBeUndefined();
    expect(await repository.getRecord(grant.pk, grant.sk)).toMatchObject({
      state: "issued",
    });
  },
);
