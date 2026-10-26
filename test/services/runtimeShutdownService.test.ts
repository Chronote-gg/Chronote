/** @jest-environment node */
const mockLifecycleStop = jest.fn(async () => {});
const mockInitStop = jest.fn(async () => {});
const mockControlStop = jest.fn(async () => {});
const mockPersonalStop = jest.fn(async () => {});
const mockMeetingUpdateStop = jest.fn(async () => {});
const mockBillingStop = jest.fn(async () => {});
const mockFence = jest.fn();
const mockCloseAdmission = jest.fn();
jest.mock("../../src/meetings", () => ({
  getAllMeetings: () => [],
  stopMeetingInitializations: () => mockInitStop(),
}));
jest.mock("../../src/services/activeMeetingLeaseService", () => ({
  getOwnedSessionReservations: () => [],
  stopReservationRenewals: async () => {},
}));
jest.mock("../../src/services/ownedMeetingInterruption", () => ({
  interruptOwnedMeeting: jest.fn(),
  getMeetingInterruptionCheckpoints: () => [],
}));
jest.mock("../../src/services/runtimeWorkAdmissionService", () => ({
  fenceRuntimeWorkAdmissions: () => mockFence(),
  getRuntimeWorkAdmissionCheckpoints: () => [],
  releaseAcknowledgedRuntimeWork: jest.fn(),
}));
jest.mock("../../src/services/runtimeLifecycleService", () => ({
  closeRuntimeAdmission: () => mockCloseAdmission(),
  getRuntimeWorkCounts: () => ({ ancillary_delivery: 0 }),
  shutdownRuntimeLifecycle: () => mockLifecycleStop(),
}));
jest.mock("../../src/services/meetingUpdateDeliveryWorkerService", () => ({
  stopMeetingUpdateDeliveryWorker: () => mockMeetingUpdateStop(),
}));
jest.mock("../../src/services/renewalRecoveryWorkerService", () => ({
  stopRenewalRecoveryWorker: () => mockBillingStop(),
}));
jest.mock("../../src/services/meetingControlWorkerService", () => ({
  stopMeetingControlCommandWorker: () => mockControlStop(),
}));
jest.mock("../../src/services/personalMediaUploadWorkerService", () => ({
  stopPersonalMediaUploadWorker: () => mockPersonalStop(),
}));
jest.mock("../../src/services/analyticsService", () => ({
  shutdownAnalytics: async () => {},
}));
jest.mock("../../src/services/langfuseClient", () => ({
  shutdownLangfuseClient: async () => {},
}));
jest.mock("../../src/observability/langfuseInstrumentation", () => ({
  shutdownLangfuseTracing: async () => {},
}));
import type { createRuntimeShutdown } from "../../src/services/runtimeShutdownService";
function moduleFactory() {
  let create!: typeof createRuntimeShutdown;
  jest.isolateModules(() => {
    create = jest.requireActual<
      typeof import("../../src/services/runtimeShutdownService")
    >("../../src/services/runtimeShutdownService").createRuntimeShutdown;
  });
  return create;
}
function held() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
afterEach(() => jest.restoreAllMocks());
test("composed owner seals every source synchronously and waits actual worker and initialization lifetimes", async () => {
  jest.clearAllMocks();
  const init = held();
  const poll = held();
  mockInitStop.mockReturnValueOnce(init.promise);
  mockControlStop.mockReturnValueOnce(poll.promise);
  const exit = jest
    .spyOn(process, "exit")
    .mockImplementation(() => undefined as never);
  const destroyBot = jest.fn(async () => {});
  const owner = moduleFactory()({
    stopBotAdmission: jest.fn(),
    closeServer: async () => {},
    destroyBot,
  });
  try {
    const result = owner.request("signal");
    expect(mockCloseAdmission).toHaveBeenCalledTimes(1);
    expect(mockFence).toHaveBeenCalledTimes(1);
    expect(mockPersonalStop).toHaveBeenCalledTimes(1);
    expect(mockBillingStop).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(exit).not.toHaveBeenCalled();
    init.release();
    await Promise.resolve();
    expect(destroyBot).not.toHaveBeenCalled();
    poll.release();
    expect(await result).toEqual({ kind: "settled" });
    expect(destroyBot).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  } finally {
    init.release();
    poll.release();
    owner.dispose();
  }
});
test("zero work counts cannot turn a rejected actual server close into successful shutdown", async () => {
  const exit = jest
    .spyOn(process, "exit")
    .mockImplementation(() => undefined as never);
  const owner = moduleFactory()({
    stopBotAdmission: jest.fn(),
    closeServer: async () => {
      throw new Error("Synthetic close failure");
    },
    destroyBot: async () => {},
  });
  try {
    expect(await owner.request("signal")).toEqual({ kind: "unresolved" });
    expect(exit).toHaveBeenCalledWith(1);
  } finally {
    owner.dispose();
  }
});

test("composed shutdown awaits the meeting update provider lifetime", async () => {
  const tail = held();
  mockMeetingUpdateStop.mockReturnValueOnce(tail.promise);
  const exit = jest
    .spyOn(process, "exit")
    .mockImplementation(() => undefined as never);
  const owner = moduleFactory()({
    stopBotAdmission: jest.fn(),
    closeServer: async () => {},
    destroyBot: async () => {},
  });
  try {
    let settled = false;
    const result = owner.request("signal").then((value) => {
      settled = true;
      return value;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(exit).not.toHaveBeenCalled();
    tail.release();
    expect(await result).toEqual({ kind: "settled" });
  } finally {
    tail.release();
    owner.dispose();
  }
});
