import { describe, expect, it, jest } from "@jest/globals";
import { type DynamoDBClient, QueryCommand } from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import { createAnnouncementSettingsReader } from "../../../src/services/announcements/announcementSettingsReader";

const TABLE = "test-ConfigOverridesTable";
const GUILD_ID = "100000000000000001";
const NOTES_CHANNEL_ID = "100000000000000012";
const OPT_OUT_KEY = "announcements.operatorNotices.enabled";
const NOTES_KEY = "notes.channelId";

// Mirrors writeConfigOverride in src/db.ts, which marshalls the record as-is,
// so a boolean override is stored as a DynamoDB BOOL.
const override = (configKey: string, value: unknown) =>
  marshall({
    scopeId: `server#${GUILD_ID}`,
    configKey,
    value,
    updatedAt: "2026-11-04T00:00:00.000Z",
    updatedBy: "100000000000000009",
  });

function setup(
  pages: Array<{ Items?: unknown[]; LastEvaluatedKey?: unknown }>,
) {
  const commands: QueryCommand[] = [];
  const send = jest.fn(async (command: QueryCommand) => {
    commands.push(command);
    return pages.shift() ?? {};
  });
  const reader = createAnnouncementSettingsReader({
    dynamo: { send } as unknown as DynamoDBClient,
    tableName: TABLE,
  });
  return { reader, commands };
}

describe("announcement settings reader", () => {
  it("queries the server scope once and defaults to opted in with no notes channel", async () => {
    const { reader, commands } = setup([{ Items: [] }]);
    await expect(reader.read(GUILD_ID)).resolves.toEqual({
      optedOut: false,
      notesChannelId: null,
    });
    expect(commands).toHaveLength(1);
    expect(commands[0]).toBeInstanceOf(QueryCommand);
    expect(commands[0].input).toEqual({
      TableName: TABLE,
      KeyConditionExpression: "scopeId = :scopeId",
      ExpressionAttributeValues: marshall({ ":scopeId": `server#${GUILD_ID}` }),
      ConsistentRead: true,
      ExclusiveStartKey: undefined,
    });
  });

  it.each([
    [false, true],
    ["false", true],
    [true, false],
    ["true", false],
    [0, false],
    ["no", false],
  ])(
    "treats a stored opt-out value of %p as optedOut=%p",
    async (value, optedOut) => {
      const { reader } = setup([{ Items: [override(OPT_OUT_KEY, value)] }]);
      await expect(reader.read(GUILD_ID)).resolves.toMatchObject({ optedOut });
    },
  );

  it("returns a snowflake notes channel and ignores a malformed one", async () => {
    const valid = setup([
      {
        Items: [
          override(NOTES_KEY, NOTES_CHANNEL_ID),
          override(OPT_OUT_KEY, false),
        ],
      },
    ]);
    await expect(valid.reader.read(GUILD_ID)).resolves.toEqual({
      optedOut: true,
      notesChannelId: NOTES_CHANNEL_ID,
    });
    for (const malformed of ["not-a-channel", "123", 12345, null]) {
      const { reader } = setup([{ Items: [override(NOTES_KEY, malformed)] }]);
      await expect(reader.read(GUILD_ID)).resolves.toMatchObject({
        notesChannelId: null,
      });
    }
  });

  it("follows a second page so an opt-out is never missed", async () => {
    const { reader, commands } = setup([
      {
        Items: [override(NOTES_KEY, NOTES_CHANNEL_ID)],
        LastEvaluatedKey: override(NOTES_KEY, NOTES_CHANNEL_ID),
      },
      { Items: [override(OPT_OUT_KEY, false)] },
    ]);
    await expect(reader.read(GUILD_ID)).resolves.toEqual({
      optedOut: true,
      notesChannelId: NOTES_CHANNEL_ID,
    });
    expect(commands).toHaveLength(2);
  });

  it("rejects a non-snowflake guild id without querying", async () => {
    const { reader, commands } = setup([]);
    await expect(reader.read("guild#1")).rejects.toThrow("snowflake");
    expect(commands).toHaveLength(0);
  });
});
