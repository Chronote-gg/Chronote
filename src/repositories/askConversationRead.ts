import { GetItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import type { AskConversationRecord } from "../types/db";
import { dynamoDbClient, tableName } from "./dynamoClient";

export async function getAskConversation(
  userId: string,
  guildId: string,
  conversationId: string,
): Promise<AskConversationRecord | undefined> {
  const pk = `USER#${userId}#GUILD#${guildId}`;
  const sk = `CONV#${conversationId}`;
  const params = {
    TableName: tableName("AskConversationTable"),
    Key: marshall({ pk, sk }),
    ConsistentRead: true,
  };
  const command = new GetItemCommand(params);
  const result = await dynamoDbClient.send(command);
  if (result.Item) {
    return unmarshall(result.Item) as AskConversationRecord;
  }
  return undefined;
}
