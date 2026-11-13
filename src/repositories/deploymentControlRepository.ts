import { conditional, type ConditionalResult } from "./deploymentControlErrors";
import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import {
  parseDeploymentControlRecord,
  suppressionRecordSchema,
  type ControlTableNames,
  type DeploymentControlRecord,
  type SuppressionRecord,
} from "../types/deploymentControl";

export {
  classifyDeploymentTransactionError,
  DeploymentControlError,
  type ConditionalResult,
} from "./deploymentControlErrors";

/** Suppression and paused-draft records. */
export type DeploymentControlRepository = {
  writeSuppression(input: {
    record: SuppressionRecord;
    expectedVersion?: number;
  }): Promise<ConditionalResult>;
  getRecord(
    pk: string,
    sk: string,
  ): Promise<DeploymentControlRecord | undefined>;
};

function assertSuppressionVersion(
  record: SuppressionRecord,
  expectedVersion: number | undefined,
) {
  suppressionRecordSchema.parse(record);
  if (record.version !== (expectedVersion ?? 0) + 1)
    throw new Error("Invalid suppression version");
}

export function createDynamoDeploymentControlRepository(
  client: DynamoDBClient,
  tables: ControlTableNames,
): DeploymentControlRepository {
  return {
    async getRecord(pk, sk) {
      const result = await client.send(
        new GetItemCommand({
          TableName: tables.deploymentControl,
          Key: marshall({ pk, sk }),
          ConsistentRead: true,
        }),
      );
      return result.Item
        ? parseDeploymentControlRecord(unmarshall(result.Item))
        : undefined;
    },
    writeSuppression({ record, expectedVersion }) {
      assertSuppressionVersion(record, expectedVersion);
      return conditional(() =>
        client.send(
          new PutItemCommand({
            TableName: tables.deploymentControl,
            Item: marshall(record),
            ConditionExpression:
              expectedVersion === undefined
                ? "attribute_not_exists(pk)"
                : "#version = :version",
            ...(expectedVersion === undefined
              ? {}
              : {
                  ExpressionAttributeNames: { "#version": "version" },
                  ExpressionAttributeValues: marshall({
                    ":version": expectedVersion,
                  }),
                }),
          }),
        ),
      );
    },
  };
}

export function createMockDeploymentControlRepository(
  records = new Map<string, DeploymentControlRecord>(),
): DeploymentControlRepository {
  const recordKey = (pk: string, sk: string) => JSON.stringify([pk, sk]);
  return {
    async getRecord(pk, sk) {
      const row = records.get(recordKey(pk, sk));
      return row
        ? structuredClone(parseDeploymentControlRecord(row))
        : undefined;
    },
    async writeSuppression({ record, expectedVersion }) {
      assertSuppressionVersion(record, expectedVersion);
      const current = records.get(recordKey(record.pk, record.sk));
      if (
        expectedVersion === undefined
          ? Boolean(current)
          : current?.recordType !== "suppression" ||
            current.version !== expectedVersion
      )
        return "stale";
      records.set(recordKey(record.pk, record.sk), structuredClone(record));
      return "applied";
    },
  };
}
