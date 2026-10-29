import { GetItemCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { config } from "../services/configService";
import { dynamoDbClient, tableName } from "./dynamoClient";

// Immutable ephemeral browse snapshots use their own namespace, never login sessions.
const mockMeetingBrowseStates = new Map<
  string,
  { payload: unknown; expiresAt: number }
>();
export async function putMeetingBrowseCursorState(
  id: string,
  payload: unknown,
  expiresAt: number,
): Promise<void> {
  const sid = `MEETING_BROWSE_CURSOR#${id}`;
  if (config.mock.enabled) {
    if (mockMeetingBrowseStates.has(sid))
      throw new Error("Browse snapshot already exists");
    const now = Date.now();
    for (const [key, state] of mockMeetingBrowseStates)
      if (state.expiresAt <= now) mockMeetingBrowseStates.delete(key);
    mockMeetingBrowseStates.set(sid, {
      payload: structuredClone(payload),
      expiresAt,
    });
    return;
  }
  await dynamoDbClient.send(
    new PutItemCommand({
      TableName: tableName("SessionTable"),
      Item: marshall(
        { sid, payload, expiresAt: Math.ceil(expiresAt / 1000) },
        { removeUndefinedValues: true },
      ),
      ConditionExpression: "attribute_not_exists(sid)",
    }),
  );
}
export async function getMeetingBrowseCursorState(
  id: string,
  now = Date.now(),
): Promise<unknown> {
  const sid = `MEETING_BROWSE_CURSOR#${id}`;
  if (config.mock.enabled) {
    const state = mockMeetingBrowseStates.get(sid);
    return state && state.expiresAt > now
      ? structuredClone(state.payload)
      : undefined;
  }
  const result = await dynamoDbClient.send(
    new GetItemCommand({
      TableName: tableName("SessionTable"),
      Key: marshall({ sid }),
      ConsistentRead: true,
    }),
  );
  if (!result.Item) return undefined;
  const row = unmarshall(result.Item);
  return typeof row.expiresAt === "number" && row.expiresAt * 1000 > now
    ? row.payload
    : undefined;
}
