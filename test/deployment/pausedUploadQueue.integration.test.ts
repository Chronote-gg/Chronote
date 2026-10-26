import { buildPausedDesktopDraftMarker } from "../../src/testSupport/personalMediaUploadFixtures";
import { randomUUID } from "node:crypto";
import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  PutItemCommand,
  GetItemCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { createDynamoDeploymentControlRepository } from "../../src/repositories/deploymentControlRepository";
import { listUnpausedPersonalMediaUploadJobs } from "../../src/repositories/personalMediaUploadQueue";
import type { PersonalMediaUploadJobRecord } from "../../src/types/db";

const prefix = "paused-queue-" + randomUUID();
const tables = {
  uploadTable: prefix + "-uploads",
  deploymentControl: prefix + "-control",
  statusIndex: "StatusUpdatedAtIndex",
};
const client = new DynamoDBClient({
  endpoint: process.env.DEPLOYMENT_TEST_DYNAMODB_ENDPOINT,
  region: "local",
  maxAttempts: 1,
  credentials: { accessKeyId: "dummy", secretAccessKey: "dummy" },
});
const control = createDynamoDeploymentControlRepository(client, {
  deploymentControl: tables.deploymentControl,
  meetingHistory: "unused",
});
const put = (TableName: string, record: object) =>
  client.send(new PutItemCommand({ TableName, Item: marshall(record) }));
const job = (
  uploadId: string,
  updatedAt: string,
  overrides: Partial<PersonalMediaUploadJobRecord> = {},
): PersonalMediaUploadJobRecord => ({
  uploadId,
  updatedAt,
  ownerUserId: "synthetic-owner",
  status: "queued",
  mediaKind: "audio",
  sourceS3Key: "synthetic/source",
  contentType: "audio/wav",
  fileSize: 10,
  createdAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});
const rows = [
  job("paused-one", "2026-01-01T01:00:00.000Z"),
  job("paused-two", "2026-01-01T02:00:00.000Z"),
  job("exhausted", "2026-01-01T03:00:00.000Z", { attempts: 3 }),
  job("leased", "2026-01-01T04:00:00.000Z", { claimExpiresAt: 200 }),
  job("ordinary-one", "2026-01-01T05:00:00.000Z"),
  job("ordinary-two", "2026-01-01T06:00:00.000Z"),
  job("processing", "2026-01-01T07:00:00.000Z", {
    status: "processing",
    processingOwnerInstanceId: "worker",
    claimExpiresAt: 200,
    attempts: 1,
  }),
];
beforeAll(async () => {
  await client.send(
    new CreateTableCommand({
      TableName: tables.deploymentControl,
      BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [
        { AttributeName: "pk", AttributeType: "S" },
        { AttributeName: "sk", AttributeType: "S" },
      ],
      KeySchema: [
        { AttributeName: "pk", KeyType: "HASH" },
        { AttributeName: "sk", KeyType: "RANGE" },
      ],
    }),
  );
  await client.send(
    new CreateTableCommand({
      TableName: tables.uploadTable,
      BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: ["uploadId", "status", "updatedAt"].map(
        (AttributeName) => ({ AttributeName, AttributeType: "S" }),
      ),
      KeySchema: [{ AttributeName: "uploadId", KeyType: "HASH" }],
      GlobalSecondaryIndexes: [
        {
          IndexName: tables.statusIndex,
          KeySchema: [
            { AttributeName: "status", KeyType: "HASH" },
            { AttributeName: "updatedAt", KeyType: "RANGE" },
          ],
          Projection: { ProjectionType: "ALL" },
        },
      ],
    }),
  );
  for (const row of rows) await put(tables.uploadTable, row);
  for (const row of rows.slice(0, 2))
    await put(tables.deploymentControl, buildPausedDesktopDraftMarker(row));
});
afterAll(async () => {
  for (const TableName of [tables.uploadTable, tables.deploymentControl])
    await client.send(new DeleteTableCommand({ TableName }));
  client.destroy();
});
test.each([
  { limit: 1, expected: [rows[4]] },
  { limit: 3, expected: rows.slice(4) },
])(
  "real queue fills limit $limit past paused and filtered pages",
  async ({ limit, expected }) => {
    await expect(
      listUnpausedPersonalMediaUploadJobs(
        client,
        { ...tables, control },
        { instanceId: "worker", nowEpochSeconds: 100, maxAttempts: 3, limit },
      ),
    ).resolves.toEqual(expected);
    for (const row of rows) {
      const result = await client.send(
        new GetItemCommand({
          TableName: tables.uploadTable,
          Key: marshall({ uploadId: row.uploadId }),
          ConsistentRead: true,
        }),
      );
      expect(result.Item && unmarshall(result.Item)).toEqual(row);
    }
  },
);
