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
    expect(posthog.capture).toHaveBeenCalledWith("pricing_cta_clicked", {
      plan: "basic",
    });
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

  test("falls back to the default host when none is injected", () => {
    setKey("phc_test_key");
    initAnalytics();
    expect(posthog.init).toHaveBeenCalledWith(
      "phc_test_key",
      expect.objectContaining({ api_host: "https://us.i.posthog.com" }),
    );
  });
});
