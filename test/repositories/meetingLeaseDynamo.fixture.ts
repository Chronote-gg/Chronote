import { randomUUID } from "node:crypto";
import {
  CreateTableCommand,
  DeleteTableCommand,
  type DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import {
  createDynamoMeetingLeaseRepository,
  type MeetingLeaseTables,
} from "../../src/repositories/meetingLeaseRepository";
import type { MeetingHistory } from "../../src/types/db";
import {
  suppressionRecord,
  type MeetingLeaseHarness,
} from "./meetingLeaseRepository.contract";

function keySchema(hash: string, range?: string) {
  const keys = range ? [hash, range] : [hash];
  return {
    KeySchema: keys.map((AttributeName, index) => ({
      AttributeName,
      KeyType: index === 0 ? ("HASH" as const) : ("RANGE" as const),
    })),
    AttributeDefinitions: keys.map((AttributeName) => ({
      AttributeName,
      AttributeType: "S" as const,
    })),
  };
}

/** Throwaway ActiveMeeting, MeetingHistory and DeploymentControl tables under one random prefix. */
export async function createLeaseTables(
  client: DynamoDBClient,
): Promise<MeetingLeaseHarness & { tables: MeetingLeaseTables }> {
  const prefix = "meeting-lease-" + randomUUID() + "-";
  const tables: MeetingLeaseTables = {
    activeMeeting: prefix + "ActiveMeeting",
    meetingHistory: prefix + "MeetingHistory",
    deploymentControl: prefix + "DeploymentControl",
  };
  const schemas = [
    [tables.activeMeeting, keySchema("guildId")],
    [tables.meetingHistory, keySchema("guildId", "channelId_timestamp")],
    [tables.deploymentControl, keySchema("pk", "sk")],
  ] as const;
  await Promise.all(
    schemas.map(([TableName, schema]) =>
      client.send(
        new CreateTableCommand({
          TableName,
          BillingMode: "PAY_PER_REQUEST",
          ...schema,
        }),
      ),
    ),
  );
  const put = (TableName: string, item: object) =>
    client.send(
      new PutItemCommand({
        TableName,
        Item: marshall(item, { removeUndefinedValues: true }),
      }),
    );
  return {
    tables,
    repository: createDynamoMeetingLeaseRepository(client, tables),
    async seedLease(lease) {
      await put(tables.activeMeeting, lease);
    },
    async seedHistory(row) {
      await put(tables.meetingHistory, row);
    },
    async seedSuppression(row) {
      await put(tables.deploymentControl, suppressionRecord(row));
    },
    async readHistory(key) {
      const result = await client.send(
        new GetItemCommand({
          TableName: tables.meetingHistory,
          Key: marshall(key),
          ConsistentRead: true,
        }),
      );
      return result.Item
        ? (unmarshall(result.Item) as MeetingHistory)
        : undefined;
    },
    async dispose() {
      await Promise.all(
        Object.values(tables).map((TableName) =>
          client.send(new DeleteTableCommand({ TableName })),
        ),
      );
    },
  };
}
