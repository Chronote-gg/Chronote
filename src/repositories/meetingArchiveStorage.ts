import {
  DynamoDBClient,
  GetItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { PublicationArchiveConflict } from "../types/meetingPublication";
export async function updateMeetingArchiveInDynamo(
  client: DynamoDBClient,
  table: string,
  params: {
    guildId: string;
    channelId_timestamp: string;
    archived: boolean;
    archivedByUserId: string;
  },
): Promise<boolean> {
  const now = new Date().toISOString();
  const updateParts = ["#updatedAt = :updatedAt"];
  const removeParts: string[] = [];
  const expressionAttributeNames: Record<string, string> = {
    "#updatedAt": "updatedAt",
    "#channelIdTimestamp": "channelId_timestamp",
    "#publicationRepair": "publicationRepair",
    "#publicationKind": "kind",
  };
  const values: Record<string, unknown> = {
    ":updatedAt": now,
    ":runningPublication": "running",
  };

  if (params.archived) {
    updateParts.push("#archivedAt = :archivedAt");
    updateParts.push("#archivedByUserId = :archivedByUserId");
    expressionAttributeNames["#archivedAt"] = "archivedAt";
    expressionAttributeNames["#archivedByUserId"] = "archivedByUserId";
    values[":archivedAt"] = now;
    values[":archivedByUserId"] = params.archivedByUserId;
  } else {
    removeParts.push("#archivedAt", "#archivedByUserId");
    expressionAttributeNames["#archivedAt"] = "archivedAt";
    expressionAttributeNames["#archivedByUserId"] = "archivedByUserId";
  }

  const updateExpression = [
    `SET ${updateParts.join(", ")}`,
    removeParts.length > 0 ? `REMOVE ${removeParts.join(", ")}` : null,
  ]
    .filter(Boolean)
    .join(" ");

  const request: UpdateItemCommand["input"] = {
    TableName: table,
    Key: marshall({
      guildId: params.guildId,
      channelId_timestamp: params.channelId_timestamp,
    }),
    UpdateExpression: updateExpression,
    ExpressionAttributeNames: expressionAttributeNames,
    ExpressionAttributeValues: marshall(values, {
      removeUndefinedValues: true,
    }),
    ConditionExpression:
      "attribute_exists(#channelIdTimestamp) AND (attribute_not_exists(#publicationRepair.#publicationKind) OR #publicationRepair.#publicationKind <> :runningPublication)",
  };

  const command = new UpdateItemCommand(request);
  try {
    await client.send(command);
    return true;
  } catch (error) {
    if (
      (error as { name?: string }).name === "ConditionalCheckFailedException"
    ) {
      const current = await client.send(
        new GetItemCommand({
          TableName: table,
          Key: marshall({
            guildId: params.guildId,
            channelId_timestamp: params.channelId_timestamp,
          }),
          ConsistentRead: true,
        }),
      );
      if (
        current.Item &&
        unmarshall(current.Item).publicationRepair?.kind === "running"
      )
        throw new PublicationArchiveConflict();
      return false;
    }
    console.error("Failed to update meeting archive:", error);
    return false;
  }
}
