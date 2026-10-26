/** @jest-environment node */
const mockPosthogShutdown = jest.fn();
const mockCapture = jest.fn();
const mockTracingShutdown = jest.fn();
const mockLangfuseShutdown = jest.fn();
jest.mock("posthog-node", () => ({
  PostHog: jest.fn(() => ({
    capture: mockCapture,
    shutdown: mockPosthogShutdown,
  })),
}));
jest.mock("@opentelemetry/sdk-node", () => ({
  NodeSDK: jest.fn(() => ({ start: jest.fn(), shutdown: mockTracingShutdown })),
}));
jest.mock("@langfuse/otel", () => ({ LangfuseSpanProcessor: jest.fn() }));
jest.mock("@langfuse/client", () => ({
  LangfuseClient: jest.fn(() => ({ shutdown: mockLangfuseShutdown })),
}));
jest.mock("../../src/services/configService", () => ({
  config: {
    mock: { enabled: true },
    analytics: { posthogKey: "synthetic", posthogHost: "http://localhost" },
    langfuse: {
      publicKey: "synthetic",
      secretKey: "synthetic",
      tracingEnabled: true,
      baseUrl: "http://localhost",
    },
  },
}));
import { PostHog } from "posthog-node";
import { LangfuseClient } from "@langfuse/client";
import {
  captureEvent,
  shutdownAnalytics,
} from "../../src/services/analyticsService";
import {
  getLangfuseClient,
  shutdownLangfuseClient,
} from "../../src/services/langfuseClient";
import { shutdownLangfuseTracing } from "../../src/observability/langfuseInstrumentation";
function held() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
test("analytics shutdown shares actual flush lifetime and prevents recreation/late capture", async () => {
  const flush = held();
  mockPosthogShutdown.mockReturnValue(flush.promise);
  captureEvent("synthetic", { userId: "synthetic" });
  const first = shutdownAnalytics();
  const second = shutdownAnalytics();
  let settled = false;
  void first.then(() => {
    settled = true;
  });
  captureEvent("late", { userId: "synthetic" });
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(first).toBe(second);
  expect(mockCapture).toHaveBeenCalledTimes(1);
  expect(mockPosthogShutdown).toHaveBeenCalledTimes(1);
  flush.resolve();
  await first;
  captureEvent("later", { userId: "synthetic" });
  expect(PostHog).toHaveBeenCalledTimes(1);
});
test("tracing and Langfuse client expose actual once-only shutdown promises", async () => {
  const tracing = held();
  const client = held();
  mockTracingShutdown.mockReturnValue(tracing.promise);
  mockLangfuseShutdown.mockReturnValue(client.promise);
  expect(getLangfuseClient()).not.toBeNull();
  const traceShutdown = shutdownLangfuseTracing();
  const clientShutdown = shutdownLangfuseClient();
  expect(shutdownLangfuseTracing()).toBe(traceShutdown);
  expect(shutdownLangfuseClient()).toBe(clientShutdown);
  expect(getLangfuseClient()).toBeNull();
  let settled = false;
  const actual = Promise.all([traceShutdown, clientShutdown]).then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  tracing.resolve();
  await Promise.resolve();
  expect(settled).toBe(false);
  client.resolve();
  await actual;
  expect(LangfuseClient).toHaveBeenCalledTimes(1);
  expect(mockTracingShutdown).toHaveBeenCalledTimes(1);
  expect(mockLangfuseShutdown).toHaveBeenCalledTimes(1);
});
