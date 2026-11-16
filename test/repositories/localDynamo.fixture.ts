import { randomUUID } from "node:crypto";
import {
  type CreateTableCommandInput,
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";

const endpoint = process.env.TEST_DYNAMODB_ENDPOINT;

/** Local Dynamo suites are skipped, not failed, where no endpoint is configured. */
export const describeLocalDynamo = endpoint ? describe : describe.skip;

export function localDynamoClient() {
  return new DynamoDBClient({
    endpoint,
    region: "local",
    maxAttempts: 1,
    credentials: { accessKeyId: "dummy", secretAccessKey: "dummy" },
  });
}

/** A throwaway on-demand table under a random name, so parallel runs never share one. */
export async function createScratchTable(
  client: DynamoDBClient,
  prefix: string,
  schema: Pick<CreateTableCommandInput, "AttributeDefinitions" | "KeySchema">,
): Promise<{ TableName: string; dispose(): Promise<void> }> {
  const TableName = `${prefix}-${randomUUID()}`;
  await client.send(
    new CreateTableCommand({
      TableName,
      BillingMode: "PAY_PER_REQUEST",
      ...schema,
    }),
  );
  return {
    TableName,
    async dispose() {
      await client.send(new DeleteTableCommand({ TableName }));
    },
  };
}
