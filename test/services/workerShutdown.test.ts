/** @jest-environment node */
const mockEvents: string[] = [];
const mockHang = new Set<string>();
const mockFail = new Set<string>();
const mockThrow = new Set<string>();
const mockStarted: Record<string, number> = {};
const mockCalls: Record<string, unknown[][]> = {};

/** Every step records its start and, unless told to hang or fail, settles at once. */
function mockStep(name: string) {
  return (...args: unknown[]) => {
    mockEvents.push(name);
    mockStarted[name] = Date.now();
    (mockCalls[name] ??= []).push(args);
    if (mockThrow.has(name)) throw new Error(`${name} threw`);
    if (mockFail.has(name)) return Promise.reject(new Error(`${name} failed`));
    if (mockHang.has(name)) return new Promise<void>(() => {});
    return Promise.resolve();
  };
}

jest.mock("../../src/services/lifecycleTiming", () => {
  const actual = jest.requireActual<
    typeof import("../../src/services/lifecycleTiming")
  >("../../src/services/lifecycleTiming");
  return {
    ...actual,
    LIFECYCLE: {
      ...actual.LIFECYCLE,
      shutdownBudgetMs: 600,
      shutdownReserveMs: 50,
      shutdownStepMs: 40,
      finishAbortWaitMs: 20,
    },
  };
});
jest.mock("../../src/services/shutdownSignal", () => ({
  // Idempotent, as the real one is: the process owner and the steps both call it.
  beginShutdown: () => {
    if (!mockEvents.includes("beginShutdown")) mockEvents.push("beginShutdown");
  },
}));
jest.mock("../../src/services/workerRegistry", () => ({
  stopWorkerRegistry: mockStep("stopWorkerRegistry"),
}));
jest.mock("../../src/services/meetingControlWorkerService", () => ({
  stopMeetingControlCommandWorker: mockStep("stopControl"),
}));
jest.mock("../../src/services/processingRetryWorkerService", () => ({
  stopProcessingRetryWorker: mockStep("stopProcessingRetry"),
}));
jest.mock("../../src/services/meetingUpdateDeliveryWorkerService", () => ({
  stopMeetingUpdateDeliveryWorker: mockStep("stopMeetingUpdate"),
}));
jest.mock("../../src/services/renewalRecoveryWorkerService", () => ({
  stopRenewalRecoveryWorker: mockStep("stopRenewalRecovery"),
  releaseRenewalRecoveryLease: mockStep("releaseRenewalLease"),
}));
jest.mock("../../src/services/personalMediaUploadWorkerService", () => ({
  stopPersonalMediaUploadWorker: mockStep("stopUploads"),
}));
jest.mock("../../src/meetings", () => ({
  stopMeetingInitializations: mockStep("settleStarts"),
}));
jest.mock("../../src/services/meetingClose", () => ({
  closeAllCaptures: mockStep("closeAllCaptures"),
}));
jest.mock("../../src/services/meetingFinisher", () => ({
  stopMeetingFinisher: mockStep("stopFinisher"),
  releaseLocalFinishClaims: mockStep("releaseFinishClaims"),
}));
jest.mock("../../src/services/runtimeBillingOperationService", () => ({
  drainBillingOperations: mockStep("drainBilling"),
}));
jest.mock("../../src/services/analyticsService", () => ({
  shutdownAnalytics: async () => {},
}));
jest.mock("../../src/services/speechDetectionService", () => ({
  shutdownSpeechDetector: async () => {},
}));
jest.mock("../../src/services/langfuseClient", () => ({
  shutdownLangfuseClient: async () => {},
}));
jest.mock("../../src/observability/langfuseInstrumentation", () => ({
  shutdownLangfuseTracing: async () => {},
}));

import { EventEmitter } from "node:events";
import type * as WorkerShutdown from "../../src/services/workerShutdown";

const EXPECTED_ORDER = [
  "beginShutdown",
  "stopWorkerRegistry",
  "stopUploads",
  "stopControl",
  "stopProcessingRetry",
  "stopMeetingUpdate",
  "stopRenewalRecovery",
  "stopFinisher",
  "stopLocalSweep",
  "settleStarts",
  "closeAllCaptures",
  "releaseFinishClaims",
  "drainBilling",
  "releaseRenewalLease",
  "closeServer",
  "destroyBot",
];

function load(): typeof WorkerShutdown {
  let module!: typeof WorkerShutdown;
  jest.isolateModules(() => {
    module = jest.requireActual<typeof WorkerShutdown>(
      "../../src/services/workerShutdown",
    );
  });
  return module;
}
const resources = () => ({
  closeServer: mockStep("closeServer"),
  destroyBot: mockStep("destroyBot"),
  stopLocalSweep: () => {
    mockEvents.push("stopLocalSweep");
    if (mockThrow.has("stopLocalSweep")) throw new Error("sweep threw");
  },
});

beforeEach(() => {
  mockEvents.length = 0;
  mockHang.clear();
  mockFail.clear();
  mockThrow.clear();
  for (const name of Object.keys(mockStarted)) delete mockStarted[name];
  for (const name of Object.keys(mockCalls)) delete mockCalls[name];
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

test("ready false is written before captures close", async () => {
  await load().runWorkerShutdown(resources(), Date.now() + 500);
  expect(mockEvents.indexOf("stopWorkerRegistry")).toBeLessThan(
    mockEvents.indexOf("closeAllCaptures"),
  );
  expect(mockEvents.indexOf("beginShutdown")).toBe(0);
  expect(mockCalls.closeAllCaptures).toEqual([
    [{ endReason: "unknown", abnormal: true, deadlineMs: expect.any(Number) }],
  ]);
});

test("the steps run in order and a failing step does not stop the rest", async () => {
  mockFail.add("stopWorkerRegistry");
  mockFail.add("closeAllCaptures");
  const settled = await load().runWorkerShutdown(resources(), Date.now() + 500);
  expect(mockEvents).toEqual(EXPECTED_ORDER);
  expect(settled).toBe(false);
});

// Each stage's slice is asserted on a fake clock in workerShutdownBudget.test.ts; wall-clock bounds here failed under load.
test("every step still starts, in order, when every step hangs", async () => {
  for (const name of EXPECTED_ORDER) mockHang.add(name);
  const settled = await load().runWorkerShutdown(resources(), Date.now() + 500);
  expect(mockEvents).toEqual(EXPECTED_ORDER);
  expect(settled).toBe(false);
});

test("a stop that throws synchronously skips none of the other steps", async () => {
  mockThrow.add("stopUploads");
  mockThrow.add("stopControl");
  mockThrow.add("stopLocalSweep");
  const settled = await load().runWorkerShutdown(resources(), Date.now() + 500);
  expect(mockEvents).toEqual(EXPECTED_ORDER);
  expect(settled).toBe(false);
});

test("the finisher stops with the pollers, before captures close, and its claims are released after", async () => {
  await load().runWorkerShutdown(resources(), Date.now() + 500);
  const close = mockEvents.indexOf("closeAllCaptures");
  expect(mockEvents.indexOf("stopFinisher")).toBeLessThan(close);
  expect(mockEvents.indexOf("stopFinisher")).toBeGreaterThan(
    mockEvents.indexOf("stopWorkerRegistry"),
  );
  expect(mockEvents.indexOf("releaseFinishClaims")).toBe(close + 1);
  expect(mockCalls.closeAllCaptures?.[0]?.[0]).toMatchObject({
    abnormal: true,
  });
});

test("a second SIGTERM does nothing new", async () => {
  const signals = new EventEmitter();
  const exit = jest.spyOn(process, "exit").mockImplementation(() => {
    signals.emit("exited");
    return undefined as never;
  });
  const owner = load().installWorkerShutdown(resources(), signals);
  const exited = new Promise((resolve) => signals.once("exited", resolve));
  signals.emit("SIGTERM");
  signals.emit("SIGTERM");
  await exited;
  signals.emit("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(mockEvents).toEqual(EXPECTED_ORDER);
  expect(exit).toHaveBeenCalledTimes(1);
  expect(exit).toHaveBeenCalledWith(0);
  owner.dispose();
});

test("a startup failure exits non-zero after the same shutdown", async () => {
  const signals = new EventEmitter();
  const exit = jest.spyOn(process, "exit").mockImplementation(() => {
    signals.emit("exited");
    return undefined as never;
  });
  const module = load();
  const owner = module.installWorkerShutdown(resources(), signals);
  const exited = new Promise((resolve) => signals.once("exited", resolve));
  module.failWorkerStartup(new Error("synthetic start-up failure"));
  await exited;
  expect(mockEvents).toEqual(EXPECTED_ORDER);
  expect(exit).toHaveBeenCalledWith(1);
  owner.dispose();
});
