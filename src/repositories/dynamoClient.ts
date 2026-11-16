import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { config } from "../services/configService";
import { LIFECYCLE } from "../services/lifecycleTiming";

/**
 * Without throwOnRequestTimeout the SDK only logs a breached request timeout.
 * The TimeoutError it throws instead is transient, so the SDK retries it
 * within its attempt limit and callers see a transport error, never a
 * condition failure.
 */
export function dynamoRequestHandler({
  connectionTimeoutMs = LIFECYCLE.dynamoConnectionTimeoutMs,
  requestTimeoutMs = LIFECYCLE.dynamoRequestTimeoutMs,
}: { connectionTimeoutMs?: number; requestTimeoutMs?: number } = {}) {
  return {
    connectionTimeout: connectionTimeoutMs,
    requestTimeout: requestTimeoutMs,
    throwOnRequestTimeout: true,
  };
}

export const dynamoDbClient = new DynamoDBClient({
  requestHandler: dynamoRequestHandler(),
  ...(config.database.useLocalDynamoDB
    ? {
        endpoint: "http://localhost:8000",
        region: "local",
        credentials: {
          accessKeyId: "dummy",
          secretAccessKey: "dummy",
        },
      }
    : { region: "us-east-1" }),
});

export const tablePrefix = config.database.tablePrefix ?? "";
export const tableName = (name: string) => `${tablePrefix}${name}`;
