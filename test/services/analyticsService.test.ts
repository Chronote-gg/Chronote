/** @jest-environment node */
import { beforeEach, afterEach, it, expect, jest } from "@jest/globals";
let captureEvent: typeof import("../../src/services/analyticsService").captureEvent;
let shutdownAnalytics: typeof import("../../src/services/analyticsService").shutdownAnalytics;
let config: typeof import("../../src/services/configService").config;
const mockCapture = jest.fn();
jest.mock("posthog-node", () => ({
  PostHog: jest.fn(() => ({
    capture: (...args: unknown[]) => mockCapture(...args),
    shutdown: async () => undefined,
  })),
}));
beforeEach(async () => {
  // Shutdown is terminal, so each test needs a fresh module instance.
  jest.resetModules();
  ({ captureEvent, shutdownAnalytics } =
    await import("../../src/services/analyticsService"));
  ({ config } = await import("../../src/services/configService"));
  mockCapture.mockReset();
  config.analytics.posthogKey = "";
});
afterEach(async () => {
  await shutdownAnalytics();
});
it("does not send without a key or usable identity", () => {
  captureEvent("example", { guildId: "fixture" });
  expect(mockCapture).not.toHaveBeenCalled();
  config.analytics.posthogKey = "phc_fixture";
  captureEvent("example");
  expect(mockCapture).not.toHaveBeenCalled();
});
it("uses the standard observation timestamp and namespaced guild identity without inventing an actor", () => {
  config.analytics.posthogKey = "phc_fixture";
  const timestamp = new Date("2026-10-14T12:00:00Z");
  captureEvent("billing_subscription_state_changed", {
    guildId: "fixture",
    timestamp,
    properties: { to_state: "ended" },
  });
  expect(mockCapture).toHaveBeenCalledWith(
    expect.objectContaining({
      distinctId: "guild:fixture",
      timestamp,
      properties: expect.objectContaining({
        guild_id: "fixture",
        to_state: "ended",
      }),
    }),
  );
});
it("never throws a client failure into billing", () => {
  config.analytics.posthogKey = "phc_fixture";
  mockCapture.mockImplementationOnce(() => {
    throw Error("outage");
  });
  expect(() => captureEvent("example", { guildId: "fixture" })).not.toThrow();
  expect(mockCapture).toHaveBeenCalledTimes(1);
});
