import { jest } from "@jest/globals";

jest.unstable_mockModule("../../src/services/configService", () => ({
  config: {
    discord: { botToken: "test-token" },
  },
}));

const mockFetchResponse = (value: {
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
  text?: () => Promise<string>;
}) => {
  global.fetch = jest.fn().mockResolvedValue({
    ok: value.ok,
    status: value.status,
    json: value.json ?? (async () => ({})),
    text: value.text ?? (async () => ""),
  }) as unknown as typeof fetch;
};

describe("discordMessageService", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("updateDiscordMessage", () => {
    it("sends PATCH with full payload including embeds and components", async () => {
      mockFetchResponse({ ok: true, status: 200 });
      const { updateDiscordMessage } =
        await import("../../src/services/discordMessageService");

      const result = await updateDiscordMessage("chan-1", "msg-1", {
        embeds: [{ title: "Updated" }],
        components: [{ type: 1 }],
      });

      expect(result).toBe(true);
      expect(global.fetch).toHaveBeenCalledWith(
        "https://discord.com/api/channels/chan-1/messages/msg-1",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({
            embeds: [{ title: "Updated" }],
            components: [{ type: 1 }],
          }),
        }),
      );
    });

    it("returns false when message is not found (404)", async () => {
      mockFetchResponse({ ok: false, status: 404 });
      const { updateDiscordMessage } =
        await import("../../src/services/discordMessageService");

      const result = await updateDiscordMessage("chan-1", "msg-gone", {
        embeds: [],
      });

      expect(result).toBe(false);
    });

    it("throws on non-404 error", async () => {
      mockFetchResponse({ ok: false, status: 500 });
      const { updateDiscordMessage } =
        await import("../../src/services/discordMessageService");

      await expect(
        updateDiscordMessage("chan-1", "msg-1", { embeds: [] }),
      ).rejects.toThrow("Discord message update failed (500)");
    });
  });

  describe("updateDiscordMessageEmbeds", () => {
    it("delegates to updateDiscordMessage with embeds-only payload", async () => {
      mockFetchResponse({ ok: true, status: 200 });
      const { updateDiscordMessageEmbeds } =
        await import("../../src/services/discordMessageService");

      await updateDiscordMessageEmbeds("chan-1", "msg-1", [{ title: "Notes" }]);

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("msg-1"),
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ embeds: [{ title: "Notes" }] }),
        }),
      );
    });
  });

  describe("fetchDiscordMessage", () => {
    it("returns message on success", async () => {
      const messageData = { id: "msg-1", embeds: [{ title: "Test" }] };
      mockFetchResponse({
        ok: true,
        status: 200,
        json: async () => messageData,
      });
      const { fetchDiscordMessage } =
        await import("../../src/services/discordMessageService");

      const result = await fetchDiscordMessage("chan-1", "msg-1");

      expect(result).toEqual(messageData);
    });

    it("returns null on 404", async () => {
      mockFetchResponse({ ok: false, status: 404 });
      const { fetchDiscordMessage } =
        await import("../../src/services/discordMessageService");

      const result = await fetchDiscordMessage("chan-1", "msg-gone");

      expect(result).toBeNull();
    });

    it("throws on non-404 error", async () => {
      mockFetchResponse({ ok: false, status: 500 });
      const { fetchDiscordMessage } =
        await import("../../src/services/discordMessageService");

      await expect(fetchDiscordMessage("chan-1", "msg-1")).rejects.toThrow(
        "Discord message fetch failed (500)",
      );
    });
  });

  describe("createDiscordMessage", () => {
    it("sends POST and returns created message", async () => {
      const created = { id: "new-msg-1" };
      mockFetchResponse({
        ok: true,
        status: 200,
        json: async () => created,
      });
      const { createDiscordMessage } =
        await import("../../src/services/discordMessageService");

      const result = await createDiscordMessage("chan-1", {
        embeds: [{ title: "New" }],
      });

      expect(result).toEqual(created);
      expect(global.fetch).toHaveBeenCalledWith(
        "https://discord.com/api/channels/chan-1/messages",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ embeds: [{ title: "New" }] }),
        }),
      );
    });

    it("throws on error", async () => {
      mockFetchResponse({ ok: false, status: 403 });
      const { createDiscordMessage } =
        await import("../../src/services/discordMessageService");

      await expect(
        createDiscordMessage("chan-1", { embeds: [] }),
      ).rejects.toThrow("Discord message create failed (403)");
    });
  });

  describe("deleteDiscordMessage", () => {
    it("sends DELETE and returns true on success", async () => {
      mockFetchResponse({ ok: true, status: 204 });
      const { deleteDiscordMessage } =
        await import("../../src/services/discordMessageService");

      const result = await deleteDiscordMessage("chan-1", "msg-1");

      expect(result).toBe(true);
      expect(global.fetch).toHaveBeenCalledWith(
        "https://discord.com/api/channels/chan-1/messages/msg-1",
        expect.objectContaining({ method: "DELETE" }),
      );
    });

    it("returns false on 404", async () => {
      mockFetchResponse({ ok: false, status: 404 });
      const { deleteDiscordMessage } =
        await import("../../src/services/discordMessageService");

      const result = await deleteDiscordMessage("chan-1", "msg-gone");

      expect(result).toBe(false);
    });

    it("throws on non-404 error", async () => {
      mockFetchResponse({ ok: false, status: 500 });
      const { deleteDiscordMessage } =
        await import("../../src/services/discordMessageService");

      await expect(deleteDiscordMessage("chan-1", "msg-1")).rejects.toThrow(
        "Discord message delete failed (500)",
      );
    });
  });
});
