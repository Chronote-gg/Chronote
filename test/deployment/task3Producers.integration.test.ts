import { randomUUID } from "node:crypto";
import {
  DynamoDBClient,
  DescribeTableCommand,
  CreateTableCommand,
  DeleteTableCommand,
  GetItemCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import * as db from "../../src/db";
import { createDynamoDeploymentControlRepository } from "../../src/repositories/deploymentControlRepository";
import type {
  PersonalMediaUploadJobRecord,
  PersonalRecordingSegmentRecord,
} from "../../src/types/db";
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
  endpoint: process.env.TEST_DYNAMODB_ENDPOINT,
  region: "local",
  credentials: { accessKeyId: "dummy", secretAccessKey: "dummy" },
});
const repository = createDynamoDeploymentControlRepository(client, tables);
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
test("real personal producer transactions keep their own conditions without a deployment admission check", async () => {
  routeDbToNativeTables();
  const upload = job(),
    part = segment(upload);
  await db.writePersonalMediaUploadJob(upload);
  await expect(db.writePersonalMediaUploadJob(upload)).rejects.toThrow(
    "Personal upload already exists",
  );
  expect(await db.preparePersonalRecordingSegment(part, undefined)).toBe(true);
  expect(await db.preparePersonalRecordingSegment(part, undefined)).toBe(false);
  expect(
    await db.transitionPersonalRecordingSegment(
      { ...part, status: "uploaded" },
      "pending_upload",
    ),
  ).toBe(true);
  expect(
    await db.transitionPersonalRecordingSegment(
      { ...part, status: "submitted" },
      "pending_upload",
    ),
  ).toBe(false);
  expect(
    await db.transitionPersonalRecordingSegment(
      { ...part, status: "submitted" },
      "uploaded",
    ),
  ).toBe(true);
  expect(
    await db.submitPersonalMediaUploadJob({ ...upload, status: "queued" }),
  ).toBe(true);
  expect(
    await db.submitPersonalMediaUploadJob({ ...upload, status: "queued" }),
  ).toBe(false);
  expect(
    await read(names[4], {
      uploadId: upload.uploadId,
      segmentKey: part.segmentKey,
    }),
  ).toMatchObject({ status: "submitted", sourceS3Key: part.sourceS3Key });
  expect(await read(names[3], { uploadId: upload.uploadId })).toMatchObject({
    status: "queued",
  });
});

test("an incidental DynamoDB client without explicit endpoint uses the validated loopback harness", async () => {
  const incidental = new DynamoDBClient({ region: "local" });
  try {
    const result = await incidental.send(
      new DescribeTableCommand({ TableName: tables.deploymentControl }),
    );
    expect(result.Table?.TableName).toBe(tables.deploymentControl);
    expect(process.env.AWS_ENDPOINT_URL_DYNAMODB).toBe(
      process.env.TEST_DYNAMODB_ENDPOINT,
    );
  } finally {
    incidental.destroy();
  }
});
