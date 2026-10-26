"use strict";
const { z } = require("zod");
const { isDeepStrictEqual } = require("node:util");
const { DescribeTableCommand } = require("@aws-sdk/client-dynamodb");
const INDEX = "UpdateDeliveryDueIndex";
const attributes = [
  { AttributeName: "updateDeliveryDueAt", AttributeType: "N" },
  { AttributeName: "updateDeliveryQueue", AttributeType: "S" },
];
const keys = [
  { AttributeName: "updateDeliveryDueAt", KeyType: "RANGE" },
  { AttributeName: "updateDeliveryQueue", KeyType: "HASH" },
];
const metadataObjects = z.array(z.record(z.string(), z.unknown())).max(100);
const byAttribute = (a, b) => a.AttributeName.localeCompare(b.AttributeName);
function selectedIndex(raw) {
  const selected = metadataObjects
    .parse(raw)
    .filter((i) => i.IndexName === INDEX);
  return z
    .array(
      z.object({
        IndexName: z.literal(INDEX),
        IndexStatus: z.literal("ACTIVE"),
        KeySchema: z
          .array(
            z.object({
              AttributeName: z.string().max(255),
              KeyType: z.enum(["HASH", "RANGE"]),
            }),
          )
          .length(2),
        Projection: z
          .object({ ProjectionType: z.literal("KEYS_ONLY") })
          .strict(),
      }),
    )
    .length(1)
    .parse(selected);
}
function projectMeetingUpdateIndex(response, manifest) {
  try {
    const TableName = manifest.resources.tables.meetingHistory;
    const raw = response.Table;
    const identity = z
      .object({
        TableName: z.literal(TableName),
        TableArn: z.literal(
          `arn:aws:dynamodb:${manifest.identity.region}:${manifest.identity.accountId}:table/${TableName}`,
        ),
        TableStatus: z.literal("ACTIVE"),
      })
      .parse(raw);
    const selected = metadataObjects
      .parse(raw.AttributeDefinitions)
      .filter((a) =>
        attributes.some(
          (expected) => expected.AttributeName === a.AttributeName,
        ),
      );
    const AttributeDefinitions = z
      .array(
        z.object({
          AttributeName: z.string().max(255),
          AttributeType: z.enum(["S", "N", "B"]),
        }),
      )
      .length(2)
      .parse(selected);
    const GlobalSecondaryIndexes = selectedIndex(raw.GlobalSecondaryIndexes);
    if (
      !isDeepStrictEqual(
        [...AttributeDefinitions].sort(byAttribute),
        attributes,
      ) ||
      !isDeepStrictEqual(
        [...GlobalSecondaryIndexes[0].KeySchema].sort(byAttribute),
        keys,
      )
    )
      throw Error("schema");
    return {
      Table: { ...identity, AttributeDefinitions, GlobalSecondaryIndexes },
    };
  } catch {
    throw Error("meeting_update_index_prerequisite");
  }
}
async function readMeetingUpdateIndex(client, manifest, input, query) {
  if (
    !isDeepStrictEqual(input, {
      TableName: manifest.resources.tables.meetingHistory,
    }) ||
    query !== undefined
  )
    throw Error("metadata_read_refused");
  return projectMeetingUpdateIndex(
    await client.send(
      new DescribeTableCommand({
        TableName: manifest.resources.tables.meetingHistory,
      }),
    ),
    manifest,
  );
}
async function assertMeetingUpdateIndex(manifest, aws) {
  projectMeetingUpdateIndex(
    await aws("dynamodb", "describe-table", {
      TableName: manifest.resources.tables.meetingHistory,
    }),
    manifest,
  );
}
module.exports = {
  INDEX,
  projectMeetingUpdateIndex,
  readMeetingUpdateIndex,
  assertMeetingUpdateIndex,
};
