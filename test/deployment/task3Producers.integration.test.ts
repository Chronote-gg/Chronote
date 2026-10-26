import { randomUUID } from "node:crypto";
import {
  DynamoDBClient,
  DescribeTableCommand,
  CreateTableCommand,
  DeleteTableCommand,
  PutItemCommand,
  GetItemCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { context, control, runtime } from "./controlFixtures";
import * as db from "../../src/db";
import { createDynamoDeploymentControlRepository } from "../../src/repositories/deploymentControlRepository";
import { runRuntimeApiOperation } from "../../src/services/runtimeApiOperationService";
import type {
  PersonalMediaUploadJobRecord,
  PersonalRecordingSegmentRecord,
} from "../../src/types/db";
jest.mock("../../src/services/runtimeLifecycleService", () => ({
  beginRuntimeWork: () => ({ settle: jest.fn(), transition: jest.fn() }),
  getRuntimeAdmissionContext: async () => context,
}));
const prefix = `task3-producer-${randomUUID()}-`;
const names = [
  "DeploymentControlTable",
  "MeetingHistoryTable",
  "ActiveMeetingTable",
  "PersonalMediaUploadJobTable",
  "PersonalRecordingSegmentTable",
];
const tables = {
  deploymentControl: prefix + names[0],
  meetingHistory: prefix + names[1],
  activeMeeting: prefix + names[2],
};
const client = new DynamoDBClient({
  endpoint: process.env.DEPLOYMENT_TEST_DYNAMODB_ENDPOINT,
  region: "local",
  credentials: { accessKeyId: "dummy", secretAccessKey: "dummy" },
});
const repository = createDynamoDeploymentControlRepository(client, tables);
const put = (name: string, item: object) =>
  client.send(
    new PutItemCommand({
      TableName: prefix + name,
      Item: marshall(item, { removeUndefinedValues: true }),
    }),
  );
const read = async (name: string, key: object) => {
  const result = await client.send(
    new GetItemCommand({
      TableName: prefix + name,
      Key: marshall(key),
      ConsistentRead: true,
    }),
  );
  return result.Item ? unmarshall(result.Item) : undefined;
};
const hold = { holdId: "held", introductionId: "intro", revision: 1 };
beforeAll(async () => {
  const keys = [
    ["pk", "sk"],
    ["guildId", "channelId_timestamp"],
    ["guildId"],
    ["uploadId"],
    ["uploadId", "segmentKey"],
  ];
  for (let i = 0; i < names.length; i++)
    await client.send(
      new CreateTableCommand({
        TableName: prefix + names[i],
        BillingMode: "PAY_PER_REQUEST",
        KeySchema: keys[i].map((AttributeName, index) => ({
          AttributeName,
          KeyType: index === 0 ? "HASH" : "RANGE",
        })),
        AttributeDefinitions: keys[i].map((AttributeName) => ({
          AttributeName,
          AttributeType: "S",
        })),
      }),
    );
});
afterAll(async () => {
  for (const name of names)
    await client.send(new DeleteTableCommand({ TableName: prefix + name }));
  client.destroy();
});
beforeEach(async () => {
  await put(names[0], control);
  await put(names[0], runtime("old"));
});
afterEach(() => jest.restoreAllMocks());
function routeDbToNativeTables() {
  const send = DynamoDBClient.prototype.send;
  function remap(input: object) {
    for (const [key, value] of Object.entries(input)) {
      if (key === "TableName" && typeof value === "string") {
        const name = names.find((name) => value.endsWith(name));
        if (!name) throw new Error("Unexpected table");
        Reflect.set(input, key, prefix + name);
      } else if (value && typeof value === "object") remap(value);
    }
  }
  jest
    .spyOn(DynamoDBClient.prototype, "send")
    .mockImplementation(function (command) {
      remap(command.input);
      return Reflect.apply(send, client, [command]);
    });
  jest.spyOn(db, "getDeploymentControlRepository").mockReturnValue(repository);
}
function job(): PersonalMediaUploadJobRecord {
  return {
    uploadId: randomUUID(),
    ownerUserId: "synthetic-owner",
    status: "pending_upload",
    mediaKind: "audio",
    sourceS3Key: "late-signed-object",
    contentType: "audio/wav",
    fileSize: 100,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}
function segment(
  upload: PersonalMediaUploadJobRecord,
): PersonalRecordingSegmentRecord {
  return {
    uploadId: upload.uploadId,
    ownerUserId: upload.ownerUserId,
    segmentKey: "source#0",
    sourceId: "source",
    sequence: 0,
    kind: "owner_mic",
    label: "Synthetic",
    sourceS3Key: "late-signed-segment",
    contentType: "audio/wav",
    fileSize: 100,
    checksumSha256: "a".repeat(64),
    durationMillis: 100,
    startedAt: upload.createdAt,
    endedAt: upload.createdAt,
    status: "pending_upload",
    createdAt: upload.createdAt,
    updatedAt: upload.updatedAt,
  };
}
test("real personal producer transactions preserve late bytes and partial submission across closure", async () => {
  routeDbToNativeTables();
  const upload = job(),
    part = segment(upload);
  await db.writePersonalMediaUploadJob(upload, context);
  expect(
    await db.preparePersonalRecordingSegment(part, undefined, context),
  ).toBe(true);
  await put(names[0], { ...control, maintenance: hold });
  await expect(
    db.writePersonalMediaUploadJob(job(), context),
  ).rejects.toThrow();
  await expect(
    db.preparePersonalRecordingSegment(part, "pending_upload", context),
  ).rejects.toThrow();
  await expect(
    db.transitionPersonalRecordingSegment(
      { ...part, status: "uploaded" },
      "pending_upload",
      context,
    ),
  ).rejects.toThrow();
  await expect(
    db.submitPersonalMediaUploadJob({ ...upload, status: "queued" }, context),
  ).rejects.toThrow();
  expect(
    await read(names[4], {
      uploadId: upload.uploadId,
      segmentKey: part.segmentKey,
    }),
  ).toEqual(part);
  expect(await read(names[3], { uploadId: upload.uploadId })).toEqual(upload);
  await put(names[0], control);
  expect(
    await db.transitionPersonalRecordingSegment(
      { ...part, status: "uploaded" },
      "pending_upload",
      context,
    ),
  ).toBe(true);
  expect(
    await db.transitionPersonalRecordingSegment(
      { ...part, status: "submitted" },
      "uploaded",
      context,
    ),
  ).toBe(true);
  await put(names[0], { ...control, maintenance: hold });
  await expect(
    db.submitPersonalMediaUploadJob({ ...upload, status: "queued" }, context),
  ).rejects.toThrow();
  expect(
    (
      await read(names[4], {
        uploadId: upload.uploadId,
        segmentKey: part.segmentKey,
      })
    )?.status,
  ).toBe("submitted");
  await put(names[0], control);
  expect(
    await db.submitPersonalMediaUploadJob(
      { ...upload, status: "queued" },
      context,
    ),
  ).toBe(true);
  expect(
    (
      await read(names[4], {
        uploadId: upload.uploadId,
        segmentKey: part.segmentKey,
      })
    )?.sourceS3Key,
  ).toBe(part.sourceS3Key);
});
test.each(["create", "complete", "submit"])(
  "native hold races personal %s at the durable transaction",
  async (stage) => {
    routeDbToNativeTables();
    const upload = job(),
      part = segment(upload);
    if (stage !== "create")
      await db.writePersonalMediaUploadJob(upload, context);
    if (stage === "complete")
      await db.preparePersonalRecordingSegment(part, undefined, context);
    const effects = {
      create: () => db.writePersonalMediaUploadJob(upload, context),
      complete: () =>
        db.transitionPersonalRecordingSegment(
          { ...part, status: "uploaded" },
          "pending_upload",
          context,
        ),
      submit: () =>
        db.submitPersonalMediaUploadJob(
          { ...upload, status: "queued" },
          context,
        ),
    };
    const effect = effects[stage as keyof typeof effects];
    const [result] = await Promise.allSettled([
      effect(),
      put(names[0], { ...control, maintenance: hold }),
    ]);
    const row =
      stage === "complete"
        ? await read(names[4], {
            uploadId: upload.uploadId,
            segmentKey: part.segmentKey,
          })
        : await read(names[3], { uploadId: upload.uploadId });
    const successes = {
      create: "pending_upload",
      complete: "uploaded",
      submit: "queued",
    };
    const expected =
      result.status === "fulfilled"
        ? successes[stage as keyof typeof successes]
        : stage === "create"
          ? undefined
          : "pending_upload";
    expect(row?.status).toBe(expected);
    await expect(effect()).rejects.toThrow();
  },
);
test("native API admission orders provider ownership before hold and keeps its acknowledgement receipt", async () => {
  routeDbToNativeTables();
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((r) => (entered = r)),
    finish = new Promise<void>((r) => (release = r));
  const receipt = jest.fn();
  const task = runRuntimeApiOperation(randomUUID(), async (operation) =>
    operation.mutate(async () => {
      entered();
      await finish;
      receipt();
    }),
  );
  await started;
  await put(names[0], { ...control, maintenance: hold });
  const provider = jest.fn();
  await expect(
    runRuntimeApiOperation(randomUUID(), provider),
  ).rejects.toThrow();
  expect(provider).not.toHaveBeenCalled();
  release();
  await task;
  expect(receipt).toHaveBeenCalledTimes(1);
});

test("an incidental DynamoDB client without explicit endpoint uses the validated loopback harness", async () => {
  const incidental = new DynamoDBClient({ region: "local" });
  try {
    const result = await incidental.send(
      new DescribeTableCommand({ TableName: tables.deploymentControl }),
    );
    expect(result.Table?.TableName).toBe(tables.deploymentControl);
    expect(process.env.AWS_ENDPOINT_URL_DYNAMODB).toBe(
      process.env.DEPLOYMENT_TEST_DYNAMODB_ENDPOINT,
    );
  } finally {
    incidental.destroy();
  }
});
