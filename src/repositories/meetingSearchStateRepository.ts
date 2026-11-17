import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  ScanCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import type {
  MeetingSearchProjectionState,
  MeetingSearchStateRepository,
  SearchProjectionKey,
} from "../types/meetingSearchProjection";

const encodeCursor = (key?: Record<string, AttributeValue>) =>
  key ? Buffer.from(JSON.stringify(key)).toString("base64url") : undefined;
const decodeCursor = (cursor?: string) =>
  cursor
    ? (JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<
        string,
        AttributeValue
      >)
    : undefined;

export function createMeetingSearchStateRepository(
  client: DynamoDBClient,
  tableName: string,
): MeetingSearchStateRepository & {
  checkpoint(
    generation: string,
  ): Promise<{ historyCursor?: string; stateCursor?: string }>;
  saveCheckpoint(
    generation: string,
    value: { historyCursor?: string; stateCursor?: string },
  ): Promise<void>;
} {
  return {
    async get(projectionId) {
      const result = await client.send(
        new GetItemCommand({
          TableName: tableName,
          Key: marshall({ projectionId }),
          ConsistentRead: true,
        }),
      );
      return result.Item
        ? (unmarshall(result.Item) as MeetingSearchProjectionState)
        : undefined;
    },
    async put(state) {
      await client.send(
        new PutItemCommand({
          TableName: tableName,
          Item: marshall(
            {
              ...state,
              projectionRef: JSON.stringify([
                state.generation,
                state.meeting.guildId,
                state.meeting.channelId_timestamp,
              ]),
            },
            { removeUndefinedValues: true },
          ),
        }),
      );
    },
    async list(meeting: SearchProjectionKey, generation: string) {
      const items: MeetingSearchProjectionState[] = [];
      let cursor: Record<string, AttributeValue> | undefined;
      do {
        const page = await client.send(
          new QueryCommand({
            TableName: tableName,
            IndexName: "ProjectionMeetingIndex",
            KeyConditionExpression: "projectionRef = :ref",
            ExpressionAttributeValues: marshall({
              ":ref": JSON.stringify([
                generation,
                meeting.guildId,
                meeting.channelId_timestamp,
              ]),
            }),
            ExclusiveStartKey: cursor,
          }),
        );
        items.push(
          ...(page.Items ?? []).map(
            (item) => unmarshall(item) as MeetingSearchProjectionState,
          ),
        );
        cursor = page.LastEvaluatedKey;
      } while (cursor);
      return items;
    },
    async scan(cursor) {
      const page = await client.send(
        new ScanCommand({
          TableName: tableName,
          Limit: 5,
          ExclusiveStartKey: decodeCursor(cursor),
          FilterExpression:
            "attribute_exists(generation) AND attribute_exists(meeting)",
        }),
      );
      return {
        items: (page.Items ?? []).map(
          (item) => unmarshall(item) as MeetingSearchProjectionState,
        ),
        cursor: encodeCursor(page.LastEvaluatedKey),
      };
    },
    async checkpoint(generation) {
      const page = await client.send(
        new GetItemCommand({
          TableName: tableName,
          Key: marshall({ projectionId: `CHECKPOINT#${generation}` }),
          ConsistentRead: true,
        }),
      );
      return page.Item
        ? (unmarshall(page.Item) as {
            historyCursor?: string;
            stateCursor?: string;
          })
        : {};
    },
    async saveCheckpoint(generation, value) {
      await client.send(
        new PutItemCommand({
          TableName: tableName,
          Item: marshall(
            {
              projectionId: `CHECKPOINT#${generation}`,
              ...value,
            },
            { removeUndefinedValues: true },
          ),
        }),
      );
    },
  };
}

export {
  encodeCursor as encodeSearchProjectionCursor,
  decodeCursor as decodeSearchProjectionCursor,
};
