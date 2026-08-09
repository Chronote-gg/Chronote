const capture = jest.fn();
const shutdown = jest.fn().mockResolvedValue(undefined);
const constructPostHog = jest.fn();

jest.mock("posthog-node", () => ({
  PostHog: class {
    capture = capture;
    shutdown = shutdown;
    constructor(...args: unknown[]) {
      constructPostHog(...args);
    }
  },
}));

const analyticsConfig = { posthogKey: "", posthogHost: "https://example.test" };

jest.mock("../configService", () => ({
  config: {
    get analytics() {
      return analyticsConfig;
    },
  },
}));

import { captureEvent, shutdownAnalytics } from "../analyticsService";

describe("analyticsService", () => {
  beforeEach(async () => {
    // Drops any client cached by a previous test, so each case starts from an
    // unconfigured service the way a fresh process would.
    await shutdownAnalytics();
    jest.clearAllMocks();
    analyticsConfig.posthogKey = "";
  });

  it("does not construct a client or capture when no key is configured", () => {
    captureEvent("meeting_started", { userId: "user-1", guildId: "guild-1" });

    expect(constructPostHog).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
  });

  it("captures with the acting user as distinct id and guild as a property", () => {
    analyticsConfig.posthogKey = "phc_test";

    captureEvent("meeting_started", {
      userId: "user-1",
      guildId: "guild-1",
      properties: { trigger: "manual_command" },
    });

    expect(capture).toHaveBeenCalledWith({
      distinctId: "user-1",
      event: "meeting_started",
      properties: { trigger: "manual_command", guild_id: "guild-1" },
    });
  });

  it("namespaces the distinct id by guild when there is no acting user", () => {
    analyticsConfig.posthogKey = "phc_test";

    captureEvent("server_installed", { guildId: "guild-1" });

    expect(capture).toHaveBeenCalledWith(
      expect.objectContaining({ distinctId: "guild:guild-1" }),
    );
  });

  it("drops an event that identifies neither a user nor a guild", () => {
    analyticsConfig.posthogKey = "phc_test";

    captureEvent("server_installed");

    expect(capture).not.toHaveBeenCalled();
  });

  it("never throws when the client fails", () => {
    analyticsConfig.posthogKey = "phc_test";
    capture.mockImplementationOnce(() => {
      throw new Error("posthog exploded");
    });

    expect(() =>
      captureEvent("meeting_started", { userId: "user-1" }),
    ).not.toThrow();
  });

  it("flushes on shutdown only when a client was created", async () => {
    await shutdownAnalytics();
    expect(shutdown).not.toHaveBeenCalled();

    analyticsConfig.posthogKey = "phc_test";
    captureEvent("meeting_started", { userId: "user-1" });
    await shutdownAnalytics();

    expect(shutdown).toHaveBeenCalledTimes(1);
  });
});
