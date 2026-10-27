import {
  buildPendingSegmentTransaction,
  buildPersonalUploadSubmissionTransaction,
  buildPersonalSegmentTransitionTransaction,
} from "../../src/services/personalUploadTransactions";
import { transactPersonalAdmission } from "../../src/services/personalAdmissionTransaction";
import { buildPausedDesktopDraftMarker } from "../../src/testSupport/personalMediaUploadFixtures";
import { randomUUID } from "node:crypto";
import {
  CreateTableCommand,
  DeleteTableCommand,
  DeleteItemCommand,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  TransactWriteItemsCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { createDynamoDeploymentControlRepository } from "../../src/repositories/deploymentControlRepository";
import { createDynamoMeetingControlCommandRepository } from "../../src/repositories/meetingControlCommandRepository";
import {
  buildPersonalClaimCheck,
  buildPersonalMediaClaimTransaction,
  buildWorkAdmissionChecks,
} from "../../src/services/deploymentControlTransactions";
import { context, control, runtime, promotion } from "./controlFixtures";
import { config } from "../../src/services/configService";
import type {
  PersonalMediaUploadJobRecord,
  PersonalRecordingSegmentRecord,
} from "../../src/types/db";
import type {
  SuppressionRecord,
  WorkAdmissionAuthority,
} from "../../src/types/deploymentControl";

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
  endpoint: process.env.DEPLOYMENT_TEST_DYNAMODB_ENDPOINT,
  region: "local",
  credentials: { accessKeyId: "dummy", secretAccessKey: "dummy" },
});
const repository = createDynamoDeploymentControlRepository(client, tables);
const commands = createDynamoMeetingControlCommandRepository(
  client,
  tables.command,
  tables,
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
beforeEach(async () => {
  for (const row of [control, runtime("old"), runtime("new", "candidate")])
    await put(tables.deploymentControl, row);
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
    context,
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
    [false, true].flatMap((held) =>
      ["absent", "valid", "malformed"].map((marker) => ({
        operation,
        held,
        marker,
      })),
    ),
  ),
)(
  "$operation with held=$held marker=$marker uses actual atomic admission",
  async ({ operation, held, marker }) => {
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
    if (held)
      await put(tables.deploymentControl, {
        ...control,
        maintenance: { holdId: "held", introductionId: "intro", revision: 1 },
      });
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
    const result = transactPersonalAdmission(
      client,
      context,
      prefix,
      transactions[operation].TransactItems!,
    );
    const applied = !held && marker === "absent";
    if (held)
      await expect(result).rejects.toThrow("Runtime is not accepting work");
    else await expect(result).resolves.toBe(applied);
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
function pausePair(job: PersonalMediaUploadJobRecord) {
  const expectedParent = { ...job, uploadOrigin: "desktop_recording" as const };
  const record = buildPausedDesktopDraftMarker(job);
  return { record, expectedParent };
}
test.each([
  "install first",
  "claim first",
  "marker conflict",
  "parent changed",
  "control changed",
])("two-draft atomic installation: %s", async (order) => {
  const pairs = [pausePair(upload()), pausePair(upload())] as const;
  for (const pair of pairs)
    await put(tables.personalMediaUpload, pair.expectedParent);
  if (order === "claim first")
    await client.send(
      new TransactWriteItemsCommand(
        buildPersonalMediaClaimTransaction(
          claimInput(pairs[0].expectedParent),
          tables,
        ),
      ),
    );
  const closed = { ...control, servingMembers: {} };
  await put(tables.deploymentControl, closed);
  if (order === "marker conflict")
    await put(tables.deploymentControl, {
      ...pairs[0].record,
      operationId: "other",
    });
  if (order === "parent changed")
    await put(tables.personalMediaUpload, {
      ...pairs[1].expectedParent,
      fileSize: 99,
    });
  if (order === "control changed")
    await put(tables.deploymentControl, { ...closed, coordinatorEpoch: 4 });
  const result = await repository.installPausedDesktopDrafts({
    control: closed,
    coordinatorToken: closed.coordinatorToken,
    coordinatorEpoch: closed.coordinatorEpoch,
    pairs,
    now: 100,
  });
  expect(result).toBe(order === "install first" ? "applied" : "stale");
  expect(
    await repository.getRecord(pairs[1].record.pk, "PAUSED_DRAFT"),
  ).toEqual(order === "install first" ? pairs[1].record : undefined);
  if (order === "install first") {
    await put(tables.deploymentControl, control);
    for (const pair of pairs) {
      await put(tables.personalMediaUpload, pair.expectedParent);
      await put(tables.personalRecordingSegment, {
        uploadId: pair.expectedParent.uploadId,
        segmentKey: "late-segment",
        status: "uploaded",
      });
      await expect(
        client.send(
          new TransactWriteItemsCommand(
            buildPersonalMediaClaimTransaction(
              claimInput(pair.expectedParent),
              tables,
            ),
          ),
        ),
      ).rejects.toMatchObject({ name: "TransactionCanceledException" });
      const expired = {
        ...claimInput(pair.expectedParent).job,
        claimExpiresAt: 99,
      };
      await put(tables.personalMediaUpload, expired);
      const takeover = {
        ...claimInput(pair.expectedParent),
        expectedAttempts: 1,
      };
      takeover.job.attempts = 2;
      await expect(
        client.send(
          new TransactWriteItemsCommand(
            buildPersonalMediaClaimTransaction(takeover, tables),
          ),
        ),
      ).rejects.toMatchObject({ name: "TransactionCanceledException" });
      expect(
        await repository.getRecord(pair.record.pk, pair.record.sk),
      ).toEqual(pair.record);
    }
    const ordinary = upload();
    await put(tables.personalMediaUpload, ordinary);
    await client.send(
      new TransactWriteItemsCommand(
        buildPersonalMediaClaimTransaction(claimInput(ordinary), tables),
      ),
    );
  }
});
test.each(["retired", "expired protection", "foreign member"])(
  "personal claim refuses %s in its transaction",
  async (reason) => {
    const job = upload();
    await put(tables.personalMediaUpload, job);
    const row = runtime("old");
    if (reason === "retired") row.role = "retired";
    if (reason === "expired protection") row.protection.expiresAt = 99;
    if (reason === "foreign member") row.identity.taskArn += "-replacement";
    await put(tables.deploymentControl, row);
    await expect(
      client.send(
        new TransactWriteItemsCommand(
          buildPersonalMediaClaimTransaction(claimInput(job), tables),
        ),
      ),
    ).rejects.toMatchObject({ name: "TransactionCanceledException" });
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
    context: { ...context, now: 161 },
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
  await repository.promote(promotion);
  return { kind: "session", ownership, now: 100 } as const;
}
test("old owner claims and renews a targeted stop after promotion, while new starts are rejected", async () => {
  const authority = await ownedSession();
  const requestId = randomUUID();
  await commands.writeCommand({
    requestId,
    queueStatus: "pending",
    commandType: "stop_meeting",
    userId: "synthetic-user",
    input: {
      serverId: authority.ownership.guildId,
      meetingId: authority.ownership.meetingId,
    },
    targetOwnerInstanceId: "old",
    createdAt: "now",
    updatedAt: "now",
    expiresAt: 200,
  });
  const input = {
    requestId,
    instanceId: "old",
    claimId: randomUUID(),
    nowEpochSeconds: 100,
    claimExpiresAt: 150,
    updatedAt: "now",
    authority,
  };
  expect(await commands.claimCommand(input)).toMatchObject({
    claimedByInstanceId: "old",
  });
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
      result: {
        status: "stopping",
        serverId: authority.ownership.guildId,
        meetingId: authority.ownership.meetingId,
      },
    }),
  ).toBe(false);
  const nextId = randomUUID();
  await commands.writeCommand(
    {
      requestId: nextId,
      queueStatus: "pending",
      commandType: "start_meeting",
      userId: "synthetic-user",
      input: {},
      createdAt: "now",
      updatedAt: "now",
      expiresAt: 200,
    },
    {
      ...context,
      instanceId: "new",
      identity: runtime("new").identity,
      authorizedGeneration: 8,
    },
  );
  expect(
    await commands.claimCommand({
      ...input,
      requestId: nextId,
      claimId: randomUUID(),
      authority: { kind: "serving", context },
    }),
  ).toBeUndefined();
});
function suppression(
  authority: Extract<WorkAdmissionAuthority, { kind: "session" }>,
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
  expect(await repository.writeSuppression({ record, authority })).toBe(
    "applied",
  );
  expect(
    await repository.writeSuppression({
      record: { ...record, version: 2, suppressed: false },
      authority,
      expectedVersion: 1,
    }),
  ).toBe("applied");
  expect(
    await repository.writeSuppression({
      record: { ...record, version: 3 },
      authority,
      expectedVersion: 2,
    }),
  ).toBe("applied");
  expect(
    await repository.writeSuppression({
      record: { ...record, version: 2, suppressed: false },
      authority,
      expectedVersion: 1,
    }),
  ).toBe("stale");
  expect(await repository.getRecord(record.pk, record.sk)).toMatchObject({
    version: 3,
    suppressed: true,
  });
});
test("released ownership rejects a late explicit stop without creating suppression", async () => {
  const authority = await ownedSession();
  const record = suppression(authority);
  await client.send(
    new DeleteItemCommand({
      TableName: tables.activeMeeting,
      Key: marshall({ guildId: record.guildId }),
    }),
  );
  expect(await repository.writeSuppression({ record, authority })).toBe(
    "stale",
  );
  expect(await repository.getRecord(record.pk, record.sk)).toBeUndefined();
});

test("suppression and lease release race produces only a committed stop or a rejected stop", async () => {
  const authority = await ownedSession();
  const record = suppression(authority);
  const [result] = await Promise.all([
    repository.writeSuppression({ record, authority }),
    client.send(
      new DeleteItemCommand({
        TableName: tables.activeMeeting,
        Key: marshall({ guildId: record.guildId }),
      }),
    ),
  ]);
  const persisted = await repository.getRecord(record.pk, record.sk);
  if (result === "applied")
    expect(persisted).toMatchObject({
      suppressed: true,
      meetingId: record.meetingId,
    });
  else {
    expect(result).toBe("stale");
    expect(persisted).toBeUndefined();
  }
});
test("warm runtime receipt transaction leaves the interaction for its exact old owner", async () => {
  const authority = await ownedSession();
  const interactionId = randomUUID();
  const receipt = {
    Put: {
      TableName: tables.receipt,
      Item: marshall({ interactionId }),
      ConditionExpression: "attribute_not_exists(interactionId)",
    },
  };
  const warm = {
    kind: "serving" as const,
    context: {
      ...context,
      instanceId: "new",
      identity: runtime("new").identity,
    },
  };
  await expect(
    client.send(
      new TransactWriteItemsCommand({
        TransactItems: [...buildWorkAdmissionChecks(warm, tables), receipt],
      }),
    ),
  ).rejects.toMatchObject({ name: "TransactionCanceledException" });
  await client.send(
    new TransactWriteItemsCommand({
      TransactItems: [...buildWorkAdmissionChecks(authority, tables), receipt],
    }),
  );
  expect(
    (
      await client.send(
        new GetItemCommand({
          TableName: tables.receipt,
          Key: marshall({ interactionId }),
        }),
      )
    ).Item,
  ).toBeDefined();
});

test("real personal transaction commit followed by lost ACK remains unknown", async () => {
  const job = { ...upload(), status: "pending_upload" as const };
  await put(tables.personalMediaUpload, job);
  const failure = new Error("synthetic lost atomic acknowledgment");
  const send = client.send.bind(client);
  const intercepted = jest
    .spyOn(client, "send")
    .mockImplementationOnce(async (command) => {
      await send(command);
      throw failure;
    });
  try {
    await expect(
      transactPersonalAdmission(
        client,
        context,
        prefix,
        buildPersonalUploadSubmissionTransaction(
          { ...job, status: "queued" },
          tables,
        ).TransactItems!,
      ),
    ).rejects.toBe(failure);
  } finally {
    intercepted.mockRestore();
  }
  const persisted = await client.send(
    new GetItemCommand({
      TableName: tables.personalMediaUpload,
      Key: marshall({ uploadId: job.uploadId }),
      ConsistentRead: true,
    }),
  );
  expect(unmarshall(persisted.Item!).status).toBe("queued");
});
