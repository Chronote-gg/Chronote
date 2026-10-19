import {
  DynamoDBClient,
  CreateTableCommand,
  DeleteTableCommand,
  GetItemCommand,
  PutItemCommand,
  TransactWriteItemsCommand,
  type TransactWriteItemsCommandInput,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
export const introductionClient = new DynamoDBClient({
  endpoint: process.env.DEPLOYMENT_TEST_DYNAMODB_ENDPOINT,
  region: "local",
  credentials: { accessKeyId: "dummy", secretAccessKey: "dummy" },
  maxAttempts: 1,
});
const tables: string[] = [];
afterAll(async () => {
  for (const TableName of tables)
    await introductionClient.send(new DeleteTableCommand({ TableName }));
  introductionClient.destroy();
});
export async function createIntroductionTable(
  table: string,
  [partition, sort]: [string, string?] = ["pk", "sk"],
) {
  await introductionClient.send(
    new CreateTableCommand({
      TableName: table,
      BillingMode: "PAY_PER_REQUEST",
      KeySchema: [
        { AttributeName: partition, KeyType: "HASH" },
        ...(sort ? [{ AttributeName: sort, KeyType: "RANGE" as const }] : []),
      ],
      AttributeDefinitions: [partition, ...(sort ? [sort] : [])].map(
        (AttributeName) => ({ AttributeName, AttributeType: "S" }),
      ),
    }),
  );
  tables.push(table);
}
export async function readIntroductionDocument(table: string, key: object) {
  const response = await introductionClient.send(
    new GetItemCommand({
      TableName: table,
      Key: marshall(key),
      ConsistentRead: true,
    }),
  );
  return response.Item ? unmarshall(response.Item) : undefined;
}
export const putIntroductionDocument = (table: string, value: object) =>
  introductionClient.send(
    new PutItemCommand({
      TableName: table,
      Item: marshall(value, { removeUndefinedValues: true }),
    }),
  );
export const writeIntroduction = (input: TransactWriteItemsCommandInput) =>
  introductionClient.send(new TransactWriteItemsCommand(input));
