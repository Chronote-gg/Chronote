import {
  DescribeTableCommand,
  type DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
export async function readDynamoIndexStatus(
  client: DynamoDBClient,
  input: { mock: boolean; tableName: string; indexName: string },
): Promise<string | undefined> {
  if (input.mock) return "ACTIVE";
  const result = await client.send(
    new DescribeTableCommand({ TableName: input.tableName }),
  );
  return result.Table?.GlobalSecondaryIndexes?.find(
    (index) => index.IndexName === input.indexName,
  )?.IndexStatus;
}
