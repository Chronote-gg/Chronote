/** @jest-environment node */
import type { Client } from "discord.js";
import type { MeetingControlCommand } from "../../src/types/meetingControl";
import {
  pollMeetingControlCommands,
  processMeetingControlCommand,
} from "../../src/services/meetingControlWorkerService";
import { executeMeetingControlCommand } from "../../src/services/meetingControlBotService";
import {
  getMeetingControlCommandRepository,
  resetMeetingControlCommandMemoryRepository,
} from "../../src/repositories/meetingControlCommandRepository";
import { getMockStore } from "../../src/repositories/mockStore";

let mockWorker = "synthetic-worker";
let mockShutdown = new AbortController();
jest.mock("../../src/services/runtimeInstanceService", () => ({
  getRuntimeInstanceId: () => mockWorker,
}));
jest.mock("../../src/services/shutdownSignal", () => ({
  operationSignal: (...extra: AbortSignal[]) =>
    AbortSignal.any([mockShutdown.signal, ...extra]),
}));
const CLAIM_LOST_AFTER_MS = 120_000;
jest.mock("../../src/services/meetingControlBotService", () => ({
  executeMeetingControlCommand: jest.fn(),
}));
const mockRegistry = {
  eligible: true,
  fresh: new Set<string>(),
};
jest.mock("../../src/services/workerRegistry", () => ({
  isEligible: () => mockRegistry.eligible,
  isWorkerFresh: (instanceId: string) => mockRegistry.fresh.has(instanceId),
}));
const mockLive = { captures: 0 };
jest.mock("../../src/meetings", () => ({
  getAllMeetings: () =>
    Array.from({ length: mockLive.captures }, () => ({
      meetingId: "synthetic-meeting",
    })),
}));
const mockLease: {
  read: () => Promise<
    | { meetingId: string; ownerInstanceId: string; leaseExpiresAt: number }
    | undefined
  >;
} = { read: async () => undefined };
jest.mock("../../src/services/meetingLease", () => ({
  getActiveMeetingLeaseForGuild: () => mockLease.read(),
  isLeaseActive: (lease: { leaseExpiresAt: number }) =>
    lease.leaseExpiresAt >= Math.floor(Date.now() / 1000),
}));

const client = {} as Client;
const command = (
  overrides?: Partial<MeetingControlCommand>,
): MeetingControlCommand => ({
  requestId: "synthetic-command",
  queueStatus: "pending",
  commandType: "get_live_meeting_status",
  userId: "synthetic-user",
  input: { serverId: "synthetic-guild" },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  expiresAt: 9_999_999_999,
  ...overrides,
});
const stored = (requestId = "synthetic-command") =>
  getMeetingControlCommandRepository().getCommand(requestId);

beforeEach(() => {
  resetMeetingControlCommandMemoryRepository();
  getMockStore().deploymentControlRecords.clear();
  jest.mocked(executeMeetingControlCommand).mockReset();
  mockWorker = "synthetic-worker";
  mockShutdown = new AbortController();
  mockRegistry.eligible = true;
  mockRegistry.fresh = new Set();
  mockLive.captures = 0;
  mockLease.read = async () => undefined;
});
afterEach(() => {
  jest.restoreAllMocks();
});

test("a worker claims, executes and completes a command with no deployment control record", async () => {
  await getMeetingControlCommandRepository().writeCommand(command());
  jest.mocked(executeMeetingControlCommand).mockResolvedValue({
    status: "in_progress",
    serverId: "synthetic-guild",
    meetingId: "synthetic-meeting",
  } as never);
  await processMeetingControlCommand(client, command());
  expect(executeMeetingControlCommand).toHaveBeenCalledTimes(1);
  await expect(stored()).resolves.toMatchObject({
    queueStatus: "completed",
    claimedByInstanceId: "synthetic-worker",
    result: { meetingId: "synthetic-meeting" },
  });
});

test("a product refusal fails the command with its message", async () => {
  await getMeetingControlCommandRepository().writeCommand(command());
  jest
    .mocked(executeMeetingControlCommand)
    .mockRejectedValue(new Error("Meeting not found."));
  await processMeetingControlCommand(client, command());
  await expect(stored()).resolves.toMatchObject({
    queueStatus: "failed",
    error: "Meeting not found.",
  });
});

test("a command targeted at another owner is never executed here", async () => {
  const targeted = command({ targetOwnerInstanceId: "synthetic-other" });
  await getMeetingControlCommandRepository().writeCommand(targeted);
  await processMeetingControlCommand(client, targeted);
  expect(executeMeetingControlCommand).not.toHaveBeenCalled();
  await expect(stored()).resolves.toMatchObject({ queueStatus: "pending" });
});

test("a command already claimed is executed at most once", async () => {
  await getMeetingControlCommandRepository().writeCommand(command());
  let release!: () => void;
  const held = new Promise<never>((resolve) => {
    release = () => resolve({} as never);
  });
  jest.mocked(executeMeetingControlCommand).mockReturnValue(held);
  const first = processMeetingControlCommand(client, command());
  await processMeetingControlCommand(client, command());
  release();
  await first;
  expect(executeMeetingControlCommand).toHaveBeenCalledTimes(1);
});

test("a command that succeeded is completed even when its signal aborted afterwards", async () => {
  await getMeetingControlCommandRepository().writeCommand(command());
  jest
    .mocked(executeMeetingControlCommand)
    .mockImplementation(async (_client, _command, _assertOwned, signal) => {
      mockShutdown.abort();
      expect(signal?.aborted).toBe(true);
      return { status: "ended", serverId: "synthetic-guild" } as never;
    });
  await processMeetingControlCommand(client, command());
  await expect(stored()).resolves.toMatchObject({
    queueStatus: "completed",
    result: { status: "ended" },
  });
});

test("a command that failed is marked failed even when its signal is aborted", async () => {
  await getMeetingControlCommandRepository().writeCommand(command());
  jest.mocked(executeMeetingControlCommand).mockImplementation(async () => {
    mockShutdown.abort();
    throw new Error("Synthetic interrupted start");
  });
  await processMeetingControlCommand(client, command());
  await expect(stored()).resolves.toMatchObject({
    queueStatus: "failed",
    error: "Synthetic interrupted start",
  });
});

test("a terminal write after the claim was lost is refused by the repository and the command is not re-executed by this worker", async () => {
  const repository = getMeetingControlCommandRepository();
  await repository.writeCommand(command());
  const later = Date.now() + CLAIM_LOST_AFTER_MS;
  jest.mocked(executeMeetingControlCommand).mockImplementation(async () => {
    jest.spyOn(Date, "now").mockReturnValue(later);
    mockWorker = "synthetic-other";
    await repository.claimCommand({
      requestId: "synthetic-command",
      instanceId: "synthetic-other",
      claimId: "synthetic-other-claim",
      nowEpochSeconds: Math.floor(later / 1000),
      claimExpiresAt: Math.floor(later / 1000) + 60,
      updatedAt: "synthetic",
    });
    mockWorker = "synthetic-worker";
    return { status: "ended", serverId: "synthetic-guild" } as never;
  });
  await processMeetingControlCommand(client, command());
  await processMeetingControlCommand(client, command());
  expect(executeMeetingControlCommand).toHaveBeenCalledTimes(1);
  await expect(stored()).resolves.toMatchObject({
    queueStatus: "pending",
    claimedByInstanceId: "synthetic-other",
  });
});

const GONE_WORKER = "synthetic-gone";
const stopFor = (targetOwnerInstanceId: string) =>
  command({
    commandType: "stop_meeting",
    input: { serverId: "synthetic-guild", meetingId: "synthetic-meeting" },
    targetOwnerInstanceId,
  });
const liveLease = () => ({
  meetingId: "synthetic-meeting",
  ownerInstanceId: GONE_WORKER,
  leaseExpiresAt: Math.floor(Date.now() / 1000) + 30,
});

test("a draining worker sees only commands targeted at itself", async () => {
  mockRegistry.eligible = false;
  mockLive.captures = 1;
  const repository = getMeetingControlCommandRepository();
  await repository.writeCommand(command({ requestId: "synthetic-untargeted" }));
  await repository.writeCommand(
    command({ requestId: "synthetic-mine", targetOwnerInstanceId: mockWorker }),
  );
  await repository.writeCommand({
    ...stopFor(GONE_WORKER),
    requestId: "synthetic-gone",
  });
  jest.mocked(executeMeetingControlCommand).mockResolvedValue({
    status: "ended",
    serverId: "synthetic-guild",
    meetingId: "synthetic-meeting",
  });
  await pollMeetingControlCommands(client);
  await expect(stored("synthetic-mine")).resolves.toMatchObject({
    queueStatus: "completed",
  });
  await expect(stored("synthetic-untargeted")).resolves.toMatchObject({
    queueStatus: "pending",
  });
  await expect(stored("synthetic-gone")).resolves.toMatchObject({
    queueStatus: "pending",
  });
});

test("a stop targeted at a worker that is gone is answered by an eligible worker as ended", async () => {
  await getMeetingControlCommandRepository().writeCommand(stopFor(GONE_WORKER));
  await pollMeetingControlCommands(client);
  expect(executeMeetingControlCommand).not.toHaveBeenCalled();
  await expect(stored()).resolves.toMatchObject({
    queueStatus: "completed",
    claimedByInstanceId: "synthetic-worker",
    result: {
      status: "ended",
      serverId: "synthetic-guild",
      meetingId: "synthetic-meeting",
    },
  });
});

test("a live-status command for a gone worker's ended meeting fails as not found", async () => {
  await getMeetingControlCommandRepository().writeCommand(
    command({
      input: { serverId: "synthetic-guild", meetingId: "synthetic-meeting" },
      targetOwnerInstanceId: GONE_WORKER,
    }),
  );
  await pollMeetingControlCommands(client);
  await expect(stored()).resolves.toMatchObject({
    queueStatus: "failed",
    error: "Meeting not found.",
  });
});

test("a command targeted at a fresh worker is left for it", async () => {
  mockRegistry.fresh.add(GONE_WORKER);
  await getMeetingControlCommandRepository().writeCommand(stopFor(GONE_WORKER));
  await pollMeetingControlCommands(client);
  await expect(stored()).resolves.toMatchObject({ queueStatus: "pending" });
  expect((await stored())?.claimedByInstanceId).toBeUndefined();
});

test("a command for a gone worker whose meeting still holds a live lease is left pending", async () => {
  mockLease.read = async () => liveLease();
  await getMeetingControlCommandRepository().writeCommand(stopFor(GONE_WORKER));
  await pollMeetingControlCommands(client);
  await expect(stored()).resolves.toMatchObject({ queueStatus: "pending" });
  expect((await stored())?.claimedByInstanceId).toBeUndefined();
});

test("a failed lease read leaves a gone worker's command pending", async () => {
  mockLease.read = async () => {
    throw new Error("synthetic lease read failure");
  };
  jest.spyOn(console, "warn").mockImplementation(() => {});
  await getMeetingControlCommandRepository().writeCommand(stopFor(GONE_WORKER));
  await pollMeetingControlCommands(client);
  await expect(stored()).resolves.toMatchObject({ queueStatus: "pending" });
});

test("a command running at shutdown is aborted", async () => {
  await getMeetingControlCommandRepository().writeCommand(command());
  jest.mocked(executeMeetingControlCommand).mockImplementation(
    (_client, _command, _assertOwned, signal) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      }),
  );
  const running = processMeetingControlCommand(client, command());
  await new Promise((resolve) => setImmediate(resolve));
  mockShutdown.abort(new Error("Synthetic shutdown"));
  await running;
  await expect(stored()).resolves.toMatchObject({
    queueStatus: "failed",
    error: "Synthetic shutdown",
  });
});
