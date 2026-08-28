import { describe, expect, test } from "@jest/globals";
import {
  buildDirectDiscordInstallUrl,
  DISCORD_INSTALL_SCOPES,
  isDiscordGuildId,
  parseInstallAttribution,
  readInstallAttributionFromRequest,
  stashInstallAttributionFromSession,
  storeInstallAttributionInSession,
} from "../../src/services/installAttributionService";

describe("installAttributionService", () => {
  test("keeps only bounded acquisition shape", () => {
    expect(
      parseInstallAttribution(
        {
          source: "ChatGPT.com",
          medium: "Referral",
          campaign: "discord-launch_2026",
          landing_path: "/join",
          referrer_domain: "www.ChatGPT.com",
          cta_location: "hero",
        },
        "2026-08-28T12:00:00.000Z",
      ),
    ).toEqual({
      source: "chatgpt.com",
      medium: "referral",
      campaign: "discord-launch_2026",
      landingPath: "/join",
      referrerDomain: "chatgpt.com",
      ctaLocation: "hero",
      capturedAt: "2026-08-28T12:00:00.000Z",
    });
  });

  test("drops content-like and identifying query values", () => {
    const attribution = parseInstallAttribution({
      source: "a source with spaces",
      campaign: "https://example.com/?email=person@example.com",
      landing_path: "/share/private-token",
      referrer_domain: "example.com/private/path",
      cta_location: "user-123",
    });

    expect(attribution).toMatchObject({
      source: "direct",
      medium: "web",
      landingPath: "other",
      ctaLocation: "other",
    });
    expect(attribution).not.toHaveProperty("campaign");
    expect(attribution).not.toHaveProperty("referrerDomain");
  });

  test("disables attribution when Do Not Track is set", () => {
    expect(
      parseInstallAttribution({ dnt: "1", source: "chatgpt.com" }),
    ).toBeUndefined();
  });

  test("clears stale attribution when Do Not Track is set", () => {
    const req = {
      session: {
        installAttribution: parseInstallAttribution({ source: "old-source" }),
      },
    };

    storeInstallAttributionInSession(req, undefined);

    expect(req.session.installAttribution).toBeUndefined();
  });

  test("stashes attribution across Passport middleware", () => {
    const attribution = parseInstallAttribution({ source: "direct" })!;
    const req = { session: {} };

    expect(storeInstallAttributionInSession(req, attribution)).toBe(
      req.session,
    );
    expect(stashInstallAttributionFromSession(req)).toBe(attribution);
    expect(req.session.installAttribution).toBeUndefined();
    expect(readInstallAttributionFromRequest(req)).toBe(attribution);
  });

  test("accepts only Discord snowflake guild ids", () => {
    expect(isDiscordGuildId("1249723747896918109")).toBe(true);
    expect(isDiscordGuildId("guild-1")).toBe(false);
    expect(isDiscordGuildId(["1249723747896918109"])).toBe(false);
  });

  test("requests user and bot scopes for callback-backed installs", () => {
    expect(DISCORD_INSTALL_SCOPES).toEqual([
      "identify",
      "email",
      "guilds",
      "bot",
      "applications.commands",
    ]);
  });

  test("preserves a direct bot invite when OAuth is disabled", () => {
    const url = new URL(buildDirectDiscordInstallUrl("client-123"));

    expect(url.origin).toBe("https://discord.com");
    expect(url.pathname).toBe("/oauth2/authorize");
    expect(url.searchParams.get("client_id")).toBe("client-123");
    expect(url.searchParams.get("scope")).toBe("bot applications.commands");
  });
});
