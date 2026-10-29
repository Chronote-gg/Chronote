import { randomUUID } from "node:crypto";
import {
  CreateTableCommand,
  DeleteTableCommand,
  GetItemCommand,
  PutItemCommand,
  DynamoDBClient,
  type AttributeDefinition,
  type GlobalSecondaryIndex,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { createDynamoMeetingUpdateDeliveryRepository } from "../../src/repositories/meetingUpdateDeliveryRepository";
import type { MeetingHistory } from "../../src/types/db";
import { PROCESSING_RETRY_DUE_INDEX } from "../../src/types/meetingProcessingRetry";
import type { MeetingUpdateKey } from "../../src/types/meetingUpdateDelivery";
import { key, now } from "../types/meetingUpdateDelivery.fixture";
import { control, runtime } from "./controlFixtures";

/** The sparse due indexes MeetingHistory carries in Terraform and init-dynamodb.js. */
const historyDueIndexes = [
  ["UpdateDeliveryDueIndex", "updateDeliveryQueue", "updateDeliveryDueAt"],
  [PROCESSING_RETRY_DUE_INDEX, "processingRetryQueue", "processingRetryDueAt"],
] as const;
export function meetingUpdateDynamoFixture(label: string) {
  const prefix = label + "-" + randomUUID();
  const tables = {
    meetingHistory: prefix + "-history",
    deploymentControl: prefix + "-control",
  };
  const client = new DynamoDBClient({
    endpoint: process.env.DEPLOYMENT_TEST_DYNAMODB_ENDPOINT,
    region: "local",
    credentials: { accessKeyId: "dummy", secretAccessKey: "dummy" },
    maxAttempts: 1,
  });
  const repository = createDynamoMeetingUpdateDeliveryRepository(
    client,
    tables,
  );
  const created: string[] = [];
  const put = (table: string, row: object) =>
    client.send(
      new PutItemCommand({
        TableName: table,
        Item: marshall(row, { removeUndefinedValues: true }),
      }),
    );
  async function createTestTable(
    tableName: string,
    primaryKeys: string[],
    dueIndex = false,
  ) {
    const KeySchema = primaryKeys.map((AttributeName, index) => ({
      AttributeName,
      KeyType: index === 0 ? ("HASH" as const) : ("RANGE" as const),
    }));
    const AttributeDefinitions: AttributeDefinition[] = primaryKeys.map(
      (AttributeName) => ({ AttributeName, AttributeType: "S" }),
    );
    if (dueIndex)
      for (const [, queue, dueAt] of historyDueIndexes)
        AttributeDefinitions.push(
          { AttributeName: queue, AttributeType: "S" },
          { AttributeName: dueAt, AttributeType: "N" },
        );
    const GlobalSecondaryIndexes: GlobalSecondaryIndex[] | undefined = dueIndex
      ? historyDueIndexes.map(([IndexName, queue, dueAt]) => ({
          IndexName,
          KeySchema: [
            { AttributeName: queue, KeyType: "HASH" },
            { AttributeName: dueAt, KeyType: "RANGE" },
          ],
          Projection: { ProjectionType: "KEYS_ONLY" },
        }))
      : undefined;
    await client.send(
      new CreateTableCommand({
        TableName: tableName,
        BillingMode: "PAY_PER_REQUEST",
        KeySchema,
        AttributeDefinitions,
        GlobalSecondaryIndexes,
      }),
    );
    created.push(tableName);
  }

  async function createTables() {
    await createTestTable(
      tables.meetingHistory,
      ["guildId", "channelId_timestamp"],
      true,
    );
    await createTestTable(tables.deploymentControl, ["pk", "sk"]);
  }
  async function read(
    at: MeetingUpdateKey = key,
  ): Promise<MeetingHistory | undefined> {
    const result = await client.send(
      new GetItemCommand({
        TableName: tables.meetingHistory,
        Key: marshall(at),
        ConsistentRead: true,
      }),
    );
    return result.Item
      ? (unmarshall(result.Item) as MeetingHistory)
      : undefined;
  }
  /** Seeds deployment control so the fixture's serving authority is admitted, or fenced. */
  async function admit(allowed: boolean) {
    await put(tables.deploymentControl, {
      ...control,
      servingMembers: allowed ? control.servingMembers : {},
    });
    const row = runtime("old");
    await put(tables.deploymentControl, {
      ...row,
      heartbeatAt: now,
      readiness: { ...row.readiness, provenAt: now - 1, expiresAt: now + 200 },
      protection: {
        ...row.protection!,
        provenAt: now - 1,
        expiresAt: now + 200,
      },
    });
  }

  async function dispose() {
    for (const TableName of created)
      await client.send(new DeleteTableCommand({ TableName }));
    client.destroy();
  }
  return {
    tables,
    client,
    repository,
    created,
    put,
    createTestTable,
    createTables,
    read,
    admit,
    dispose,
  };
}
