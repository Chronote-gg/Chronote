import { GetItemCommand, ScanCommand } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { z } from "zod";
import type {
  ShareIndexInventoryPage,
  ShareIndexRepairOptions,
} from "../services/meetingShareIndexRepairService";
import type { MeetingUserIndexRecord } from "../types/db";
import type { GuildShareIndexMetadata } from "../types/meetingBrowse";
import { dynamoDbClient, tableName } from "./dynamoClient";

/** Exact targets used by the manual repair. No client or provider call. */
export const meetingShareIndexRepairTarget = () => ({
  historyTable: tableName("MeetingHistoryTable"),
  indexTable: tableName("MeetingUserIndexTable"),
  region: "us-east-1",
});

const guildShareMetadataSchema = z.object({
  guildId: z.string().min(1),
  channelId_timestamp: z.string().min(1),
  meetingId: z.string().min(1),
  timestamp: z.string().min(1),
  ownershipScope: z.enum(["personal", "guild"]).optional(),
  ownerUserId: z.string().optional(),
  accessGrants: z
    .array(
      z.discriminatedUnion("targetType", [
        z.object({
          targetType: z.literal("guild"),
          guildId: z.string().min(1),
          role: z.enum(["viewer", "editor"]).optional(),
          sharedAt: z.string().optional(),
          sharedByUserId: z.string().optional(),
        }),
        z.object({
          targetType: z.literal("user"),
          userId: z.string().min(1),
          role: z.enum(["viewer", "editor"]).optional(),
          sharedAt: z.string().optional(),
          sharedByUserId: z.string().optional(),
        }),
      ]),
    )
    .optional(),
});
const guildShareMetadataNames = {
  "#guild": "guildId",
  "#key": "channelId_timestamp",
  "#meeting": "meetingId",
  "#timestamp": "timestamp",
  "#scope": "ownershipScope",
  "#owner": "ownerUserId",
  "#grants": "accessGrants",
};
const guildShareMetadataProjection = Object.keys(guildShareMetadataNames).join(
  ", ",
);

export async function inventoryGuildShareIndexMetadataPage(
  options: Pick<ShareIndexRepairOptions, "cursor" | "limit" | "signal">,
): Promise<ShareIndexInventoryPage> {
  if (
    !Number.isInteger(options.limit) ||
    options.limit < 1 ||
    options.limit > 100
  )
    throw new Error("Page limit must be between 1 and 100");
  options.signal?.throwIfAborted();
  const result = await dynamoDbClient.send(
    new ScanCommand({
      TableName: tableName("MeetingHistoryTable"),
      Limit: options.limit,
      ExclusiveStartKey: options.cursor,
      ProjectionExpression: guildShareMetadataProjection,
      ExpressionAttributeNames: guildShareMetadataNames,
      FilterExpression:
        "attribute_exists(#grants) AND (#scope = :personal OR begins_with(#guild, :prefix))",
      ExpressionAttributeValues: {
        ":personal": { S: "personal" },
        ":prefix": { S: "personal:" },
      },
    }),
    { abortSignal: options.signal },
  );
  return {
    items: (result.Items ?? []).map((item) =>
      guildShareMetadataSchema.parse(unmarshall(item)),
    ),
    examined: result.ScannedCount ?? 0,
    nextCursor: result.LastEvaluatedKey,
  };
}

export async function getGuildShareIndexMetadataStrong(
  key: Pick<GuildShareIndexMetadata, "guildId" | "channelId_timestamp">,
  signal?: AbortSignal,
): Promise<GuildShareIndexMetadata | undefined> {
  signal?.throwIfAborted();
  const result = await dynamoDbClient.send(
    new GetItemCommand({
      TableName: tableName("MeetingHistoryTable"),
      Key: marshall({
        guildId: key.guildId,
        channelId_timestamp: key.channelId_timestamp,
      }),
      ConsistentRead: true,
      ProjectionExpression: guildShareMetadataProjection,
      ExpressionAttributeNames: guildShareMetadataNames,
    }),
    { abortSignal: signal },
  );
  return result.Item
    ? guildShareMetadataSchema.parse(unmarshall(result.Item))
    : undefined;
}

export async function meetingUserIndexPointerExistsStrong(
  key: Pick<MeetingUserIndexRecord, "userId" | "userTimestamp">,
  signal?: AbortSignal,
): Promise<boolean> {
  signal?.throwIfAborted();
  const result = await dynamoDbClient.send(
    new GetItemCommand({
      TableName: tableName("MeetingUserIndexTable"),
      Key: marshall({ userId: key.userId, userTimestamp: key.userTimestamp }),
      ConsistentRead: true,
      ProjectionExpression: "userId, userTimestamp",
    }),
    { abortSignal: signal },
  );
  return Boolean(result.Item);
}
