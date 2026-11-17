import type { CreateTableCommandInput } from "@aws-sdk/client-dynamodb";

/** The string pk and sk key schema of DeploymentControlTable, for scratch tables that stand in for it. */
export const deploymentControlKeySchema = {
  AttributeDefinitions: [
    { AttributeName: "pk", AttributeType: "S" },
    { AttributeName: "sk", AttributeType: "S" },
  ],
  KeySchema: [
    { AttributeName: "pk", KeyType: "HASH" },
    { AttributeName: "sk", KeyType: "RANGE" },
  ],
} satisfies Pick<CreateTableCommandInput, "AttributeDefinitions" | "KeySchema">;
