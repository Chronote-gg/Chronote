import {
  PutItemCommand,
  DeleteItemCommand,
  QueryCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import type { MeetingUserIndexRecord } from "../types/db";
import { assertRawMeetingIndexUserId } from "../utils/meetingUserIndex";
import { dynamoDbClient, tableName } from "./dynamoClient";
const MEETING_USER_INDEX_WRITE_BATCH_SIZE = 25;

export async function writeMeetingUserIndexRecords(
  records: MeetingUserIndexRecord[],
): Promise<void> {
  for (const record of records) {
    if ("accessReason" in record && record.accessReason === "guild_share") {
      if (!record.userId.startsWith("GUILD_SHARE#"))
        throw new Error("Invalid guild share principal");
    } else {
      assertRawMeetingIndexUserId(record.userId);
    }
  }
  for (
    let index = 0;
    index < records.length;
    index += MEETING_USER_INDEX_WRITE_BATCH_SIZE
  ) {
    await Promise.all(
      records
        .slice(index, index + MEETING_USER_INDEX_WRITE_BATCH_SIZE)
        .map((record) =>
          dynamoDbClient.send(
            new PutItemCommand({
              TableName: tableName("MeetingUserIndexTable"),
              Item: marshall(record, { removeUndefinedValues: true }),
            }),
          ),
        ),
    );
  }
}

export async function deleteMeetingUserIndexRecords(
  records: Pick<MeetingUserIndexRecord, "userId" | "userTimestamp">[],
): Promise<void> {
  for (
    let index = 0;
    index < records.length;
    index += MEETING_USER_INDEX_WRITE_BATCH_SIZE
  ) {
    await Promise.all(
      records
        .slice(index, index + MEETING_USER_INDEX_WRITE_BATCH_SIZE)
        .map((record) =>
          dynamoDbClient.send(
            new DeleteItemCommand({
              TableName: tableName("MeetingUserIndexTable"),
              Key: marshall({
                userId: record.userId,
                userTimestamp: record.userTimestamp,
              }),
            }),
          ),
        ),
    );
  }
}

export async function getMeetingUserIndexRecordsForUserInRange(
  userId: string,
  startTimestamp: string,
  endTimestamp: string,
  limit?: number,
): Promise<MeetingUserIndexRecord[]> {
  assertRawMeetingIndexUserId(userId);
  if (limit !== undefined && limit <= 0) return [];

  const items: MeetingUserIndexRecord[] = [];
  let lastKey: Record<string, AttributeValue> | undefined;

  do {
    const remaining = limit === undefined ? undefined : limit - items.length;
    const params = {
      TableName: tableName("MeetingUserIndexTable"),
      KeyConditionExpression:
        "userId = :userId AND userTimestamp BETWEEN :start AND :end",
      ExpressionAttributeValues: marshall({
        ":userId": userId,
        ":start": `${startTimestamp}#`,
        ":end": `${endTimestamp}#\uffff`,
      }),
      ExclusiveStartKey: lastKey,
      ScanIndexForward: false,
      ...(remaining !== undefined && remaining > 0 ? { Limit: remaining } : {}),
    };
    const command = new QueryCommand(params);
    const result = await dynamoDbClient.send(command);
    if (result.Items) {
      items.push(
        ...result.Items.map(
          (item) => unmarshall(item) as MeetingUserIndexRecord,
        ),
      );
    }
    lastKey = result.LastEvaluatedKey;
  } while (lastKey && (limit === undefined || items.length < limit));

  return limit === undefined ? items : items.slice(0, limit);
}
