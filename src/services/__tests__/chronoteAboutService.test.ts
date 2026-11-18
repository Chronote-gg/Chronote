import { ChannelType, Collection, Embed, type Client } from "discord.js";
import { dynamoDbClient } from "../../repositories/dynamoClient";
import {
  refreshChronoteAbout,
  startChronoteAboutRefresh,
} from "../chronoteAboutService";
import { isEligible } from "../workerRegistry";

jest.mock("../../repositories/dynamoClient", () => ({
  dynamoDbClient: { send: jest.fn() },
  tableName: (name: string) => `meeting-notes-sandbox-${name}`,
}));
jest.mock("../chronoteDemo", () => ({
  getChronoteDemo: async () => ({
    guildId: "200000000000000010",
    voiceChannelId: "200000000000000011",
    outputChannelId: "200000000000000012",
    aboutChannelId: "200000000000000013",
  }),
}));
jest.mock("../workerRegistry", () => ({ isEligible: jest.fn(() => true) }));
jest.mock("../shutdownSignal", () => ({ isShuttingDown: () => false }));

const scan = jest.mocked(dynamoDbClient.send);

function setup() {
  const channel = {
    type: ChannelType.GuildText,
    guildId: "200000000000000010",
    permissionsFor: jest.fn(() => ({ has: (): boolean => true })),
    messages: { fetch: jest.fn().mockResolvedValue(new Collection()) },
    send: jest.fn(),
  };
  const client = {
    isReady: () => true,
    channels: { fetch: jest.fn().mockResolvedValue(channel) },
    user: { id: "chronote" },
    guilds: { cache: { size: 80 } },
  };
  return { channel, client };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(isEligible).mockReturnValue(true);
});

it("publishes only aggregates and edits its own post on a repeat refresh", async () => {
  const { client, channel } = setup();
  const cursor = { guildId: { S: "cursor" } };
  scan
    .mockImplementationOnce(async () => ({
      Count: 1,
      Items: [{ duration: { N: "3600" } }],
      LastEvaluatedKey: cursor,
    }))
    .mockImplementationOnce(async () => ({
      Count: 2,
      Items: [{ duration: { N: "7200" } }, {}],
    }));

  await refreshChronoteAbout(client as unknown as Client);
  expect(client.channels.fetch).toHaveBeenCalledWith("200000000000000013");
  expect(scan.mock.calls[1][0]).toHaveProperty(
    "input.ExclusiveStartKey",
    cursor,
  );
  expect(scan.mock.calls[0][0]).toHaveProperty(
    "input.ProjectionExpression",
    "#duration",
  );
  const payload = channel.send.mock.calls[0][0];
  expect(payload.enforceNonce).toBe(true);
  expect(payload.embeds[0].thumbnail.url).toBe(
    "https://chronote.gg/logo192.png",
  );
  expect(payload.embeds[0]).not.toHaveProperty("footer");
  expect(payload.embeds[0].description).toContain(
    "### 80 servers · 3 meetings · 3 hours",
  );

  const edit = jest.fn();
  const unrelatedEdit = jest.fn();
  const embeds = [
    {
      title: payload.embeds[0].title,
      url: payload.embeds[0].url,
      equals: () => false,
    },
  ];
  channel.messages.fetch.mockResolvedValue(
    new Collection([
      [
        "unrelated",
        { author: { id: "another-bot" }, embeds, edit: unrelatedEdit },
      ],
      ["about", { author: client.user, embeds, edit }],
    ]),
  );
  scan.mockImplementationOnce(async () => ({ Count: 4 }));
  await refreshChronoteAbout(client as unknown as Client);

  expect(channel.send).toHaveBeenCalledTimes(1);
  expect(unrelatedEdit).not.toHaveBeenCalled();
  expect(edit.mock.calls[0][0].embeds[0].description).toContain("4 meetings");
});

it("does no Discord or DynamoDB work on an ineligible worker", async () => {
  const { client } = setup();
  jest.mocked(isEligible).mockReturnValue(false);
  await refreshChronoteAbout(client as unknown as Client);
  expect(client.channels.fetch).not.toHaveBeenCalled();
  expect(scan).not.toHaveBeenCalled();
});

it("keeps the production channel untouched when started in Sandbox", () => {
  const { client } = setup();
  startChronoteAboutRefresh(client as unknown as Client);
  expect(client.channels.fetch).not.toHaveBeenCalled();
  expect(scan).not.toHaveBeenCalled();
});

it("leaves the existing post alone when the numbers are unchanged", async () => {
  const { channel, client } = setup();
  scan.mockImplementation(async () => ({
    Count: 1,
    Items: [{ duration: { N: "3600" } }],
  }));
  await refreshChronoteAbout(client as unknown as Client);

  const serialized = {
    ...channel.send.mock.calls[0][0].embeds[0],
    type: "rich",
  };
  const edit = jest.fn();
  channel.messages.fetch.mockResolvedValue(
    new Collection([
      [
        "about",
        {
          author: client.user,
          embeds: [Reflect.construct(Embed, [serialized])],
          edit,
        },
      ],
    ]),
  );

  await refreshChronoteAbout(client as unknown as Client);
  expect(channel.send).toHaveBeenCalledTimes(1);
  expect(edit).not.toHaveBeenCalled();
});

it("refuses to create a post when Discord could be hiding the existing one", async () => {
  const { channel, client } = setup();
  channel.permissionsFor.mockReturnValue({ has: () => false });
  await expect(
    refreshChronoteAbout(client as unknown as Client),
  ).rejects.toThrow("Read Message History");
  expect(channel.send).not.toHaveBeenCalled();
  expect(scan).not.toHaveBeenCalled();
});
