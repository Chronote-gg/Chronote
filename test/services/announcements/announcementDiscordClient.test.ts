import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { createAnnouncementDiscordClient } from "../../../src/services/announcements/announcementDiscordClient";
import type { AnnouncementEmbed } from "../../../src/services/announcements/announcementTypes";
import { DiscordMessageHttpError } from "../../../src/services/discordMessageEditor";

const TOKEN = "fake-token";
const BOT_USER_ID = "100000000000000002";
const GUILD_ID = "100000000000000001";
const OWNER_ID = "100000000000000004";
const CHANNEL_ID = "100000000000000011";
const DM_CHANNEL_ID = "100000000000000021";
const MESSAGE_ID = "100000000000000031";
const API = "https://discord.com/api/v10";

const embed: AnnouncementEmbed = {
  title: "Example notice",
  description: "Example body",
  color: 0x5865f2,
  footer: { text: "Example footer" },
  timestamp: "2026-11-04T00:00:00.000Z",
};

type Call = { url: string; init: RequestInit };

const json = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

function setup(responses: Array<Response | Error>) {
  const calls: Call[] = [];
  const fetchImpl = jest.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      const next = responses.shift();
      if (!next) throw new Error("unexpected fetch");
      if (next instanceof Error) throw next;
      return next;
    },
  );
  const sleep = jest.fn<(ms: number) => Promise<void>>(async () => undefined);
  const client = createAnnouncementDiscordClient({
    token: TOKEN,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    sleep,
  });
  return { client, calls, fetchImpl, sleep };
}

const ids = (count: number, offset = 0) =>
  Array.from({ length: count }, (_, index) =>
    String(100000000000100000n + BigInt(offset + index)),
  );

afterEach(() => jest.restoreAllMocks());

describe("announcement Discord client", () => {
  it("sends every request to the v10 API with bot auth, no redirects and a 15 s timeout", async () => {
    const timeout = jest.spyOn(AbortSignal, "timeout");
    const { client, calls } = setup([json(200, { id: BOT_USER_ID })]);
    await expect(client.getBotUserId()).resolves.toBe(BOT_USER_ID);
    expect(calls[0].url).toBe(`${API}/users/@me`);
    expect(calls[0].init.redirect).toBe("error");
    expect(calls[0].init.headers).toMatchObject({
      Authorization: `Bot ${TOKEN}`,
    });
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
    expect(timeout).toHaveBeenCalledWith(15000);
  });

  it("pages bot guilds with after= the last id of a full page and stops on a short page", async () => {
    const firstPage = ids(200);
    const secondPage = ids(3, 200);
    const { client, calls } = setup([
      json(
        200,
        firstPage.map((id) => ({ id })),
      ),
      json(
        200,
        secondPage.map((id) => ({ id })),
      ),
    ]);
    await expect(client.listBotGuildIds()).resolves.toEqual([
      ...firstPage,
      ...secondPage,
    ]);
    expect(calls.map((call) => call.url)).toEqual([
      `${API}/users/@me/guilds?limit=200`,
      `${API}/users/@me/guilds?limit=200&after=${firstPage[199]}`,
    ]);
  });

  it("maps a guild, its channels and the bot member roles", async () => {
    const { client, calls } = setup([
      json(200, {
        id: GUILD_ID,
        name: "Example Server",
        owner_id: OWNER_ID,
        roles: [{ id: GUILD_ID, permissions: "1024" }],
        public_updates_channel_id: CHANNEL_ID,
        system_channel_id: null,
      }),
      json(200, [
        { id: CHANNEL_ID, name: "updates", type: 5, permission_overwrites: [] },
      ]),
      json(200, { roles: ["100000000000000003"] }),
    ]);
    await expect(client.getGuild(GUILD_ID)).resolves.toEqual({
      id: GUILD_ID,
      name: "Example Server",
      ownerId: OWNER_ID,
      roles: [{ id: GUILD_ID, permissions: "1024" }],
      publicUpdatesChannelId: CHANNEL_ID,
      systemChannelId: null,
    });
    await expect(client.listGuildChannels(GUILD_ID)).resolves.toEqual([
      { id: CHANNEL_ID, name: "updates", type: 5, permission_overwrites: [] },
    ]);
    await expect(
      client.getMemberRoleIds(GUILD_ID, BOT_USER_ID),
    ).resolves.toEqual(["100000000000000003"]);
    expect(calls.map((call) => call.url)).toEqual([
      `${API}/guilds/${GUILD_ID}`,
      `${API}/guilds/${GUILD_ID}/channels`,
      `${API}/guilds/${GUILD_ID}/members/${BOT_USER_ID}`,
    ]);
  });

  it("creates a message with exactly the embed and no mentions", async () => {
    const { client, calls } = setup([json(200, { id: MESSAGE_ID })]);
    await expect(client.createMessage(CHANNEL_ID, embed)).resolves.toEqual({
      id: MESSAGE_ID,
    });
    expect(calls[0].url).toBe(`${API}/channels/${CHANNEL_ID}/messages`);
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      embeds: [embed],
      allowed_mentions: { parse: [] },
    });
  });

  it("adds content only when given and honours the caller's signal", async () => {
    const { client, calls } = setup([json(200, { id: MESSAGE_ID })]);
    const controller = new AbortController();
    await client.createMessage(DM_CHANNEL_ID, embed, {
      content: "Example line",
      signal: controller.signal,
    });
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      embeds: [embed],
      allowed_mentions: { parse: [] },
      content: "Example line",
    });
    controller.abort();
    expect(calls[0].init.signal?.aborted).toBe(true);
  });

  it("opens a DM channel with the recipient id and returns its id", async () => {
    const { client, calls } = setup([json(200, { id: DM_CHANNEL_ID })]);
    await expect(client.openDmChannel(OWNER_ID)).resolves.toBe(DM_CHANNEL_ID);
    expect(calls[0].url).toBe(`${API}/users/@me/channels`);
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      recipient_id: OWNER_ID,
    });
  });

  it("exposes the Discord error code on a closed-DM 403 without retrying", async () => {
    const { client, fetchImpl, sleep } = setup([
      json(403, { code: 50007, message: "Cannot send messages to this user" }),
    ]);
    const error = await client
      .createMessage(DM_CHANNEL_ID, embed)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DiscordMessageHttpError);
    expect(error).toMatchObject({ status: 403, discordCode: 50007 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("throws a 403 without a JSON body as a status-only error", async () => {
    const { client, fetchImpl } = setup([
      new Response("forbidden", { status: 403 }),
    ]);
    const error = await client
      .createMessage(CHANNEL_ID, embed)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DiscordMessageHttpError);
    expect(error).toMatchObject({ status: 403, discordCode: undefined });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("waits Retry-After on a 429 and retries", async () => {
    const { client, sleep } = setup([
      json(429, { retry_after: 2 }, { "Retry-After": "2" }),
      json(200, { id: MESSAGE_ID }),
    ]);
    await expect(client.createMessage(CHANNEL_ID, embed)).resolves.toEqual({
      id: MESSAGE_ID,
    });
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it("caps a long Retry-After at 30 s", async () => {
    const { client, sleep } = setup([
      json(429, {}, { "Retry-After": "120" }),
      json(200, { id: MESSAGE_ID }),
    ]);
    await client.createMessage(CHANNEL_ID, embed);
    expect(sleep).toHaveBeenCalledWith(30000);
  });

  it("throws a 429 after three consecutive rate limits", async () => {
    const { client, fetchImpl } = setup([
      json(429, {}, { "Retry-After": "1" }),
      json(429, {}, { "Retry-After": "1" }),
      json(429, {}, { "Retry-After": "1" }),
    ]);
    const error = await client
      .createMessage(CHANNEL_ID, embed)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DiscordMessageHttpError);
    expect(error).toMatchObject({ status: 429 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("propagates a fetch rejection unchanged", async () => {
    const failure = new TypeError("network down");
    const { client } = setup([failure]);
    await expect(client.createMessage(CHANNEL_ID, embed)).rejects.toBe(failure);
  });

  it.each([
    [
      "getGuild",
      (client: ReturnType<typeof setup>["client"]) =>
        client.getGuild("../users/@me"),
    ],
    [
      "listGuildChannels",
      (client: ReturnType<typeof setup>["client"]) =>
        client.listGuildChannels("123"),
    ],
    [
      "getMemberRoleIds",
      (client: ReturnType<typeof setup>["client"]) =>
        client.getMemberRoleIds(GUILD_ID, "abc"),
    ],
    [
      "openDmChannel",
      (client: ReturnType<typeof setup>["client"]) => client.openDmChannel(""),
    ],
    [
      "createMessage",
      (client: ReturnType<typeof setup>["client"]) =>
        client.createMessage(`${CHANNEL_ID}/x`, embed),
    ],
  ])(
    "%s rejects a non-snowflake id without calling fetch",
    async (_name, call) => {
      const { client, fetchImpl } = setup([]);
      await expect(call(client)).rejects.toThrow("snowflake");
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );
});
