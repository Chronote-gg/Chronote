/** @jest-environment node */
import { jest } from "@jest/globals";
import { createDiscordMessageEditor } from "../../src/services/discordMessageEditor";

jest.mock("../../src/services/configService", () => {
  throw new Error("Recovery transport must not import application config");
});
jest.mock("openai", () => {
  throw new Error("Recovery transport must not import OpenAI");
});

const message = {
  id: "300",
  channel_id: "200",
  author: { id: "100", bot: true, username: "Synthetic bot" },
  content: "Existing content",
  embeds: [{ title: "Notes", description: "Synthetic notes" }],
  components: [{ type: 1, components: [] }],
  attachments: [{ id: "400", filename: "synthetic.txt" }],
  flags: 0,
  edited_timestamp: "2026-10-19T00:00:00.000Z",
};

function setup(body: unknown = message, status = 200) {
  const fetchImpl = jest
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(JSON.stringify(body), { status }));
  return {
    fetchImpl,
    editor: createDiscordMessageEditor({ token: "selected-token", fetchImpl }),
  };
}

const target = { channelId: "200", messageId: "300" };

describe("Discord message editor", () => {
  it("loads without application config or OpenAI and exposes only read/edit methods", () => {
    const { editor } = setup();
    expect(Object.keys(editor).sort()).toEqual([
      "editEmbeds",
      "getBotIdentity",
      "getChannel",
      "getMessage",
    ]);
  });

  it("reads the selected bot identity with the injected token", async () => {
    const { editor, fetchImpl } = setup({
      id: "100",
      bot: true,
      username: "Bot",
    });
    await expect(editor.getBotIdentity()).resolves.toEqual({
      id: "100",
      bot: true,
      username: "Bot",
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://discord.com/api/users/@me",
      expect.objectContaining({
        headers: {
          Authorization: "Bot selected-token",
          "Content-Type": "application/json",
        },
      }),
    );
  });

  it.each([{ id: "100", bot: false }, { id: 100, bot: true }, { bot: true }])(
    "rejects an invalid bot identity %j",
    async (body) => {
      await expect(setup(body).editor.getBotIdentity()).rejects.toThrow();
    },
  );

  it("reads a guild channel and preserves response metadata", async () => {
    const channel = { id: "200", guild_id: "500", type: 0, name: "synthetic" };
    const { editor, fetchImpl } = setup(channel);
    await expect(editor.getChannel("200")).resolves.toEqual(channel);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://discord.com/api/channels/200",
      expect.any(Object),
    );
  });

  it.each([
    { id: "200", type: 0 },
    { id: "200", guild_id: "500", type: "text" },
  ])("rejects an invalid guild channel %j", async (body) => {
    await expect(setup(body).editor.getChannel("200")).rejects.toThrow();
  });

  it("reads a full message without dropping preserved fields", async () => {
    const { editor, fetchImpl } = setup();
    await expect(editor.getMessage(target)).resolves.toEqual(message);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://discord.com/api/channels/200/messages/300",
      expect.any(Object),
    );
  });

  it("accepts omitted optional controls and flags as empty and zero", async () => {
    const body = { ...message, components: undefined, flags: undefined };
    await expect(setup(body).editor.getMessage(target)).resolves.toEqual({
      ...message,
      components: [],
      flags: 0,
    });
  });

  it.each([
    { ...message, channel_id: undefined },
    { ...message, author: { id: "100" } },
    { ...message, embeds: [null] },
    { ...message, attachments: [{ filename: "missing-id.txt" }] },
    { ...message, content: 42 },
  ])("rejects an invalid message %j", async (body) => {
    await expect(setup(body).editor.getMessage(target)).rejects.toThrow();
  });

  it("returns null for a missing message", async () => {
    await expect(setup({}, 404).editor.getMessage(target)).resolves.toBeNull();
  });

  it("patches exactly the approved embeds and disabled mentions", async () => {
    const { editor, fetchImpl } = setup({}, 200);
    const embeds = [{ description: "Approved synthetic notes" }];
    await expect(editor.editEmbeds({ ...target, embeds })).resolves.toBe(
      "acknowledged",
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://discord.com/api/channels/200/messages/300",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          embeds,
          allowed_mentions: { parse: [] },
        }),
      }),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reports a missing edit target without creating a replacement", async () => {
    const { editor, fetchImpl } = setup({}, 404);
    await expect(editor.editEmbeds({ ...target, embeds: [] })).resolves.toBe(
      "missing",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([403, 429, 500])(
    "preserves HTTP %i without retrying the edit",
    async (status) => {
      const { editor, fetchImpl } = setup({}, status);
      await expect(
        editor.editEmbeds({ ...target, embeds: [] }),
      ).rejects.toMatchObject({ status });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  it("propagates a timeout unchanged without retrying", async () => {
    const { editor, fetchImpl } = setup();
    const timeout = new DOMException("Request timed out", "TimeoutError");
    fetchImpl.mockRejectedValue(timeout);
    await expect(editor.editEmbeds({ ...target, embeds: [] })).rejects.toBe(
      timeout,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("treats a missing identity or channel as an HTTP failure", async () => {
    const { editor } = setup({}, 404);
    await expect(editor.getBotIdentity()).rejects.toMatchObject({
      status: 404,
    });
    await expect(editor.getChannel("200")).rejects.toMatchObject({
      status: 404,
    });
  });
});

test("first-publication transport creates exact approved components without PATCH/delete/retries", async () => {
  const { createFirstPublicationTransport } =
    await import("../../src/services/discordMessageEditor");
  const requests: RequestInit[] = [];
  const fetchImpl = async (
    _url: string | URL | Request,
    init?: RequestInit,
  ) => {
    requests.push(init ?? {});
    return new Response(
      JSON.stringify({
        id: "1",
        channel_id: "2",
        author: { id: "3", bot: true },
        content: "",
        embeds: [],
        components: [],
        attachments: [],
        flags: 0,
      }),
      { status: 200 },
    );
  };
  const t = createFirstPublicationTransport({ token: "dummy", fetchImpl });
  expect(Object.keys(t)).not.toContain("editEmbeds");
  expect(Object.keys(t)).not.toContain("deleteNotesMessage");
  await t.createNotesMessage({
    channelId: "2",
    payload: {
      embeds: [{ description: "body" }],
      components: [],
      allowed_mentions: { parse: [] },
    },
  });
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ method: "POST", redirect: "error" });
  expect(JSON.parse(String(requests[0].body)).allowed_mentions).toEqual({
    parse: [],
  });
});
