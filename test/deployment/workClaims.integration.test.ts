import {
  buildPendingSegmentTransaction,
  buildPersonalMediaClaimTransaction,
  buildPersonalUploadSubmissionTransaction,
  buildPersonalSegmentTransitionTransaction,
} from "../../src/services/personalUploadTransactions";
import { buildPausedDesktopDraftMarker } from "../../src/testSupport/personalMediaUploadFixtures";
import { randomUUID } from "node:crypto";
import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  TransactWriteItemsCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { createDynamoDeploymentControlRepository } from "../../src/repositories/deploymentControlRepository";
import { createDynamoMeetingControlCommandRepository } from "../../src/repositories/meetingControlCommandRepository";
import { buildPersonalClaimCheck } from "../../src/services/personalUploadTransactions";
import { config } from "../../src/services/configService";
import { getRuntimeInstanceId } from "../../src/services/runtimeInstanceService";
import type {
  PersonalMediaUploadJobRecord,
  PersonalRecordingSegmentRecord,
} from "../../src/types/db";
import type { SuppressionRecord } from "../../src/types/deploymentControl";
import { expectSuppressionWriteOutcomes } from "../fixtures/suppressionWrites";

const prefix = `work-claims-${randomUUID()}-`;
const tables = {
  deploymentControl: `${prefix}DeploymentControlTable`,
  meetingHistory: `${prefix}MeetingHistoryTable`,
  activeMeeting: `${prefix}ActiveMeetingTable`,
  personalMediaUpload: `${prefix}Upload`,
  command: `${prefix}Command`,
  receipt: `${prefix}Receipt`,
  personalRecordingSegment: `${prefix}Segment`,
};
const client = new DynamoDBClient({
  endpoint: process.env.TEST_DYNAMODB_ENDPOINT,
  region: "local",
  credentials: { accessKeyId: "dummy", secretAccessKey: "dummy" },
});
const repository = createDynamoDeploymentControlRepository(client, tables);
const commands = createDynamoMeetingControlCommandRepository(
  client,
  tables.command,
);
const put = (table: string, row: object) =>
  client.send(new PutItemCommand({ TableName: table, Item: marshall(row) }));
beforeAll(async () => {
  for (const [TableName, keys] of [
    [tables.deploymentControl, ["pk", "sk"]],
    [tables.meetingHistory, ["guildId", "channelId_timestamp"]],
    [tables.activeMeeting, ["guildId"]],
    [tables.personalMediaUpload, ["uploadId"]],
    [tables.command, ["requestId"]],
    [tables.receipt, ["interactionId"]],
    [tables.personalRecordingSegment, ["uploadId", "segmentKey"]],
  ] as const) {
    await client.send(
      new CreateTableCommand({
        TableName,
        BillingMode: "PAY_PER_REQUEST",
        KeySchema: keys.map((AttributeName, index) => ({
          AttributeName,
          KeyType: index === 0 ? "HASH" : "RANGE",
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

it("loads synthetic application configuration without enabling mock repositories", () => {
  expect(config.mock.enabled).toBe(false);
  expect(config.discord.botToken).toBe("deployment-integration-dummy");
  expect(config.openai.apiKey).toBe("deployment-integration-dummy");
  expect(config.frontend.siteUrl).toBe("http://localhost");
  expect(config.server.sessionSecret).toBe("deployment-integration-dummy");
  expect(config.server.oauthEnabled).toBe(false);
  expect(config.mcp.enabled).toBe(false);
  expect(process.env.AWS_ACCESS_KEY_ID).toBe("dummy");
  expect(process.env.AWS_SECRET_ACCESS_KEY).toBe("dummy");
  expect(process.env.AWS_SESSION_TOKEN).toBeUndefined();
});

it("removes inherited optional credentials before loading real configuration", async () => {
  const keys = [
    "DISCORD_CLIENT_SECRET",
    "NOTION_CLIENT_SECRET",
    "NOTION_TOKEN_ENCRYPTION_SECRET",
    "STORAGE_ACCESS_KEY_ID",
    "STORAGE_SECRET_ACCESS_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "REDIS_URL",
    "CACHE_REDIS_URL",
  ];
  const previous = keys.map((key) => process.env[key]);
  const sentinel = randomUUID();
  try {
    for (const key of keys) process.env[key] = sentinel;
    await jest.isolateModulesAsync(async () => {
      await import("./integrationSetup");
      const { config: isolated } =
        await import("../../src/services/configService");
      expect(keys.every((key) => process.env[key] === "")).toBe(true);
      expect(
        [
          isolated.discord.clientSecret,
          isolated.notion.clientSecret,
          isolated.notion.tokenEncryptionSecret,
          isolated.storage.accessKeyId,
          isolated.storage.secretAccessKey,
          isolated.stripe.webhookSecret,
          isolated.cache.redisUrl,
        ].every((value) => value !== sentinel),
      ).toBe(true);
      expect(isolated.mock.enabled).toBe(false);
    });
  } finally {
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
  }
});

it("conditions signed segment intake on both the pending job and observed segment", async () => {
  const job = { ...upload(), status: "pending_upload" };
  await put(tables.personalMediaUpload, job);
  const segment: PersonalRecordingSegmentRecord = {
    uploadId: job.uploadId,
    ownerUserId: job.ownerUserId,
    segmentKey: "source#0",
    sourceId: "source",
    sequence: 0,
    kind: "owner_mic",
    label: "Synthetic",
    sourceS3Key: "synthetic-source",
    contentType: "audio/wav",
    fileSize: 10,
    checksumSha256: "a".repeat(64),
    durationMillis: 100,
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:00:00.100Z",
    status: "pending_upload",
    createdAt: "now",
    updatedAt: "now",
  };
  const prepare = (expected: "pending_upload" | "failed" | undefined) =>
    client.send(
      new TransactWriteItemsCommand(
        buildPendingSegmentTransaction(segment, expected, tables),
      ),
    );
  await prepare(undefined);
  await expect(prepare(undefined)).rejects.toMatchObject({
    name: "TransactionCanceledException",
  });
  await prepare("pending_upload");
  await put(tables.personalRecordingSegment, {
    ...segment,
    status: "processing",
  });
  await expect(prepare("pending_upload")).rejects.toMatchObject({
    name: "TransactionCanceledException",
  });
  await put(tables.personalRecordingSegment, segment);
  await put(tables.personalMediaUpload, {
    ...job,
    status: "processing",
    attempts: 2,
    processingClaimId: "held-claim",
  });
  await expect(prepare("pending_upload")).rejects.toMatchObject({
    name: "TransactionCanceledException",
  });
  const result = await client.send(
    new GetItemCommand({
      TableName: tables.personalMediaUpload,
      Key: marshall({ uploadId: job.uploadId }),
      ConsistentRead: true,
    }),
  );
  expect(unmarshall(result.Item!)).toMatchObject({
    status: "processing",
    attempts: 2,
    processingClaimId: "held-claim",
  });
});

function upload(): PersonalMediaUploadJobRecord {
  return {
    uploadId: randomUUID(),
    ownerUserId: "synthetic-owner",
    status: "queued",
    mediaKind: "audio",
    sourceS3Key: "synthetic-source",
    contentType: "audio/wav",
    fileSize: 10,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}
function claimInput(job: PersonalMediaUploadJobRecord) {
  const claimId = randomUUID();
  return {
    job: {
      ...job,
      status: "processing" as const,
      attempts: 1,
      processingOwnerInstanceId: "old",
      processingClaimId: claimId,
      claimExpiresAt: 160,
    },
    claimId,
    expectedAttempts: 0,
    maxAttempts: 3,
    instanceId: "old",
    nowEpochSeconds: 100,
  };
}
test("a durable pause blocks first claim after a late unconditional queued write", async () => {
  const job = upload();
  await put(tables.deploymentControl, buildPausedDesktopDraftMarker(job));
  await put(tables.personalMediaUpload, job);
  await expect(
    client.send(
      new TransactWriteItemsCommand(
        buildPersonalMediaClaimTransaction(claimInput(job), tables),
      ),
    ),
  ).rejects.toMatchObject({ name: "TransactionCanceledException" });
  const expired = { ...claimInput(job).job, claimExpiresAt: 99 };
  await put(tables.personalMediaUpload, expired);
  const takeover = { ...claimInput(job), expectedAttempts: 1 };
  takeover.job.attempts = 2;
  await expect(
    client.send(
      new TransactWriteItemsCommand(
        buildPersonalMediaClaimTransaction(takeover, tables),
      ),
    ),
  ).rejects.toMatchObject({ name: "TransactionCanceledException" });
});
test.each(
  (["submission", "prepare", "transition"] as const).flatMap((operation) =>
    ["absent", "valid", "malformed"].map((marker) => ({ operation, marker })),
  ),
)(
  "$operation with marker=$marker commits only on its own atomic conditions",
  async ({ operation, marker }) => {
    const job = { ...upload(), status: "pending_upload" as const };
    const segment: PersonalRecordingSegmentRecord = {
      uploadId: job.uploadId,
      ownerUserId: job.ownerUserId,
      segmentKey: "synthetic",
      sourceId: "synthetic",
      sequence: 0,
      kind: "owner_mic",
      label: "Synthetic",
      sourceS3Key: "source",
      contentType: "audio/wav",
      fileSize: 10,
      checksumSha256: "a".repeat(64),
      durationMillis: 100,
      startedAt: "now",
      endedAt: "later",
      status: "pending_upload",
      createdAt: "now",
      updatedAt: "now",
    };
    await put(tables.personalMediaUpload, job);
    await put(tables.personalRecordingSegment, segment);
    if (marker !== "absent")
      await put(
        tables.deploymentControl,
        marker === "valid"
          ? buildPausedDesktopDraftMarker(job)
          : {
              pk: `UPLOAD#${job.uploadId}`,
              sk: "PAUSED_DRAFT",
              recordType: "foreign",
            },
      );
    const transactions = {
      submission: buildPersonalUploadSubmissionTransaction(
        { ...job, status: "queued" },
        tables,
      ),
      prepare: buildPendingSegmentTransaction(
        segment,
        "pending_upload",
        tables,
      ),
      transition: buildPersonalSegmentTransitionTransaction(
        { ...segment, status: "uploaded" },
        "pending_upload",
        tables,
      ),
    };
    const result = client.send(
      new TransactWriteItemsCommand(transactions[operation]),
    );
    const applied = marker === "absent";
    if (applied) await expect(result).resolves.toBeDefined();
    else
      await expect(result).rejects.toMatchObject({
        name: "TransactionCanceledException",
      });
    const parentResult = await client.send(
      new GetItemCommand({
        TableName: tables.personalMediaUpload,
        Key: marshall({ uploadId: job.uploadId }),
        ConsistentRead: true,
      }),
    );
    const segmentResult = await client.send(
      new GetItemCommand({
        TableName: tables.personalRecordingSegment,
        Key: marshall({
          uploadId: job.uploadId,
          segmentKey: segment.segmentKey,
        }),
        ConsistentRead: true,
      }),
    );
    expect(unmarshall(parentResult.Item!)).toEqual(
      applied && operation === "submission"
        ? { ...job, status: "queued" }
        : job,
    );
    expect(unmarshall(segmentResult.Item!)).toEqual(
      applied && operation === "transition"
        ? { ...segment, status: "uploaded" }
        : segment,
    );
  },
);
test("old attempt cannot write after a newer claim wins, and duplicate intake cannot reset it", async () => {
  const job = upload();
  await put(tables.personalMediaUpload, job);
  const first = claimInput(job);
  await client.send(
    new TransactWriteItemsCommand(
      buildPersonalMediaClaimTransaction(first, tables),
    ),
  );
  const next = {
    ...first,
    claimId: randomUUID(),
    expectedAttempts: 1,
    nowEpochSeconds: 161,
    job: { ...first.job, attempts: 2, claimExpiresAt: 190 },
  };
  next.job.processingClaimId = next.claimId;
  await client.send(
    new TransactWriteItemsCommand(
      buildPersonalMediaClaimTransaction(next, tables),
    ),
  );
  await expect(
    client.send(
      new TransactWriteItemsCommand({
        TransactItems: [
          buildPersonalClaimCheck(
            {
              uploadId: job.uploadId,
              instanceId: "old",
              attempt: 1,
              claimId: first.claimId,
              nowEpochSeconds: 161,
            },
            tables.personalMediaUpload,
          ),
        ],
      }),
    ),
  ).rejects.toMatchObject({ name: "TransactionCanceledException" });
  await expect(
    client.send(
      new PutItemCommand({
        TableName: tables.personalMediaUpload,
        Item: marshall(job),
        ConditionExpression: "#status = :pending",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: marshall({ ":pending": "pending_upload" }),
      }),
    ),
  ).rejects.toMatchObject({ name: "ConditionalCheckFailedException" });
  const stored = await client.send(
    new GetItemCommand({
      TableName: tables.personalMediaUpload,
      Key: marshall({ uploadId: job.uploadId }),
      ConsistentRead: true,
    }),
  );
  expect(unmarshall(stored.Item!)).toMatchObject({
    attempts: 2,
    processingClaimId: next.claimId,
  });
});
async function ownedSession() {
  const ownership = {
    guildId: randomUUID(),
    meetingId: randomUUID(),
    ownerInstanceId: "old",
    executionVersion: 1,
    voiceOperationAttemptId: randomUUID(),
  };
  await put(tables.activeMeeting, { ...ownership, leaseExpiresAt: 180 });
  return { kind: "session", ownership, now: 100 } as const;
}
test("the owner claims and renews a targeted stop, and a foreign claim cannot complete it", async () => {
  const owner = getRuntimeInstanceId();
  const requestId = randomUUID();
  const serverId = randomUUID();
  const meetingId = randomUUID();
  await commands.writeCommand({
    requestId,
    queueStatus: "pending",
    commandType: "stop_meeting",
    userId: "synthetic-user",
    input: { serverId, meetingId },
    targetOwnerInstanceId: owner,
    createdAt: "now",
    updatedAt: "now",
    expiresAt: 200,
  });
  const input = {
    requestId,
    instanceId: owner,
    claimId: randomUUID(),
    nowEpochSeconds: 100,
    claimExpiresAt: 150,
    updatedAt: "now",
  };
  expect(await commands.claimCommand(input)).toMatchObject({
    claimedByInstanceId: owner,
  });
  expect(
    await commands.claimCommand({ ...input, claimId: randomUUID() }),
  ).toBeUndefined();
  expect(
    await commands.renewCommand({
      ...input,
      nowEpochSeconds: 120,
      claimExpiresAt: 170,
    }),
  ).toBe(true);
  expect(
    await commands.completeCommand({
      ...input,
      claimId: "foreign",
      nowEpochSeconds: 121,
      result: { status: "stopping", serverId, meetingId },
    }),
  ).toBe(false);
});
test("a targeted command is refused to a worker that does not own the meeting", async () => {
  const requestId = randomUUID();
  await commands.writeCommand({
    requestId,
    queueStatus: "pending",
    commandType: "stop_meeting",
    userId: "synthetic-user",
    input: { serverId: randomUUID() },
    targetOwnerInstanceId: "synthetic-other-owner",
    createdAt: "now",
    updatedAt: "now",
    expiresAt: 200,
  });
  expect(
    await commands.claimCommand({
      requestId,
      instanceId: getRuntimeInstanceId(),
      claimId: randomUUID(),
      nowEpochSeconds: 100,
      claimExpiresAt: 150,
      updatedAt: "now",
    }),
  ).toBeUndefined();
  expect(
    await commands.claimCommand({
      requestId,
      instanceId: getRuntimeInstanceId(),
      claimId: randomUUID(),
      nowEpochSeconds: 100,
      claimExpiresAt: 150,
      updatedAt: "now",
      takeOverFrom: "synthetic-other-owner",
    }),
  ).toMatchObject({ claimedByInstanceId: getRuntimeInstanceId() });
});
test("a retried enqueue is idempotent, a different command under the same request id is refused, and a start enqueues with no deployment control record", async () => {
  const requestId = randomUUID();
  const start = {
    requestId,
    queueStatus: "pending" as const,
    commandType: "start_meeting" as const,
    userId: "synthetic-user",
    input: {},
    createdAt: "now",
    updatedAt: "now",
    expiresAt: 200,
  };
  await commands.writeCommand(start);
  await commands.writeCommand(start);
  await expect(
    commands.writeCommand({ ...start, userId: "synthetic-other-user" }),
  ).rejects.toThrow();
  expect(await commands.getCommand(requestId)).toMatchObject({
    commandType: "start_meeting",
    userId: "synthetic-user",
  });
});
function suppression(
  authority: Awaited<ReturnType<typeof ownedSession>>,
): SuppressionRecord {
  const { guildId, meetingId } = authority.ownership;
  return {
    pk: `SUPPRESS#${guildId}`,
    sk: "CHANNEL#channel",
    recordType: "suppression",
    protocolVersion: 1,
    guildId,
    channelId: "channel",
    meetingId,
    createdAt: 100,
    version: 1,
    suppressed: true,
    reason: "explicit_end",
  };
}
test("late stop persists before lease release and stale clear cannot erase a newer stop", async () => {
  const authority = await ownedSession();
  const record = suppression(authority);
  const clear = {
    record: { ...record, version: 2, suppressed: false },
    expectedVersion: 1,
  };
  await expectSuppressionWriteOutcomes(repository, [
    [{ record }, "applied"],
    [clear, "applied"],
    [{ record: { ...record, version: 3 }, expectedVersion: 2 }, "applied"],
    [clear, "stale"],
  ]);
  expect(await repository.getRecord(record.pk, record.sk)).toMatchObject({
    version: 3,
    suppressed: true,
  });
});
