/** @jest-environment node */
import type { Client } from "discord.js";
import type { MeetingControlCommand } from "../../src/types/meetingControl";
import { pollerRepository } from "./workerPollerModules.fixture";

const mockState = { eligible: false, captures: 0 };
const {
  controlList: mockControlList,
  controlClaim: mockControlClaim,
  personalList: mockPersonalList,
} = pollerRepository;
const mockRenewalLease = jest.fn();
function mockPollerModules() {
  return jest.requireActual<typeof import("./workerPollerModules.fixture")>(
    "./workerPollerModules.fixture",
  );
}
jest.mock("../../src/services/workerRegistry", () => ({
  isEligible: () => mockState.eligible,
}));
jest.mock("../../src/meetings", () => ({
  getAllMeetings: () =>
    Array.from({ length: mockState.captures }, (_, index) => ({
      meetingId: `synthetic-meeting-${index}`,
    })),
}));
jest.mock(
  "../../src/repositories/meetingControlCommandRepository",
  () => mockPollerModules().meetingControlCommandRepositoryModule,
);
jest.mock(
  "../../src/repositories/personalMediaUploadRepository",
  () => mockPollerModules().personalMediaUploadRepositoryModule,
);
jest.mock("../../src/repositories/jobLeaseRepository", () => ({
  getJobLeaseRepository: () => ({
    tryAcquireJobLease: mockRenewalLease,
    releaseJobLease: jest.fn(),
  }),
}));
jest.mock("../../src/services/meetingControlBotService");
jest.mock("../../src/services/personalMediaUploadProcessingService");
jest.mock("../../src/services/runtimeInstanceService", () => ({
  getRuntimeInstanceId: () => "synthetic-self",
}));
jest.mock("../../src/db", () => ({ personalMediaClaimForJob: jest.fn() }));

import {
  startMeetingControlCommandWorker,
  stopMeetingControlCommandWorker,
} from "../../src/services/meetingControlWorkerService";
import {
  startPersonalMediaUploadWorker,
  stopPersonalMediaUploadWorker,
} from "../../src/services/personalMediaUploadWorkerService";
import {
  startRenewalRecoveryWorker,
  stopRenewalRecoveryWorker,
} from "../../src/services/renewalRecoveryWorkerService";
import { createProcessingRetryWorker } from "../../src/services/processingRetryWorkerService";
import { createMeetingUpdateDeliveryWorker } from "../../src/services/meetingUpdateDeliveryWorkerService";
import { config } from "../../src/services/configService";
import type { StripeClient } from "../../src/types/stripe";

const POLL_INTERVAL_MS = 60_000;
const command = (
  requestId: string,
  targetOwnerInstanceId?: string,
): MeetingControlCommand =>
  ({
    requestId,
    commandType: "stop_meeting",
    input: {},
    ...(targetOwnerInstanceId ? { targetOwnerInstanceId } : {}),
  }) as MeetingControlCommand;

const originalMode = config.subscription.stripeMode;
beforeEach(() => {
  jest.useFakeTimers();
  mockState.eligible = false;
  mockState.captures = 0;
  mockControlList.mockReset().mockResolvedValue([]);
  mockControlClaim.mockReset().mockResolvedValue(undefined);
  mockPersonalList.mockReset().mockResolvedValue([]);
  mockRenewalLease.mockReset().mockResolvedValue(false);
  config.subscription.stripeMode = "test";
});
afterEach(async () => {
  await Promise.all([
    stopMeetingControlCommandWorker(),
    stopPersonalMediaUploadWorker(),
    stopRenewalRecoveryWorker(),
  ]);
  config.subscription.stripeMode = originalMode;
  jest.useRealTimers();
});

async function tick() {
  await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
}

test("module pollers query nothing while the worker is not eligible and resume once it is", async () => {
  startMeetingControlCommandWorker({} as Client);
  startPersonalMediaUploadWorker();
  startRenewalRecoveryWorker({} as StripeClient);
  await tick();
  expect(mockControlList).not.toHaveBeenCalled();
  expect(mockPersonalList).not.toHaveBeenCalled();
  expect(mockRenewalLease).not.toHaveBeenCalled();
  mockState.eligible = true;
  await tick();
  expect(mockControlList).toHaveBeenCalled();
  expect(mockPersonalList).toHaveBeenCalled();
  expect(mockRenewalLease).toHaveBeenCalled();
});

test("factory pollers query nothing while the worker is not eligible", async () => {
  const eligible = { value: false };
  const retryList = jest.fn(async () => []);
  const retry = createProcessingRetryWorker({
    repository: { listDue: retryList } as never,
    rows: { getStrong: jest.fn() },
    run: jest.fn(),
    save: jest.fn(),
    available: async () => true,
    reader: jest.fn(),
    now: () => 0,
    instanceId: () => "synthetic-self",
    isEligible: () => eligible.value,
  });
  const deliveryList = jest.fn(async () => ({ keys: [] }));
  const delivery = createMeetingUpdateDeliveryWorker({
    repository: { listDue: deliveryList, getStrong: jest.fn() },
    deliver: jest.fn(),
    reconcile: jest.fn(),
    now: () => Date.now() / 1000,
    isEligible: () => eligible.value,
  });
  await retry.poll();
  await delivery.poll();
  expect(retryList).not.toHaveBeenCalled();
  expect(deliveryList).not.toHaveBeenCalled();
  eligible.value = true;
  await retry.poll();
  await delivery.poll();
  expect(retryList).toHaveBeenCalledTimes(1);
  expect(deliveryList).toHaveBeenCalledTimes(1);
  await Promise.all([retry.stop(), delivery.stop()]);
});

test("a draining worker's control poller sees only commands targeted at itself", async () => {
  mockState.captures = 1;
  mockControlList.mockResolvedValue([
    command("synthetic-untargeted"),
    command("synthetic-elsewhere", "synthetic-other"),
    command("synthetic-mine", "synthetic-self"),
  ]);
  // Stopping a module poller is final, so this test gets its own copy of the module.
  let control!: typeof import("../../src/services/meetingControlWorkerService");
  await jest.isolateModulesAsync(async () => {
    control = await import("../../src/services/meetingControlWorkerService");
  });
  control.startMeetingControlCommandWorker({} as Client);
  await tick();
  expect(
    new Set(mockControlClaim.mock.calls.map(([input]) => input.requestId)),
  ).toEqual(new Set(["synthetic-mine"]));
  mockState.captures = 0;
  mockControlList.mockClear();
  await tick();
  expect(mockControlList).not.toHaveBeenCalled();
  await control.stopMeetingControlCommandWorker();
});
