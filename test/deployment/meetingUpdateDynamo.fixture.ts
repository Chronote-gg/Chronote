import { randomUUID } from "node:crypto";
import {
  CreateTableCommand,
  DeleteTableCommand,
  PutItemCommand,
  DynamoDBClient,
  type AttributeDefinition,
  type GlobalSecondaryIndex,
} from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import { createDynamoMeetingUpdateDeliveryRepository } from "../../src/repositories/meetingUpdateDeliveryRepository";
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
      AttributeDefinitions.push(
        { AttributeName: "updateDeliveryQueue", AttributeType: "S" },
        { AttributeName: "updateDeliveryDueAt", AttributeType: "N" },
      );
    const GlobalSecondaryIndexes: GlobalSecondaryIndex[] | undefined = dueIndex
      ? [
          {
            IndexName: "UpdateDeliveryDueIndex",
            KeySchema: [
              { AttributeName: "updateDeliveryQueue", KeyType: "HASH" },
              { AttributeName: "updateDeliveryDueAt", KeyType: "RANGE" },
            ],
            Projection: { ProjectionType: "KEYS_ONLY" },
          },
        ]
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

  async function dispose() {
    for (const TableName of created)
      await client.send(new DeleteTableCommand({ TableName }));
    client.destroy();
  }
  return { tables, client, repository, created, put, createTestTable, dispose };
}
