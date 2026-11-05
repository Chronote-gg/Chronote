import {
  type AttributeValue,
  DescribeTableCommand,
  type DynamoDBClient,
  PutItemCommand,
  QueryCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { z } from "zod";
import type { ChannelSource } from "./announcementTypes";

export type DeliveryStatus = "pending" | "sent" | "failed";
export type DeliveryRecord = {
  announcementId: string;
  guildId: string;
  channelId: string;
  channelSource: ChannelSource;
  status: DeliveryStatus;
  messageId?: string;
  reason?: string;
  previewSha256: string;
  createdAt: string;
  updatedAt: string;
};

export type AnnouncementDeliveryStore = {
  assertTableExists(): Promise<void>;
  listForAnnouncement(announcementId: string): Promise<DeliveryRecord[]>;
  claimPending(
    record: Omit<
      DeliveryRecord,
      "status" | "messageId" | "reason" | "updatedAt"
    >,
    options: { replaceFailed: boolean },
  ): Promise<"claimed" | "exists">;
  markSent(
    announcementId: string,
    guildId: string,
    messageId: string,
    now: Date,
  ): Promise<void>;
  markFailed(
    announcementId: string,
    guildId: string,
    reason: string,
    now: Date,
  ): Promise<void>;
};

/** The delivery table is absent, so the Terraform change has not been applied. */
export class DeliveryTableMissingError extends Error {
  override name = "DeliveryTableMissingError";
}

const deliveryRecordSchema = z.object({
  announcementId: z.string(),
  guildId: z.string(),
  channelId: z.string(),
  channelSource: z.enum(["public_updates", "notes", "system", "owner_dm"]),
  status: z.enum(["pending", "sent", "failed"]),
  messageId: z.string().optional(),
  reason: z.string().optional(),
  previewSha256: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const isNamed = (error: unknown, name: string) =>
  error instanceof Error && error.name === name;

export function createAnnouncementDeliveryStore({
  dynamo,
  tableName,
}: {
  dynamo: DynamoDBClient;
  tableName: string;
}): AnnouncementDeliveryStore {
  const tableMissing = (cause: unknown) =>
    new DeliveryTableMissingError(
      `Delivery table ${tableName} does not exist; apply the Terraform change that adds AnnouncementDeliveryTable before sending.`,
      { cause },
    );
  const orTableMissing = (error: unknown): never => {
    throw isNamed(error, "ResourceNotFoundException")
      ? tableMissing(error)
      : error;
  };
  const markPending = async (
    announcementId: string,
    guildId: string,
    set: string,
    names: Record<string, string>,
    values: Record<string, string>,
  ) => {
    await dynamo.send(
      new UpdateItemCommand({
        TableName: tableName,
        Key: marshall({ announcementId, guildId }),
        UpdateExpression: set,
        ConditionExpression: "#status = :pending",
        ExpressionAttributeNames: { "#status": "status", ...names },
        ExpressionAttributeValues: marshall({
          ...values,
          ":pending": "pending",
        }),
      }),
    );
  };

  return {
    assertTableExists: async () => {
      await dynamo
        .send(new DescribeTableCommand({ TableName: tableName }))
        .catch(orTableMissing);
    },
    listForAnnouncement: async (announcementId) => {
      const records: DeliveryRecord[] = [];
      let startKey: Record<string, AttributeValue> | undefined;
      do {
        const page = await dynamo
          .send(
            new QueryCommand({
              TableName: tableName,
              KeyConditionExpression: "announcementId = :announcementId",
              ExpressionAttributeValues: marshall({
                ":announcementId": announcementId,
              }),
              ConsistentRead: true,
              ExclusiveStartKey: startKey,
            }),
          )
          .catch(orTableMissing);
        for (const item of page.Items ?? [])
          records.push(deliveryRecordSchema.parse(unmarshall(item)));
        startKey = page.LastEvaluatedKey;
      } while (startKey);
      return records;
    },
    claimPending: async (record, { replaceFailed }) => {
      try {
        await dynamo.send(
          new PutItemCommand({
            TableName: tableName,
            Item: marshall({
              ...record,
              status: "pending",
              updatedAt: record.createdAt,
            }),
            ...(replaceFailed
              ? {
                  ConditionExpression:
                    "attribute_not_exists(announcementId) OR #status = :failed",
                  ExpressionAttributeNames: { "#status": "status" },
                  ExpressionAttributeValues: marshall({ ":failed": "failed" }),
                }
              : {
                  ConditionExpression: "attribute_not_exists(announcementId)",
                }),
          }),
        );
        return "claimed";
      } catch (error) {
        if (isNamed(error, "ConditionalCheckFailedException")) return "exists";
        return orTableMissing(error);
      }
    },
    markSent: (announcementId, guildId, messageId, now) =>
      markPending(
        announcementId,
        guildId,
        "SET #status = :sent, messageId = :messageId, updatedAt = :updatedAt",
        {},
        {
          ":sent": "sent",
          ":messageId": messageId,
          ":updatedAt": now.toISOString(),
        },
      ),
    markFailed: (announcementId, guildId, reason, now) =>
      markPending(
        announcementId,
        guildId,
        "SET #status = :failed, #reason = :reason, updatedAt = :updatedAt",
        { "#reason": "reason" },
        {
          ":failed": "failed",
          ":reason": reason,
          ":updatedAt": now.toISOString(),
        },
      ),
  };
}
