import { DeleteTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";

export async function cleanupOwnedTables(
  client: DynamoDBClient,
  tables: readonly string[],
) {
  for (const TableName of tables)
    await client.send(new DeleteTableCommand({ TableName }));
  client.destroy();
}
