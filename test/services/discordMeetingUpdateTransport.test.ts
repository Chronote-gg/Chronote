/** @jest-environment node */
import { createDiscordMeetingUpdateTransport } from "../../src/services/discordMeetingUpdateTransport";
import { DiscordMessageHttpError } from "../../src/services/discordMessageEditor";
import { fixture } from "./meetingUpdatePlan.fixture";
jest.mock("../../src/services/configService", () => {
  throw new Error("Transport imported application configuration");
});
jest.mock("openai", () => {
  throw new Error("Delivery imported OpenAI");
});
const input = fixture();
const target = {
  channelId: input.messages[0].channel_id,
  messageId: input.messages[0].id,
};
test("bounded transport keeps the exact abort signal and sends only notes embeds and mention suppression", async () => {
  const calls: RequestInit[] = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    calls.push(init!);
    return Response.json(input.messages[0]);
  };
  const discord = createDiscordMeetingUpdateTransport({
    token: "synthetic",
    fetchImpl,
  });
  const signal = new AbortController().signal;
  await discord.writeNotesMessage({
    ...target,
    signal,
    embeds: input.messages[0].embeds,
  });
  expect(calls[0].signal).toBe(signal);
  expect(JSON.parse(String(calls[0].body))).toEqual({
    embeds: input.messages[0].embeds,
    allowed_mentions: { parse: [] },
  });
});
test("rate-limit errors retain sanitized maximum header/body timing", async () => {
  const fetchImpl: typeof fetch = async () =>
    Response.json(
      { retry_after: 90, message: "private synthetic body" },
      { status: 429, headers: { "Retry-After": "100" } },
    );
  const discord = createDiscordMeetingUpdateTransport({
    token: "synthetic",
    fetchImpl,
  });
  try {
    await discord.deleteNotesMessage(target);
    throw new Error("Expected rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(DiscordMessageHttpError);
    expect(error).toMatchObject({ status: 429, retryAfterSeconds: 100 });
    expect(String(error)).not.toContain("private");
  }
});
test.each([200, 202])(
  "DELETE status%s is ambiguous despite a successful HTTP class",
  async (status) => {
    const fetchImpl: typeof fetch = async () =>
      new Response("unexpected", { status });
    const discord = createDiscordMeetingUpdateTransport({
      token: "synthetic",
      fetchImpl,
    });
    await expect(discord.deleteNotesMessage(target)).rejects.toThrow();
  },
);
test("malformed successful creation never supplies an invented returned ID", async () => {
  const fetchImpl: typeof fetch = async () => Response.json({ id: "1" });
  const discord = createDiscordMeetingUpdateTransport({
    token: "synthetic",
    fetchImpl,
  });
  await expect(
    discord.writeNotesMessage({ channelId: target.channelId, embeds: [] }),
  ).rejects.toThrow();
});
