import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { config } from "../services/configService";

export const dynamoDbClient = new DynamoDBClient(
  config.database.useLocalDynamoDB
    ? {
        endpoint: "http://localhost:8000",
        region: "local",
        credentials: {
          accessKeyId: "dummy",
          secretAccessKey: "dummy",
        },
      }
    : { region: "us-east-1" },
);

export const tablePrefix = config.database.tablePrefix ?? "";
export const tableName = (name: string) => `${tablePrefix}${name}`;
