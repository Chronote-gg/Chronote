import { describe, expect, test } from "@jest/globals";
import {
  buildDirectDiscordInstallUrl,
  DISCORD_INSTALL_SCOPES,
  isDiscordGuildId,
  parseInstallAttribution,
  readInstallAttributionFromRequest,
  setInstallAttributionOnRequest,
} from "../../src/services/installAttributionService";

describe("installAttributionService", () => {
  test("keeps only bounded acquisition shape", () => {
    expect(
      parseInstallAttribution(
        {
          source: "ChatGPT.com",
          medium: "Referral",
          campaign: "launch",
          landing_path: "/join",
          referrer_domain: "www.ChatGPT.com",
          cta_location: "hero",
        },
        "2026-08-28T12:00:00.000Z",
      ),
    ).toEqual({
      source: "chatgpt.com",
      medium: "referral",
      campaign: "launch",
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
    expect(
      parseInstallAttribution({
        dnt: ["0", "1"],
        source: "chatgpt.com",
      }),
    ).toBeUndefined();
  });

  test("rejects identifier-like tokens and first-party referrers", () => {
    const attribution = parseInstallAttribution({
      source: "1249723747896918109",
      medium: "person_name",
      campaign: "john_doe",
      referrer_domain: "api.chronote.gg",
    });

    expect(attribution).toMatchObject({ source: "direct", medium: "web" });
    expect(attribution).not.toHaveProperty("campaign");
    expect(attribution).not.toHaveProperty("referrerDomain");
  });

  test("keeps attribution request-local until bound to OAuth state", () => {
    const req = { session: {} };
    const attribution = parseInstallAttribution({ source: "direct" });
    setInstallAttributionOnRequest(req, attribution);
    expect(readInstallAttributionFromRequest(req)).toBe(attribution);
    expect(req.session).toEqual({});
    setInstallAttributionOnRequest(req, undefined);
    expect(readInstallAttributionFromRequest(req)).toBeUndefined();
  });
  test("accepts only Discord snowflake guild ids", () => {
    expect(isDiscordGuildId("1249723747896918109")).toBe(true);
    expect(isDiscordGuildId("guild-1")).toBe(false);
    expect(isDiscordGuildId(["1249723747896918109"])).toBe(false);
  });

  test("requests user and bot scopes for callback-backed installs", () => {
    expect(DISCORD_INSTALL_SCOPES).toEqual([
      "identify",
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

test.each([
  "1249723747896918109.example.com",
  "person.example.com",
  "google.com.attacker.test",
  "google.com/path",
  "127.0.0.1",
])("drops arbitrary referral host %s", (host) => {
  const result = parseInstallAttribution({
    source: host,
    referrer_domain: host,
  });
  expect(result?.source).toBe("direct");
  expect(result).not.toHaveProperty("referrerDomain");
});
test.each([
  ["alice.github.io", "github.io"],
  ["private.google.com", "google.com"],
])("collapses %s to fixed category %s", (host, category) => {
  expect(
    parseInstallAttribution({ source: host, referrer_domain: host }),
  ).toMatchObject({ source: category, referrerDomain: category });
});
