import { randomUUID } from "node:crypto";
import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  PutItemCommand,
  GetItemCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { createDynamoMeetingUpdateDeliveryRepository } from "../../src/repositories/meetingUpdateDeliveryRepository";
import { createDynamoMeetingPublicationRepository } from "../../src/repositories/meetingPublicationRepository";
import { createDynamoDeploymentControlRepository } from "../../src/repositories/deploymentControlRepository";
import { parseMeetingUpdateHistory } from "../../src/repositories/meetingUpdateDeliveryState";
import { context, control, runtime } from "./controlFixtures";
import type { MeetingUpdateKey } from "../../src/types/meetingUpdateDelivery";
import { key } from "../types/meetingUpdateDelivery.fixture";

export async function publicationDynamoFixture(rowKey: MeetingUpdateKey = key) {
  const prefix = "task6-publication-" + randomUUID();
  const tables = {
    meetingHistory: prefix + "-history",
    deploymentControl: prefix + "-control",
    activeMeeting: prefix + "-active",
  };
  const client = new DynamoDBClient({
    endpoint: process.env.DEPLOYMENT_TEST_DYNAMODB_ENDPOINT,
    region: "local",
    credentials: { accessKeyId: "dummy", secretAccessKey: "dummy" },
    maxAttempts: 1,
  });
  const created: string[] = [];
  async function create(table: string, keys: string[], due = false) {
    await client.send(
      new CreateTableCommand({
        TableName: table,
        BillingMode: "PAY_PER_REQUEST",
        KeySchema: keys.map((AttributeName, index) => ({
          AttributeName,
          KeyType: index === 0 ? "HASH" : "RANGE",
        })),
        AttributeDefinitions: [
          ...keys.map((AttributeName) => ({
            AttributeName,
            AttributeType: "S" as const,
          })),
          ...(due
            ? [
                {
                  AttributeName: "updateDeliveryQueue",
                  AttributeType: "S" as const,
                },
                {
                  AttributeName: "updateDeliveryDueAt",
                  AttributeType: "N" as const,
                },
              ]
            : []),
        ],
        ...(due
          ? {
              GlobalSecondaryIndexes: [
                {
                  IndexName: "UpdateDeliveryDueIndex",
                  KeySchema: [
                    { AttributeName: "updateDeliveryQueue", KeyType: "HASH" },
                    { AttributeName: "updateDeliveryDueAt", KeyType: "RANGE" },
                  ],
                  Projection: { ProjectionType: "KEYS_ONLY" },
                },
              ],
            }
          : {}),
      }),
    );
    created.push(table);
  }
  async function put(table: string, row: object) {
    await client.send(
      new PutItemCommand({
        TableName: table,
        Item: marshall(row, { removeUndefinedValues: true }),
      }),
    );
  }
  async function read() {
    const result = await client.send(
      new GetItemCommand({
        TableName: tables.meetingHistory,
        Key: marshall(rowKey),
        ConsistentRead: true,
      }),
    );
    return result.Item
      ? parseMeetingUpdateHistory(unmarshall(result.Item))
      : undefined;
  }
  async function admit() {
    const now = Math.floor(Date.now() / 1000);
    const record = runtime("old");
    await put(tables.deploymentControl, {
      ...control,
      coordinatorExpiresAt: now + 3600,
    });
    await put(tables.deploymentControl, {
      ...record,
      heartbeatAt: now,
      readiness: {
        ...record.readiness,
        provenAt: now - 1,
        expiresAt: now + 3600,
      },
      protection: {
        ...record.protection,
        provenAt: now - 1,
        expiresAt: now + 3600,
      },
    });
    return { kind: "serving" as const, context: { ...context, now } };
  }
  try {
    await create(
      tables.meetingHistory,
      ["guildId", "channelId_timestamp"],
      true,
    );
    await create(tables.deploymentControl, ["pk", "sk"]);
    await create(tables.activeMeeting, ["guildId"]);
  } catch (error) {
    for (const TableName of created)
      await client.send(new DeleteTableCommand({ TableName }));
    client.destroy();
    throw error;
  }
  return {
    client,
    tables,
    put,
    read,
    admit,
    updates: createDynamoMeetingUpdateDeliveryRepository(client, tables),
    publication: createDynamoMeetingPublicationRepository(
      client,
      tables.meetingHistory,
    ),
    original: createDynamoDeploymentControlRepository(client, tables),
    async close() {
      for (const TableName of created)
        await client.send(new DeleteTableCommand({ TableName }));
      client.destroy();
    },
  };
}
