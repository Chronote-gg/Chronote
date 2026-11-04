import {
  type AttributeValue,
  type DynamoDBClient,
  QueryCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { CONFIG_KEYS } from "../../config/keys";
import { isSnowflake } from "./announcementTypes";

export type GuildAnnouncementSettings = {
  optedOut: boolean;
  notesChannelId: string | null;
};

/**
 * Reads a server's announcement settings straight from the config overrides
 * table, so the operator command never loads the application config service.
 */
export function createAnnouncementSettingsReader({
  dynamo,
  tableName,
}: {
  dynamo: DynamoDBClient;
  tableName: string;
}): { read(guildId: string): Promise<GuildAnnouncementSettings> } {
  return {
    read: async (guildId) => {
      if (!isSnowflake(guildId))
        throw new Error("guildId is not a Discord snowflake id");
      const values = new Map<unknown, unknown>();
      let startKey: Record<string, AttributeValue> | undefined;
      do {
        const page = await dynamo.send(
          new QueryCommand({
            TableName: tableName,
            KeyConditionExpression: "scopeId = :scopeId",
            ExpressionAttributeValues: marshall({
              ":scopeId": `server#${guildId}`,
            }),
            ConsistentRead: true,
            ExclusiveStartKey: startKey,
          }),
        );
        for (const item of page.Items ?? []) {
          const { configKey, value } = unmarshall(item);
          values.set(configKey, value);
        }
        startKey = page.LastEvaluatedKey;
      } while (startKey);
      const enabled = values.get(
        CONFIG_KEYS.announcements.operatorNoticesEnabled,
      );
      const notesChannelId = values.get(CONFIG_KEYS.notes.channelId);
      return {
        optedOut: enabled === false || enabled === "false",
        notesChannelId: isSnowflake(notesChannelId) ? notesChannelId : null,
      };
    },
  };
}
