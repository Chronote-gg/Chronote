import { QueryCommand, type QueryCommandInput } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import type { MeetingHistory, MeetingUserIndexRecord } from "../types/db";
import type {
  MeetingBrowsePage,
  MeetingBrowsePageOptions,
} from "../types/meetingBrowse";
import { dynamoDbClient, tableName } from "./dynamoClient";

async function readTimestampPage(
  query: QueryCommandInput,
  options: MeetingBrowsePageOptions,
) {
  options.signal?.throwIfAborted();
  if (!Number.isInteger(options.limit) || options.limit <= 0)
    throw new Error("Page limit must be a positive integer");
  const result = await dynamoDbClient.send(
    new QueryCommand({
      ...query,
      Limit: options.limit,
      ExclusiveStartKey: options.cursor,
      ScanIndexForward: false,
    }),
    { abortSignal: options.signal },
  );
  options.signal?.throwIfAborted();
  return result;
}
export async function getMeetingHistoryTimestampPage(
  guildId: string,
  options: MeetingBrowsePageOptions,
): Promise<MeetingBrowsePage<MeetingHistory>> {
  const result = await readTimestampPage(
    {
      TableName: tableName("MeetingHistoryTable"),
      IndexName: "GuildTimestampIndex",
      KeyConditionExpression:
        "guildId = :guildId AND #timestamp BETWEEN :start AND :end",
      ExpressionAttributeNames: { "#timestamp": "timestamp" },
      ExpressionAttributeValues: marshall({
        ":guildId": guildId,
        ":start": options.startTimestamp,
        ":end": options.endTimestamp,
      }),
    },
    options,
  );
  return {
    items: (result.Items ?? []).map((item) => ({
      record: unmarshall(item) as MeetingHistory,
      cursorAfter: {
        guildId: item.guildId,
        timestamp: item.timestamp,
        channelId_timestamp: item.channelId_timestamp,
      },
    })),
    nextCursor: result.LastEvaluatedKey,
  };
}
export async function getMeetingUserIndexTimestampPage(
  principal: string,
  options: MeetingBrowsePageOptions,
): Promise<MeetingBrowsePage<MeetingUserIndexRecord>> {
  const result = await readTimestampPage(
    {
      TableName: tableName("MeetingUserIndexTable"),
      KeyConditionExpression:
        "userId = :userId AND userTimestamp BETWEEN :start AND :end",
      ExpressionAttributeValues: marshall({
        ":userId": principal,
        ":start": `${options.startTimestamp}#`,
        ":end": `${options.endTimestamp}#\uffff`,
      }),
    },
    options,
  );
  return {
    items: (result.Items ?? []).map((item) => ({
      record: unmarshall(item) as MeetingUserIndexRecord,
      cursorAfter: { userId: item.userId, userTimestamp: item.userTimestamp },
    })),
    nextCursor: result.LastEvaluatedKey,
  };
}
