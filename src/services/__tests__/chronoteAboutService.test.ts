import { ChannelType, Routes, type Client } from "discord.js";
import {
  refreshChronoteAbout,
  startChronoteAboutRefresh,
} from "../chronoteAboutService";
import { getChronoteDemo } from "../chronoteDemo";
import { isEligible } from "../workerRegistry";

jest.mock("../chronoteDemo", () => ({ getChronoteDemo: jest.fn() }));
jest.mock("../workerRegistry", () => ({ isEligible: jest.fn(() => true) }));
jest.mock("../shutdownSignal", () => ({ isShuttingDown: () => false }));

const demo = {
  guildId: "200000000000000010",
  voiceChannelId: "200000000000000011",
  outputChannelId: "200000000000000012",
  aboutChannelId: "200000000000000013",
  stats: { completedMeetings: 3, recordedHours: 3 },
};

function setup() {
  const get = jest.fn().mockResolvedValue([]);
  const channel = {
    id: demo.aboutChannelId,
    type: ChannelType.GuildText,
    guildId: demo.guildId,
    permissionsFor: jest.fn(() => ({ has: (): boolean => true })),
    client: { rest: { get } },
    messages: { edit: jest.fn() },
    send: jest.fn(),
  };
  const client = {
    isReady: () => true,
    channels: { fetch: jest.fn().mockResolvedValue(channel) },
    user: { id: "chronote" },
    guilds: { cache: { size: 80 } },
  };
  return { channel, client, get };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(isEligible).mockReturnValue(true);
  jest.mocked(getChronoteDemo).mockResolvedValue(demo);
});

it("posts configured counts, skips identical posts, and updates its own post", async () => {
  const { client, channel, get } = setup();
  await refreshChronoteAbout(client as unknown as Client);
  expect(client.channels.fetch).toHaveBeenCalledWith(demo.aboutChannelId);
  expect(get).toHaveBeenCalledWith(
    Routes.channelMessages(demo.aboutChannelId),
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  const payload = channel.send.mock.calls[0][0];
  expect(payload.enforceNonce).toBe(true);
  expect(payload.embeds[0].thumbnail.url).toBe(
    "https://chronote.gg/logo192.png",
  );
  expect(payload.embeds[0].description).toContain(
    "### 80 servers · 3 meetings · 3 hours",
  );
  get.mockResolvedValue([
    {
      id: "someone-else",
      author: { id: "another-bot" },
      embeds: payload.embeds,
    },
    { id: "about", author: client.user, embeds: payload.embeds },
  ]);

  await refreshChronoteAbout(client as unknown as Client);
  expect(channel.messages.edit).not.toHaveBeenCalled();

  jest.mocked(getChronoteDemo).mockResolvedValue({
    ...demo,
    stats: { completedMeetings: 4, recordedHours: 3 },
  });
  await refreshChronoteAbout(client as unknown as Client);
  expect(channel.send).toHaveBeenCalledTimes(1);
  expect(channel.messages.edit).toHaveBeenCalledWith("about", {
    embeds: [
      expect.objectContaining({
        description: expect.stringContaining("4 meetings"),
      }),
    ],
  });
});

it("can post the guide when historical counts are unavailable", async () => {
  const { channel, client } = setup();
  jest.mocked(getChronoteDemo).mockResolvedValue({ ...demo, stats: undefined });
  await refreshChronoteAbout(client as unknown as Client);
  const { description } = channel.send.mock.calls[0][0].embeds[0];
  expect(description).toContain("### 80 servers\n\n");
  expect(description).toContain("starts recording automatically");
});

it("does no Discord work on an ineligible worker", async () => {
  const { client } = setup();
  jest.mocked(isEligible).mockReturnValue(false);
  await refreshChronoteAbout(client as unknown as Client);
  expect(client.channels.fetch).not.toHaveBeenCalled();
});

it("uses the optional About channel in the environment binding", async () => {
  const { client } = setup();
  jest
    .mocked(getChronoteDemo)
    .mockResolvedValue({ ...demo, aboutChannelId: undefined });
  await refreshChronoteAbout(client as unknown as Client);
  expect(client.channels.fetch).not.toHaveBeenCalled();
});

it("does not refresh synchronously at worker startup", () => {
  const { client } = setup();
  startChronoteAboutRefresh(client as unknown as Client);
  expect(client.channels.fetch).not.toHaveBeenCalled();
});

it("does not create a duplicate when it reaches the history limit", async () => {
  const { channel, client, get } = setup();
  const unrelated = Array.from({ length: 100 }, (_, index) => ({
    id: String(index + 1),
    author: { id: "another-bot" },
    embeds: [],
  }));
  get.mockResolvedValue(unrelated);
  await expect(
    refreshChronoteAbout(client as unknown as Client),
  ).rejects.toThrow("Could not verify whether the About post already exists");
  expect(get).toHaveBeenCalledTimes(3);
  expect(get.mock.calls[1][1].query.get("before")).toBe("100");
  expect(channel.send).not.toHaveBeenCalled();
});

it("refuses to create a post when Discord could be hiding the existing one", async () => {
  const { channel, client, get } = setup();
  channel.permissionsFor.mockReturnValue({ has: () => false });
  await expect(
    refreshChronoteAbout(client as unknown as Client),
  ).rejects.toThrow("Read Message History");
  expect(channel.send).not.toHaveBeenCalled();
  expect(get).not.toHaveBeenCalled();
});
