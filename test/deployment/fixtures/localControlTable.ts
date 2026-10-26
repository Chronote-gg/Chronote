import {
  CreateTableCommand,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  TransactWriteItemsCommand,
  UpdateItemCommand,
  type TransactWriteItemsCommandInput,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
export const createLocalControlTable = (
  client: DynamoDBClient,
  TableName: string,
) =>
  client.send(
    new CreateTableCommand({
      TableName,
      BillingMode: "PAY_PER_REQUEST",
      KeySchema: ["pk", "sk"].map((AttributeName, index) => ({
        AttributeName,
        KeyType: index === 0 ? "HASH" : "RANGE",
      })),
      AttributeDefinitions: ["pk", "sk"].map((AttributeName) => ({
        AttributeName,
        AttributeType: "S",
      })),
    }),
  );
export function localControlTable() {
  const client = new DynamoDBClient({
    region: "local",
    endpoint: process.env.DEPLOYMENT_TEST_DYNAMODB_ENDPOINT,
    credentials: { accessKeyId: "dummy", secretAccessKey: "dummy" },
  });
  const createTable = (TableName: string) =>
    createLocalControlTable(client, TableName);
  function records(TableName: string) {
    const put = (row: object) =>
      client.send(new PutItemCommand({ TableName, Item: marshall(row) }));
    const read = async (pk: string, sk: string) => {
      const response = await client.send(
        new GetItemCommand({
          TableName,
          Key: marshall({ pk, sk }),
          ConsistentRead: true,
        }),
      );
      return response.Item ? unmarshall(response.Item) : undefined;
    };
    const invalidateReadiness = (sk: string) =>
      client.send(
        new UpdateItemCommand({
          TableName,
          Key: marshall({ pk: "ENV", sk }),
          UpdateExpression: "SET readiness.dependenciesReady = :false",
          ExpressionAttributeValues: marshall({ ":false": false }),
        }),
      );
    const progress = (cursor: {
      guildId: string;
      channelId_timestamp: string;
    }) =>
      client.send(
        new UpdateItemCommand({
          TableName,
          Key: marshall({ pk: "ENV", sk: "CONTROL" }),
          UpdateExpression: "SET recoveryScanCursor = :cursor",
          ExpressionAttributeValues: marshall({ ":cursor": cursor }),
        }),
      );
    return { put, read, invalidateReadiness, progress };
  }
  function transact(TableName: string, input: TransactWriteItemsCommandInput) {
    const request = structuredClone(input);
    for (const item of request.TransactItems!) {
      if (item.Update) item.Update.TableName = TableName;
      if (item.Put) item.Put.TableName = TableName;
      if (item.ConditionCheck) item.ConditionCheck.TableName = TableName;
    }
    return client.send(new TransactWriteItemsCommand(request));
  }
  return { client, createTable, records, transact };
}
