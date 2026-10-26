import {
  DynamoDBClient,
  UpdateItemCommand,
  type UpdateItemCommandInput,
} from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import { z } from "zod";
import { MEETING_STATUS } from "../src/types/meetingLifecycle";
const artifactFields = z
  .object({
    channelId: z.string().min(1).optional(),
    duration: z.number().finite().nonnegative().optional(),
    endReason: z.string().optional(),
    endedAt: z.string().optional(),
    status: z.enum(MEETING_STATUS).optional(),
    transcriptS3Key: z.string().min(1).optional(),
    chatS3Key: z.string().min(1).optional(),
  })
  .strict();
const identity = z.object({
  guildId: z.string().min(1),
  channelId_timestamp: z.string().min(1),
  meetingId: z.string().min(1),
});
const observedFields = [
  "meetingId",
  "ownerInstanceId",
  "executionVersion",
  "status",
  "checkpoint",
  "recovery",
  "completionPolicy",
  "publicationRepair",
  "channelId",
  "duration",
  "endReason",
  "endedAt",
  "transcriptS3Key",
  "chatS3Key",
] as const;
type Input = {
  client: DynamoDBClient;
  table: string;
  before: Record<string, unknown>;
  fields: Record<string, unknown>;
};
export function buildRecoveredArtifactUpdate(
  input: Omit<Input, "client">,
): UpdateItemCommandInput {
  const key = identity.parse(input.before);
  const fields = Object.entries(artifactFields.parse(input.fields)).filter(
    ([, value]) => value !== undefined,
  );
  if (!fields.length) throw new Error("Artifact repair has no fields");
  const names: Record<string, string> = {},
    values: Record<string, unknown> = {};
  const conditions = observedFields.map((field, index) => {
    const name = "#observed" + index,
      value = ":observed" + index;
    names[name] = field;
    if (input.before[field] === undefined)
      return "attribute_not_exists(" + name + ")";
    values[value] = input.before[field];
    return name + " = " + value;
  });
  const updates = fields.map(([field, value], index) => {
    const name = "#artifact" + index,
      token = ":artifact" + index;
    names[name] = field;
    values[token] = value;
    return name + " = " + token;
  });
  return {
    TableName: input.table,
    Key: marshall({
      guildId: key.guildId,
      channelId_timestamp: key.channelId_timestamp,
    }),
    ConditionExpression:
      "attribute_exists(guildId) AND attribute_exists(channelId_timestamp) AND " +
      conditions.join(" AND "),
    UpdateExpression: "SET " + updates.join(", "),
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: marshall(values, {
      removeUndefinedValues: true,
    }),
  };
}
export async function writeRecoveredArtifactHistory(
  input: Input,
): Promise<void> {
  await input.client.send(
    new UpdateItemCommand(buildRecoveredArtifactUpdate(input)),
  );
}
