/** @jest-environment node */
// Real LIFECYCLE values and real elapsed (fake-timer) time: each step here takes
// the time a test gives it, or hangs, instead of settling in a microtask.
const mockPlan = new Map<string, number | "hang">();
const mockStarted: Record<string, number> = {};
const mockSettled: Record<string, number> = {};

function mockStep(name: string) {
  return () => {
    mockStarted[name] = Date.now();
    const plan = mockPlan.get(name) ?? 0;
    if (plan === "hang") return new Promise<void>(() => {});
    return new Promise<void>((resolve) =>
      setTimeout(() => {
        mockSettled[name] = Date.now();
        resolve();
      }, plan),
    );
  };
}

jest.mock("../../src/services/shutdownSignal", () => ({
  beginShutdown: () => {},
}));
jest.mock("../../src/services/workerRegistry", () => ({
  stopWorkerRegistry: mockStep("registry"),
}));
jest.mock("../../src/services/meetingControlWorkerService", () => ({
  stopMeetingControlCommandWorker: mockStep("control"),
}));
jest.mock("../../src/services/processingRetryWorkerService", () => ({
  stopProcessingRetryWorker: mockStep("processing retry"),
}));
jest.mock("../../src/services/meetingUpdateDeliveryWorkerService", () => ({
  stopMeetingUpdateDeliveryWorker: mockStep("update delivery"),
}));
jest.mock("../../src/services/renewalRecoveryWorkerService", () => ({
  stopRenewalRecoveryWorker: mockStep("renewal recovery"),
  releaseRenewalRecoveryLease: mockStep("renewal lease"),
}));
jest.mock("../../src/services/personalMediaUploadWorkerService", () => ({
  stopPersonalMediaUploadWorker: mockStep("upload poll"),
}));
jest.mock("../../src/meetings", () => ({
  stopMeetingInitializations: mockStep("starts"),
}));
jest.mock("../../src/services/meetingClose", () => ({
  closeAllCaptures: mockStep("captures"),
}));
jest.mock("../../src/services/meetingFinisher", () => ({
  stopMeetingFinisher: mockStep("finisher"),
  releaseLocalFinishClaims: mockStep("finish claims"),
}));
jest.mock("../../src/services/runtimeBillingOperationService", () => ({
  drainBillingOperations: mockStep("billing"),
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

import type * as WorkerShutdown from "../../src/services/workerShutdown";
import { LIFECYCLE } from "../../src/services/lifecycleTiming";

const STEP = LIFECYCLE.shutdownStepMs;
const EARLY_STEPS = [
  "control",
  "processing retry",
  "update delivery",
  "renewal recovery",
  "finisher",
  "starts",
];
const LATER_CAPS = LIFECYCLE.finishAbortWaitMs + STEP + STEP + STEP;
const DEADLINE_MS = LIFECYCLE.shutdownBudgetMs - LIFECYCLE.shutdownReserveMs;

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
  closeServer: mockStep("server"),
  destroyBot: mockStep("bot"),
  stopLocalSweep: () => {},
});

let timedOut: Array<{ step: string; boundMs: number }>;
beforeEach(() => {
  jest.useFakeTimers({ now: 0 });
  mockPlan.clear();
  for (const record of [mockStarted, mockSettled])
    for (const key of Object.keys(record)) delete record[key];
  timedOut = [];
  jest
    .spyOn(console, "warn")
    .mockImplementation(
      (message, details: { step: string; boundMs: number }) => {
        if (message === "Worker shutdown step timed out")
          timedOut.push(details);
      },
    );
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

async function shutdown() {
  const done = load().runWorkerShutdown(resources(), DEADLINE_MS);
  await jest.advanceTimersByTimeAsync(LIFECYCLE.shutdownBudgetMs);
  return done;
}

test("the registry stop is awaited before the pollers stop and before captures close", async () => {
  mockPlan.set("registry", 1_000);
  expect(await shutdown()).toBe(true);
  expect(mockSettled.registry).toBe(1_000);
  for (const name of [...EARLY_STEPS, "captures"])
    expect(mockStarted[name]).toBeGreaterThanOrEqual(mockSettled.registry);
  expect(timedOut).toEqual([]);
});

test("a normal shutdown exits 0: no step reports a timeout when everything settles", async () => {
  for (const name of ["registry", "starts", "captures", "finish claims", "bot"])
    mockPlan.set(name, 500);
  expect(await shutdown()).toBe(true);
  expect(timedOut).toEqual([]);
});

test("each early stage gets its full cap when it hangs and captures still get their floor", async () => {
  for (const name of ["registry", ...EARLY_STEPS, "captures"])
    mockPlan.set(name, "hang");
  expect(await shutdown()).toBe(false);
  const bound = (step: string) =>
    timedOut.find((entry) => entry.step === step)?.boundMs;
  expect(bound("registry")).toBe(STEP);
  for (const name of EARLY_STEPS) expect(bound(name)).toBe(STEP);
  expect(mockStarted.captures).toBe(2 * STEP);
  // The floor capture closing keeps when everything before it hangs.
  expect(bound("captures")).toBe(DEADLINE_MS - 2 * STEP - LATER_CAPS);
});

test("every later stage keeps its slice when everything hangs", async () => {
  for (const name of [
    "registry",
    ...EARLY_STEPS,
    "captures",
    "finish claims",
    "billing",
    "renewal lease",
    "server",
    "bot",
  ])
    mockPlan.set(name, "hang");
  await shutdown();
  const bound = (step: string) =>
    timedOut.find((entry) => entry.step === step)?.boundMs;
  expect(bound("finish claims")).toBe(LIFECYCLE.finishAbortWaitMs + STEP);
  for (const name of ["billing", "renewal lease", "server", "bot"])
    expect(bound(name)).toBe(STEP);
  expect(mockStarted.bot).toBe(DEADLINE_MS - STEP);
});
