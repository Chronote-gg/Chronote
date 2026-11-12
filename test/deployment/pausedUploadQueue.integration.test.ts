import { buildPausedDesktopDraftMarker } from "../../src/testSupport/personalMediaUploadFixtures";
import { randomUUID } from "node:crypto";
import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  PutItemCommand,
  GetItemCommand,
  TransactWriteItemsCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { createDynamoDeploymentControlRepository } from "../../src/repositories/deploymentControlRepository";
import { listUnpausedPersonalMediaUploadJobs } from "../../src/repositories/personalMediaUploadQueue";
import { buildPersonalMediaClaimTransaction } from "../../src/services/personalUploadTransactions";
import type { PersonalMediaUploadJobRecord } from "../../src/types/db";
import { deploymentControlKeySchema } from "../fixtures/deploymentControlKeySchema";

const prefix = "paused-queue-" + randomUUID();
const tables = {
  uploadTable: prefix + "-uploads",
  deploymentControl: prefix + "-control",
  statusIndex: "StatusUpdatedAtIndex",
};
const client = new DynamoDBClient({
  endpoint: process.env.TEST_DYNAMODB_ENDPOINT,
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
      ...deploymentControlKeySchema,
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

const claimTransaction = (uploadId: string, instanceId: string) => {
  const claimId = randomUUID();
  return buildPersonalMediaClaimTransaction(
    {
      job: job(uploadId, "2026-01-01T08:00:00.000Z", {
        status: "processing",
        processingOwnerInstanceId: instanceId,
        processingClaimId: claimId,
        attempts: 1,
        claimExpiresAt: 160,
      }),
      instanceId,
      nowEpochSeconds: 100,
      expectedAttempts: 0,
      maxAttempts: 3,
      claimId,
    },
    {
      deploymentControl: tables.deploymentControl,
      personalMediaUpload: tables.uploadTable,
    },
  );
};
test("two concurrent real claims of one upload with no runtime record: exactly one wins", async () => {
  const uploadId = "race-" + randomUUID();
  await put(tables.uploadTable, job(uploadId, "2026-01-01T08:00:00.000Z"));
  const claims = ["synthetic-worker-a", "synthetic-worker-b"].map(
    (instanceId) => claimTransaction(uploadId, instanceId),
  );
  const results = await Promise.allSettled(
    claims.map((claim) => client.send(new TransactWriteItemsCommand(claim))),
  );
  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  const loser = results.findIndex((result) => result.status === "rejected");
  await expect(
    client.send(new TransactWriteItemsCommand(claims[loser])),
  ).rejects.toMatchObject({ name: "TransactionCanceledException" });
  const stored = await client.send(
    new GetItemCommand({
      TableName: tables.uploadTable,
      Key: marshall({ uploadId }),
      ConsistentRead: true,
    }),
  );
  const winner = claims[1 - loser].TransactItems![1].Put!.Item!;
  expect(unmarshall(stored.Item!)).toEqual(unmarshall(winner));
});
test("a paused draft still refuses a real claim", async () => {
  await expect(
    client.send(
      new TransactWriteItemsCommand(
        claimTransaction(rows[0].uploadId, "synthetic-worker"),
      ),
    ),
  ).rejects.toMatchObject({ name: "TransactionCanceledException" });
});
