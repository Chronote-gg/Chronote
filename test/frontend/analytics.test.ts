import { afterEach, describe, expect, jest, test } from "@jest/globals";
import posthog from "posthog-js";
import {
  initAnalytics,
  isDoNotTrackEnabled,
  redactDeep,
  redactShareIds,
  track,
} from "../../src/frontend/services/analytics";

jest.mock("posthog-js", () => ({
  __esModule: true,
  default: { init: jest.fn(), capture: jest.fn() },
}));

type AnalyticsGlobal = {
  __POSTHOG_KEY__?: string;
  __POSTHOG_HOST__?: string;
};

const globals = globalThis as AnalyticsGlobal;

const setKey = (value?: string) => {
  globals.__POSTHOG_KEY__ = value;
};

afterEach(() => {
  setKey(undefined);
  globals.__POSTHOG_HOST__ = undefined;
  jest.clearAllMocks();
});

describe("analytics", () => {
  test("reads the browser Do Not Track preference", () => {
    Object.defineProperty(navigator, "doNotTrack", {
      value: "1",
      configurable: true,
    });
    expect(isDoNotTrackEnabled()).toBe(true);
    Object.defineProperty(navigator, "doNotTrack", {
      value: null,
      configurable: true,
    });
  });

  test("stays disabled when no key is injected", () => {
    setKey(undefined);
    initAnalytics();
    track("pricing_cta_clicked", { plan: "basic" });
    expect(posthog.init).not.toHaveBeenCalled();
    expect(posthog.capture).not.toHaveBeenCalled();
  });

  test("treats an unreplaced Vite placeholder as unconfigured", () => {
    setKey("%VITE_POSTHOG_KEY%");
    initAnalytics();
    track("pricing_cta_clicked");
    expect(posthog.init).not.toHaveBeenCalled();
    expect(posthog.capture).not.toHaveBeenCalled();
  });

  test("initializes and captures once a key is present", () => {
    setKey("phc_test_key");
    initAnalytics();
    track("pricing_cta_clicked", { plan: "basic" });
    expect(posthog.init).toHaveBeenCalledWith(
      "phc_test_key",
      expect.objectContaining({ capture_pageview: "history_change" }),
    );
    expect(posthog.capture).toHaveBeenCalledWith(
      "pricing_cta_clicked",
      expect.objectContaining({
        plan: "basic",
        surface: "web",
        environment: "local",
      }),
    );
  });

  test("redacts share ids, which are bearer credentials", () => {
    expect(
      redactShareIds("https://chronote.gg/share/meeting/guild-1/secret-token"),
    ).toBe("https://chronote.gg/share/meeting/:serverId/:shareId");
    expect(
      redactShareIds("https://chronote.gg/share/ask/guild-1/conversation-9"),
    ).toBe("https://chronote.gg/share/ask/:serverId/:shareId");
  });

  test("redacts share ids nested inside replay payloads", () => {
    const payload = {
      $snapshot_data: [
        { href: "https://chronote.gg/share/ask/guild-1/conversation-9" },
      ],
      meta: {
        nested: { url: "https://chronote.gg/share/meeting/guild-1/secret" },
      },
      count: 3,
    };

    expect(redactDeep(payload)).toEqual({
      $snapshot_data: [
        { href: "https://chronote.gg/share/ask/:serverId/:shareId" },
      ],
      meta: {
        nested: { url: "https://chronote.gg/share/meeting/:serverId/:shareId" },
      },
      count: 3,
    });
  });

  test("leaves non-share urls alone", () => {
    expect(redactShareIds("https://chronote.gg/portal/meetings")).toBe(
      "https://chronote.gg/portal/meetings",
    );
  });

  test("redacts promotion values in URLs and encoded sign-in returns", () => {
    const url =
      "https://chronote.gg/upgrade?promo=PRIVATE&source=discord_notes";
    expect(redactShareIds(url)).toBe(
      "https://chronote.gg/upgrade?promo=[redacted]&source=[redacted]",
    );
    expect(
      redactShareIds(
        `https://api.chronote.gg/auth?redirect=${encodeURIComponent(url)}`,
      ),
    ).not.toContain("PRIVATE");
    const returnUrl = `https://api.chronote.gg/auth?redirect=${encodeURIComponent(url)}`;
    expect(
      redactShareIds(
        `https://api.chronote.gg/auth?redirect=${encodeURIComponent(returnUrl)}`,
      ),
    ).not.toContain("PRIVATE");
  });

  test.each([
    "https://chronote.gg/promo/PRIVATE?interval=year",
    "https://chronote.gg/upgrade?%70romo=PRIVATE&tier=pro",
    "https://chronote.gg/upgrade?promotionCode=PRIVATE",
    "https://api.chronote.gg/auth?redirect=https://chronote.gg/upgrade?promo=PRIVATE",
    "https://api.chronote.gg/auth?redirect=/upgrade?promo=PRIVATE",
    "https://api.chronote.gg/auth?redirect=https%3A%2F%2Fchronote.gg%2Fshare%2Fmeeting%2Fguild%2FPRIVATE%3Ffoo%3D%ZZ",
    "https://api.chronote.gg/auth?redirect=https%253A%252F%252Fchronote.gg%252Fpromo%252FPRIVATE%253Ffoo%253D%25ZZ",
  ])("redacts promotion paths and decoded query keys: %s", (url) => {
    expect(redactShareIds(url)).not.toContain("PRIVATE");
    expect(
      redactShareIds(
        `https://api.chronote.gg/auth?redirect=${encodeURIComponent(url)}`,
      ),
    ).not.toContain("PRIVATE");
  });

  test("Do Not Track suppresses initialization and custom events", () => {
    setKey("phc_test_key");
    Object.defineProperty(navigator, "doNotTrack", {
      value: "1",
      configurable: true,
    });
    initAnalytics();
    track("upgrade_arrived");
    expect(posthog.init).not.toHaveBeenCalled();
    expect(posthog.capture).not.toHaveBeenCalled();
    Object.defineProperty(navigator, "doNotTrack", {
      value: null,
      configurable: true,
    });
  });

  test("a capture failure cannot interrupt a purchase action", () => {
    setKey("phc_test_key");
    jest.mocked(posthog.capture).mockImplementationOnce(() => {
      throw new Error("analytics unavailable");
    });
    expect(() => track("upgrade_plan_clicked", { tier: "pro" })).not.toThrow();
  });

  test("falls back to the default host when none is injected", () => {
    setKey("phc_test_key");
    initAnalytics();
    expect(posthog.init).toHaveBeenCalledWith(
      "phc_test_key",
      expect.objectContaining({ api_host: "https://us.i.posthog.com" }),
    );
  });
});

test("redacts recording-limit URL values before automatic capture", () => {
  const nested = encodeURIComponent(
    "https://chronote.gg/upgrade/select-server?limitType=untrusted-value&limitSurface=also-untrusted",
  );
  const redacted = redactShareIds(
    `https://example.com/auth?redirect=${nested}`,
  );
  expect(decodeURIComponent(redacted)).not.toContain("untrusted-value");
  expect(decodeURIComponent(redacted)).not.toContain("also-untrusted");
});

test("redacts first-meeting targets in URLs, referrers, links and nested sign-in returns", () => {
  const historyId = "333333333333333333#2026-10-19T12:00:00.000Z";
  const serverId = "111111111111111111";
  const guide = `https://chronote.gg/join?serverId=${serverId}&historyId=${encodeURIComponent(historyId)}`;
  const meeting = `https://chronote.gg/portal/meetings/${serverId}/${encodeURIComponent(historyId)}`;
  const payload = {
    $current_url: guide,
    $referrer: meeting,
    elements: [{ attr__href: meeting }],
    nested: `/auth/discord?redirect=${encodeURIComponent(guide)}`,
    deeplyEncoded: `/auth/discord?redirect=${encodeURIComponent(`/auth/discord?redirect=${encodeURIComponent(meeting)}`)}`,
  };
  const redacted = JSON.stringify(redactDeep(payload));
  expect(redacted).not.toContain(serverId);
  expect(redacted).not.toContain("333333333333333333");
  expect(redacted).toContain("/join");
  expect(payload.$current_url).toBe(guide);
});

test.each([
  "https://discord.com/channels/111111111111111111/444444444444444444/555555555555555555",
  "https://discord.com/channels/111111111111111111/444444444444444444",
  "https://discord.com/channels/111111111111111111",
  "/auth?redirect=https%3A%2F%2Fdiscord.com%2Fchannels%2F111111111111111111%2F444444444444444444%2F555555555555555555",
  "/auth?redirect=%2Fauth%3Fredirect%3Dhttps%253A%252F%252Fdiscord.com%252Fchannels%252F111111111111111111%252F444444444444444444",
])(
  "removes Discord destination identifiers from analytics copies: %s",
  (href) => {
    const payload = { elements: [{ nested: { attr__href: href } }] };
    const sanitized = JSON.stringify(redactDeep(payload));
    expect(sanitized).not.toContain("111111111111111111");
    expect(sanitized).not.toContain("444444444444444444");
    expect(sanitized).not.toContain("555555555555555555");
    expect(payload.elements[0].nested.attr__href).toBe(href);
  },
);
