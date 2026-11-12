import { capture as captureFixture } from "../fixtures/recordingCheckpoint";
import { createHash, randomUUID } from "node:crypto";
import {
  CreateTableCommand,
  DeleteTableCommand,
  DeleteItemCommand,
  DynamoDBClient,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { marshall } from "@aws-sdk/util-dynamodb";
import { createDynamoMeetingHistoryTransitionRepository } from "../../src/repositories/meetingHistoryTransitions";
import {
  type CheckpointFlushInput,
  type RecordingCheckpointMeeting,
  createRecordingCheckpointService,
} from "../../src/services/recordingCheckpointService";
import { history } from "../fixtures/meetingHistory";

const prefix = `checkpoint-test-${randomUUID()}-`;
const tables = {
  deploymentControl: `${prefix}Control`,
  meetingHistory: `${prefix}History`,
  activeMeeting: `${prefix}Lease`,
};
const client = new DynamoDBClient({
  endpoint: process.env.TEST_DYNAMODB_ENDPOINT,
  region: "local",
  credentials: { accessKeyId: "dummy", secretAccessKey: "dummy" },
});
const repository = createDynamoMeetingHistoryTransitionRepository(
  client,
  tables,
);
const historyKey = {
  guildId: history.guildId,
  channelId_timestamp: history.channelId_timestamp,
};
const objects = new Map<string, Buffer>();
const service = createRecordingCheckpointService({
  repository,
  objects: {
    upload: async (key, body) => {
      if (!objects.has(key)) objects.set(key, Buffer.from(body));
      return key;
    },
    read: async (key) => objects.get(key),
  },
});
const capture = { ...captureFixture, captureStartedAt: null };
const input = {
  capture,
  expectedStatus: "starting" as const,
  previous: undefined,
  artifacts: [],
};
const created: string[] = [];
/** Fails the held read loudly if cancellation never reaches the SDK handler. */
const HELD_READ_WATCHDOG_MS = 1500;
const HELD_READ_DEADLINE_MS = 500;
beforeAll(async () => {
  await client.send(
    new CreateTableCommand({
      TableName: tables.meetingHistory,
      BillingMode: "PAY_PER_REQUEST",
      KeySchema: [
        { AttributeName: "guildId", KeyType: "HASH" },
        { AttributeName: "channelId_timestamp", KeyType: "RANGE" },
      ],
      AttributeDefinitions: [
        { AttributeName: "guildId", AttributeType: "S" },
        { AttributeName: "channelId_timestamp", AttributeType: "S" },
      ],
    }),
  );
  created.push(tables.meetingHistory);
  for (const [TableName, keys] of [
    [tables.activeMeeting, ["guildId"]],
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
    created.push(TableName);
  }
});
afterAll(async () => {
  for (const TableName of created)
    await client.send(new DeleteTableCommand({ TableName }));
  client.destroy();
});
beforeEach(async () => {
  objects.clear();
  await client.send(
    new PutItemCommand({
      TableName: tables.meetingHistory,
      Item: marshall(history),
    }),
  );
});
test("real repository CAS allows one initial manifest and refuses a stale revision", async () => {
  const results = await Promise.all([
    service.flush(input),
    service.flush(input),
  ]);
  expect(results.filter((r) => r.kind === "committed")).toHaveLength(1);
  expect(results.filter((r) => r.kind === "stale_owner")).toHaveLength(1);
  expect(
    (
      await repository.getMeetingHistory({
        guildId: history.guildId,
        channelId_timestamp: history.channelId_timestamp,
      })
    )?.executionVersion,
  ).toBe(1);
});
test("an interrupted row keeps its pending recovery and checkpoint", async () => {
  const result = await service.flush(input);
  if (result.kind !== "committed") throw new Error("fixture commit failed");
  expect(
    await repository.transitionMeetingHistory({
      key: {
        guildId: history.guildId,
        channelId_timestamp: history.channelId_timestamp,
      },
      expectedMeetingId: history.meetingId,
      expectedOwnerInstanceId: "old",
      expectedExecutionVersion: 1,
      expectedStatus: "starting",
      patch: {
        status: "interrupted",
        recovery: {
          disposition: "pending",
          attempt: 0,
          executionVersion: 1,
          stage: "verification",
          retry: { maxAttempts: 3, nextAttemptAt: null },
        },
      },
    }),
  ).toBe("applied");
  expect(
    (await repository.getMeetingHistory(historyKey))?.recovery?.disposition,
  ).toBe("pending");
  expect(
    (await service.read(result.checkpoint)).manifest.capture.captureStartedAt,
  ).toBeNull();
  expect(
    (await service.flush({ ...input, previous: result.checkpoint })).kind,
  ).toBe("stale_owner");
});
test("original checkpoint can be read under a new recovery owner but old owner cannot publish", async () => {
  const first = await service.flush(input);
  if (first.kind !== "committed") throw new Error("fixture commit failed");
  const row = await repository.getMeetingHistory({
    guildId: history.guildId,
    channelId_timestamp: history.channelId_timestamp,
  });
  await client.send(
    new PutItemCommand({
      TableName: tables.meetingHistory,
      Item: marshall({
        ...row,
        executionVersion: 2,
        ownerInstanceId: "recovery",
        status: "processing",
      }),
    }),
  );
  expect(
    (await service.read(first.checkpoint)).manifest.capture.executionVersion,
  ).toBe(1);
  expect(
    (
      await service.flush({
        ...input,
        expectedStatus: "processing",
        previous: first.checkpoint,
      })
    ).kind,
  ).toBe("stale_owner");
});

test("failed processing preserves complete capture and leaves legacy rows untouched", async () => {
  const result = await service.flush(input);
  if (result.kind !== "committed") throw new Error("fixture commit failed");
  const key = {
    guildId: history.guildId,
    channelId_timestamp: history.channelId_timestamp,
  };
  const captureState = {
    kind: "complete" as const,
    startedAt: "2026-01-01T00:00:02Z",
    endedAt: "2026-01-01T00:01:02Z",
  };
  expect(
    await repository.transitionMeetingHistory({
      key,
      expectedMeetingId: history.meetingId,
      expectedOwnerInstanceId: "old",
      expectedExecutionVersion: 1,
      expectedStatus: "starting",
      patch: {
        status: "failed",
        capture: captureState,
        recovery: {
          disposition: "pending",
          attempt: 0,
          executionVersion: 1,
          stage: "verification",
          retry: { maxAttempts: 3, nextAttemptAt: null },
        },
      },
    }),
  ).toBe("applied");
  const legacy = {
    ...history,
    channelId_timestamp: "legacy",
    ownerInstanceId: undefined,
    executionVersion: undefined,
    status: "in_progress",
  };
  await client.send(
    new PutItemCommand({
      TableName: tables.meetingHistory,
      Item: marshall(legacy, { removeUndefinedValues: true }),
    }),
  );
  const saved = await repository.getMeetingHistory(key);
  expect(saved?.capture).toEqual(captureState);
  expect(saved?.checkpoint).toEqual(result.checkpoint);
  expect(
    await repository.getMeetingHistory({
      ...key,
      channelId_timestamp: "legacy",
    }),
  ).toEqual({
    ...legacy,
    ownerInstanceId: undefined,
    executionVersion: undefined,
  });
});

const ownership = {
  guildId: history.guildId,
  meetingId: history.meetingId,
  ownerInstanceId: "old",
  executionVersion: 1,
  voiceOperationAttemptId: "voice",
  sessionMode: "meeting" as const,
};
/** A committed checkpoint and the next ordinary flush that adds the final context to it. */
async function nextFlushFixture(): Promise<CheckpointFlushInput> {
  const first = await service.flush(input);
  if (first.kind !== "committed") throw new Error("fixture commit failed");
  return {
    ...input,
    artifacts: [
      {
        kind: "context" as const,
        sourceId: "context",
        sequence: 0,
        contentType: "application/json",
        coverage: { kind: "unknown" as const },
        bytes: Buffer.from("{}"),
        checksumSha256: createHash("sha256").update("{}").digest("hex"),
      },
    ],
    previous: first.checkpoint,
  };
}

test.each(["abort", "deadline"] as const)(
  "a flush's history read settles on SDK %s cancellation",
  async (cancellation) => {
    const next = await nextFlushFixture();
    const controller = new AbortController();
    const handler = new NodeHttpHandler();
    const handle = handler.handle.bind(handler);
    let entered!: () => void;
    const atRead = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let readSettled = false;
    let aborted = false;
    let watchdogFired = false;
    jest
      .spyOn(handler, "handle")
      .mockImplementation(async (request, options) => {
        if (request.headers["x-amz-target"] !== "DynamoDB_20120810.GetItem")
          return handle(request, options);
        try {
          return await new Promise<never>((_resolve, reject) => {
            const signal = options?.abortSignal;
            const onAbort = () => {
              aborted = true;
              clearTimeout(watchdog);
              reject(
                Object.assign(new Error("generated read aborted"), {
                  name: "AbortError",
                }),
              );
            };
            const watchdog = setTimeout(() => {
              watchdogFired = true;
              reject(
                Object.assign(new Error("generated held read watchdog"), {
                  name: "AbortError",
                }),
              );
            }, HELD_READ_WATCHDOG_MS);
            if (signal) signal.onabort = onAbort;
            entered();
            if (signal?.aborted) onAbort();
          });
        } finally {
          readSettled = true;
        }
      });
    const heldClient = new DynamoDBClient({
      endpoint: process.env.TEST_DYNAMODB_ENDPOINT,
      region: "local",
      credentials: { accessKeyId: "dummy", secretAccessKey: "dummy" },
      requestHandler: handler,
      maxAttempts: 1,
    });
    const heldService = createRecordingCheckpointService({
      repository: createDynamoMeetingHistoryTransitionRepository(
        heldClient,
        tables,
      ),
      objects: {
        upload: async (key, body) => {
          if (!objects.has(key)) objects.set(key, Buffer.from(body));
          return key;
        },
        read: async (key) => objects.get(key),
      },
    });
    try {
      const pending = heldService.flush({
        ...next,
        signal:
          cancellation === "abort"
            ? controller.signal
            : AbortSignal.timeout(HELD_READ_DEADLINE_MS),
      });
      await atRead;
      if (cancellation === "abort") controller.abort();
      expect((await pending).kind).toBe("preservation_failed");
      expect(readSettled).toBe(true);
      expect(watchdogFired).toBe(false);
      expect(aborted).toBe(true);
      expect(
        (await repository.getMeetingHistory(historyKey))?.checkpoint,
      ).toEqual(next.previous);
    } finally {
      heldClient.destroy();
    }
  },
);

async function originalProducerFixture() {
  const lease = {
    ...ownership,
    leaseExpiresAt: Math.floor(Date.now() / 1000) + 120,
  };
  await client.send(
    new PutItemCommand({
      TableName: tables.activeMeeting,
      Item: marshall(lease),
    }),
  );
  const meeting: RecordingCheckpointMeeting = {
    meetingId: history.meetingId,
    guildId: history.guildId,
    voiceChannel: { id: history.channelId },
    ownershipSignal: new AbortController().signal,
    captureStartedAt: new Date("2026-01-01T00:00:02Z"),
    recordingCaptureState: {
      kind: "complete",
      startedAt: "2026-01-01T00:00:02.000Z",
      endedAt: "2026-01-01T00:00:03.000Z",
    },
    transcribeMeeting: true,
    generateNotes: true,
    reservation: {
      ...ownership,
      reservedAt: Date.parse(history.timestamp),
      historyKey: {
        guildId: history.guildId,
        channelId_timestamp: history.channelId_timestamp,
      },
    },
  };
  const producer = service.createProducerSession();
  expect(
    (await producer.appendArtifactsRecordingCheckpoint(meeting, [])).kind,
  ).toBe("committed");
  const bytes = Buffer.from("late completed speech");
  const text = {
    kind: "transcription" as const,
    sourceId: "text",
    sequence: 0,
    contentType: "application/json",
    coverage: { kind: "unknown" as const },
    bytes,
    checksumSha256: createHash("sha256").update(bytes).digest("hex"),
  };
  return { lease, meeting, producer, text };
}

test.each(["missing", "expired", "replaced", "mode", "attempt", "version"])(
  "ordinary late content publication rejects %s original lease atomically",
  async (kind) => {
    const f = await originalProducerFixture();
    const before = await repository.getMeetingHistory({
      guildId: history.guildId,
      channelId_timestamp: history.channelId_timestamp,
    });
    if (kind === "missing")
      await client.send(
        new DeleteItemCommand({
          TableName: tables.activeMeeting,
          Key: marshall({ guildId: history.guildId }),
        }),
      );
    else
      await client.send(
        new PutItemCommand({
          TableName: tables.activeMeeting,
          Item: marshall({
            ...f.lease,
            ...(kind === "expired"
              ? { leaseExpiresAt: Math.floor(Date.now() / 1000) - 1 }
              : {}),
            ...(kind === "replaced" ? { ownerInstanceId: "replacement" } : {}),
            ...(kind === "mode" ? { sessionMode: "tts_only" } : {}),
            ...(kind === "attempt" ? { voiceOperationAttemptId: "next" } : {}),
            ...(kind === "version" ? { executionVersion: 2 } : {}),
          }),
        }),
      );
    expect(
      (await f.producer.appendArtifactsRecordingCheckpoint(f.meeting, [f.text]))
        .kind,
    ).toBe("stale_owner");
    expect(
      await repository.getMeetingHistory({
        guildId: history.guildId,
        channelId_timestamp: history.channelId_timestamp,
      }),
    ).toEqual(before);
  },
);

test("ordinary producer transaction refuses lease replacement at actual publication barrier", async () => {
  const f = await originalProducerFixture();
  const before = f.meeting.recordingCheckpoint;
  const apply = repository.transitionMeetingHistory.bind(repository);
  const barrier = jest
    .spyOn(repository, "transitionMeetingHistory")
    .mockImplementationOnce(async (request) => {
      await client.send(
        new PutItemCommand({
          TableName: tables.activeMeeting,
          Item: marshall({
            ...f.lease,
            voiceOperationAttemptId: "barrier-replacement",
          }),
        }),
      );
      return apply(request);
    });
  try {
    expect(
      (await f.producer.appendArtifactsRecordingCheckpoint(f.meeting, [f.text]))
        .kind,
    ).toBe("stale_owner");
    expect(
      (
        await repository.getMeetingHistory({
          guildId: history.guildId,
          channelId_timestamp: history.channelId_timestamp,
        })
      )?.checkpoint,
    ).toEqual(before);
  } finally {
    barrier.mockRestore();
  }
});

test("ordinary producer can preserve late content under its original lease", async () => {
  const f = await originalProducerFixture();
  expect(
    (await f.producer.appendArtifactsRecordingCheckpoint(f.meeting, [f.text]))
      .kind,
  ).toBe("committed");
  const saved = await f.producer.read(f.meeting.recordingCheckpoint!);
  expect(saved.manifest.captureState).toEqual(f.meeting.recordingCaptureState);
  expect(saved.manifest.capture.executionVersion).toBe(1);
  expect(saved.verified).toHaveLength(1);
});
