import { describe, expect, it, jest } from "@jest/globals";
import {
  ConditionalCheckFailedException,
  DescribeTableCommand,
  type DynamoDBClient,
  PutItemCommand,
  QueryCommand,
  ResourceNotFoundException,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import {
  createAnnouncementDeliveryStore,
  DeliveryTableMissingError,
  type DeliveryRecord,
} from "../../../src/services/announcements/announcementDeliveryStore";

const TABLE = "test-AnnouncementDeliveryTable";
const ANNOUNCEMENT_ID = "incident-2026-11-04";
const GUILD_ID = "100000000000000001";
const CHANNEL_ID = "100000000000000011";
const MESSAGE_ID = "100000000000000031";
const CREATED_AT = "2026-11-04T10:00:00.000Z";
const NOW = new Date("2026-11-04T10:00:05.000Z");

const claim = {
  announcementId: ANNOUNCEMENT_ID,
  guildId: GUILD_ID,
  channelId: CHANNEL_ID,
  channelSource: "public_updates" as const,
  previewSha256: "a".repeat(64),
  createdAt: CREATED_AT,
};

const missingTable = () =>
  new ResourceNotFoundException({ message: "missing", $metadata: {} });

function setup(results: Array<unknown>) {
  const commands: unknown[] = [];
  const send = jest.fn(async (command: unknown) => {
    commands.push(command);
    const next = results.shift();
    if (next instanceof Error) throw next;
    return next ?? {};
  });
  const store = createAnnouncementDeliveryStore({
    dynamo: { send } as unknown as DynamoDBClient,
    tableName: TABLE,
  });
  return { store, commands, send };
}

describe("announcement delivery store", () => {
  it("claims a new pending record only when none exists", async () => {
    const { store, commands } = setup([{}]);
    await expect(
      store.claimPending(claim, { replaceFailed: false }),
    ).resolves.toBe("claimed");
    const command = commands[0] as PutItemCommand;
    expect(command).toBeInstanceOf(PutItemCommand);
    expect(command.input).toEqual({
      TableName: TABLE,
      Item: marshall({ ...claim, status: "pending", updatedAt: CREATED_AT }),
      ConditionExpression: "attribute_not_exists(announcementId)",
    });
  });

  it("may replace a failed record when asked", async () => {
    const { store, commands } = setup([{}]);
    await store.claimPending(claim, { replaceFailed: true });
    expect((commands[0] as PutItemCommand).input).toMatchObject({
      ConditionExpression:
        "attribute_not_exists(announcementId) OR #status = :failed",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":failed": { S: "failed" } },
    });
  });

  it("reports an existing record as exists", async () => {
    const { store } = setup([
      new ConditionalCheckFailedException({ message: "exists", $metadata: {} }),
    ]);
    await expect(
      store.claimPending(claim, { replaceFailed: false }),
    ).resolves.toBe("exists");
  });

  it("propagates other claim errors", async () => {
    const failure = new Error("throttled");
    const { store } = setup([failure]);
    await expect(
      store.claimPending(claim, { replaceFailed: false }),
    ).rejects.toBe(failure);
  });

  it("marks a pending record sent with its message id", async () => {
    const { store, commands } = setup([{}]);
    await store.markSent(ANNOUNCEMENT_ID, GUILD_ID, MESSAGE_ID, NOW);
    const command = commands[0] as UpdateItemCommand;
    expect(command).toBeInstanceOf(UpdateItemCommand);
    expect(command.input).toEqual({
      TableName: TABLE,
      Key: marshall({ announcementId: ANNOUNCEMENT_ID, guildId: GUILD_ID }),
      UpdateExpression:
        "SET #status = :sent, messageId = :messageId, updatedAt = :updatedAt",
      ConditionExpression: "#status = :pending",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: marshall({
        ":sent": "sent",
        ":pending": "pending",
        ":messageId": MESSAGE_ID,
        ":updatedAt": NOW.toISOString(),
      }),
    });
  });

  it("marks a pending record failed with its reason", async () => {
    const { store, commands } = setup([{}]);
    await store.markFailed(ANNOUNCEMENT_ID, GUILD_ID, "http_403", NOW);
    expect((commands[0] as UpdateItemCommand).input).toEqual({
      TableName: TABLE,
      Key: marshall({ announcementId: ANNOUNCEMENT_ID, guildId: GUILD_ID }),
      UpdateExpression:
        "SET #status = :failed, #reason = :reason, updatedAt = :updatedAt",
      ConditionExpression: "#status = :pending",
      ExpressionAttributeNames: { "#status": "status", "#reason": "reason" },
      ExpressionAttributeValues: marshall({
        ":failed": "failed",
        ":pending": "pending",
        ":reason": "http_403",
        ":updatedAt": NOW.toISOString(),
      }),
    });
  });

  it("lists every record for an announcement across pages", async () => {
    const sent: DeliveryRecord = {
      ...claim,
      status: "sent",
      messageId: MESSAGE_ID,
      updatedAt: CREATED_AT,
    };
    const pending: DeliveryRecord = {
      ...claim,
      guildId: "100000000000000002",
      status: "pending",
      updatedAt: CREATED_AT,
    };
    const lastKey = marshall({
      announcementId: ANNOUNCEMENT_ID,
      guildId: GUILD_ID,
    });
    const { store, commands } = setup([
      { Items: [marshall(sent)], LastEvaluatedKey: lastKey },
      { Items: [marshall(pending)] },
    ]);
    await expect(store.listForAnnouncement(ANNOUNCEMENT_ID)).resolves.toEqual([
      sent,
      pending,
    ]);
    const queries = commands as QueryCommand[];
    expect(queries[0]).toBeInstanceOf(QueryCommand);
    expect(queries[0].input).toEqual({
      TableName: TABLE,
      KeyConditionExpression: "announcementId = :announcementId",
      ExpressionAttributeValues: marshall({
        ":announcementId": ANNOUNCEMENT_ID,
      }),
      ConsistentRead: true,
      ExclusiveStartKey: undefined,
    });
    expect(queries[1].input.ExclusiveStartKey).toEqual(lastKey);
  });

  it("maps a missing table on list to DeliveryTableMissingError", async () => {
    const { store } = setup([missingTable()]);
    await expect(
      store.listForAnnouncement(ANNOUNCEMENT_ID),
    ).rejects.toBeInstanceOf(DeliveryTableMissingError);
  });

  it("asserts the table exists with DescribeTable", async () => {
    const { store, commands } = setup([{ Table: { TableName: TABLE } }]);
    await expect(store.assertTableExists()).resolves.toBeUndefined();
    expect(commands[0]).toBeInstanceOf(DescribeTableCommand);
    expect((commands[0] as DescribeTableCommand).input).toEqual({
      TableName: TABLE,
    });
  });

  it("names the Terraform apply when the table is missing", async () => {
    const { store } = setup([missingTable()]);
    const error = await store
      .assertTableExists()
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DeliveryTableMissingError);
    expect((error as Error).message).toContain("apply the Terraform change");
  });

  it("propagates other DescribeTable errors", async () => {
    const failure = new Error("access denied");
    const { store } = setup([failure]);
    await expect(store.assertTableExists()).rejects.toBe(failure);
  });
});
