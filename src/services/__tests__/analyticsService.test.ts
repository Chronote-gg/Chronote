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
    mock: { enabled: false },
    frontend: { siteUrl: "https://sandbox.chronote.gg" },
    get analytics() {
      return analyticsConfig;
    },
  },
}));

let captureEvent: typeof import("../analyticsService").captureEvent;
let shutdownAnalytics: typeof import("../analyticsService").shutdownAnalytics;

describe("analyticsService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    analyticsConfig.posthogKey = "";
    // Shutdown permanently seals a process. Each case needs a fresh module.
    jest.isolateModules(() => {
      ({ captureEvent, shutdownAnalytics } = jest.requireActual<
        typeof import("../analyticsService")
      >("../analyticsService"));
    });
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
      properties: {
        trigger: "manual_command",
        guild_id: "guild-1",
        environment: "sandbox",
        surface: "server",
      },
    });
  });

  it("sends numeric version 3 latency with only the existing identities", () => {
    analyticsConfig.posthogKey = "phc_test";
    captureEvent("meeting_completed", {
      userId: "user-1",
      guildId: "guild-1",
      properties: {
        event_version: 3,
        surface: "discord",
        duration_ms: 60000,
        notes_latency_status: "measured",
        notes_first_delivery_latency_ms: 2000,
        notes_complete_delivery_latency_ms: 5000,
        notes_delivery_path: "live",
      },
    });
    expect(capture).toHaveBeenCalledWith({
      distinctId: "user-1",
      event: "meeting_completed",
      properties: {
        guild_id: "guild-1",
        environment: "sandbox",
        event_version: 3,
        surface: "discord",
        duration_ms: 60000,
        notes_latency_status: "measured",
        notes_first_delivery_latency_ms: 2000,
        notes_complete_delivery_latency_ms: 5000,
        notes_delivery_path: "live",
      },
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

  it("never throws when the client fails for version 3 completion", () => {
    analyticsConfig.posthogKey = "phc_test";
    capture.mockImplementationOnce(() => {
      throw new Error("posthog exploded");
    });

    expect(() =>
      captureEvent("meeting_completed", {
        userId: "user-1",
        guildId: "guild-1",
        properties: { event_version: 3, notes_latency_status: "unknown" },
      }),
    ).not.toThrow();
  });

  it("does not flush when no client was created", async () => {
    await shutdownAnalytics();
    expect(shutdown).not.toHaveBeenCalled();
  });

  it("flushes the created client exactly once and seals later capture", async () => {
    analyticsConfig.posthogKey = "phc_test";
    captureEvent("meeting_started", { userId: "user-1" });
    await shutdownAnalytics();

    await shutdownAnalytics();
    captureEvent("late", { userId: "user-1" });
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(constructPostHog).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledTimes(1);
  });
});
