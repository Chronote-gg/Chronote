import {
  DISCORD_BOT_INVITE_URL,
  buildInviteUrl,
  JOIN_PAGE_INVITE_URL,
} from "../discordInvite";

describe("discordInvite", () => {
  describe("DISCORD_BOT_INVITE_URL", () => {
    it("contains the correct client ID", () => {
      expect(DISCORD_BOT_INVITE_URL).toContain("client_id=1278729036528619633");
    });

    it("requests bot and applications.commands scopes", () => {
      expect(DISCORD_BOT_INVITE_URL).toContain(
        "scope=bot%20applications.commands",
      );
    });

    it("points to Discord OAuth2 authorize endpoint", () => {
      expect(DISCORD_BOT_INVITE_URL).toMatch(
        /^https:\/\/discord\.com\/oauth2\/authorize/,
      );
    });
  });

  describe("buildInviteUrl", () => {
    it("returns the base URL when no UTM params are provided", () => {
      expect(buildInviteUrl()).toBe(DISCORD_BOT_INVITE_URL);
    });

    it("appends UTM parameters when provided", () => {
      const url = buildInviteUrl({
        source: "test_source",
        medium: "test_medium",
        campaign: "test_campaign",
      });

      expect(url).toContain(DISCORD_BOT_INVITE_URL);
      expect(url).toContain("utm_source=test_source");
      expect(url).toContain("utm_medium=test_medium");
      expect(url).toContain("utm_campaign=test_campaign");
    });

    it("URL-encodes special characters in UTM values", () => {
      const url = buildInviteUrl({
        source: "my source",
        medium: "web",
        campaign: "test&campaign",
      });

      expect(url).toContain("utm_source=my+source");
      expect(url).toContain("utm_campaign=test%26campaign");
    });
  });

  describe("JOIN_PAGE_INVITE_URL", () => {
    it("includes join page UTM parameters", () => {
      expect(JOIN_PAGE_INVITE_URL).toContain("utm_source=chronote");
      expect(JOIN_PAGE_INVITE_URL).toContain("utm_medium=web");
      expect(JOIN_PAGE_INVITE_URL).toContain("utm_campaign=join_page");
    });

    it("starts with the base invite URL", () => {
      expect(JOIN_PAGE_INVITE_URL.startsWith(DISCORD_BOT_INVITE_URL)).toBe(
        true,
      );
    });
  });
});
