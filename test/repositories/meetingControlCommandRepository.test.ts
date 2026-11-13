/** @jest-environment node */
import { afterEach, describe, expect, test } from "@jest/globals";
import {
  getMeetingControlCommandRepository,
  resetMeetingControlCommandMemoryRepository,
} from "../../src/repositories/meetingControlCommandRepository";
import type { MeetingControlCommand } from "../../src/types/meetingControl";

let mockWorker = "worker-a";
jest.mock("../../src/services/runtimeInstanceService", () => ({
  getRuntimeInstanceId: () => mockWorker,
}));

const NOW = 100;
const CLAIM_EXPIRES_AT = 160;

const makeCommand = (
  overrides?: Partial<MeetingControlCommand>,
): MeetingControlCommand => ({
  requestId: "request-1",
  queueStatus: "pending",
  commandType: "start_meeting",
  userId: "user-1",
  input: {},
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  expiresAt: 1_767_225_600,
  ...overrides,
});

/** Claims as `worker`, which is also the process identity at call time. */
const claimAs = (
  worker: string,
  overrides?: {
    requestId?: string;
    nowEpochSeconds?: number;
    takeOverFrom?: string;
  },
) => {
  mockWorker = worker;
  return getMeetingControlCommandRepository().claimCommand({
    requestId: "request-1",
    instanceId: worker,
    nowEpochSeconds: NOW,
    claimExpiresAt: CLAIM_EXPIRES_AT,
    updatedAt: "2026-01-01T00:00:01.000Z",
    claimId: `claim-${worker}`,
    ...overrides,
  });
};

describe("meetingControlCommandRepository", () => {
  afterEach(() => {
    resetMeetingControlCommandMemoryRepository();
    mockWorker = "worker-a";
  });

  test("lists and claims unowned pending commands", async () => {
    const repository = getMeetingControlCommandRepository();
    await repository.writeCommand(makeCommand());

    await expect(
      repository.listClaimablePendingCommands({
        instanceId: "worker-a",
        nowEpochSeconds: NOW,
        limit: 10,
      }),
    ).resolves.toHaveLength(1);

    expect(await claimAs("worker-a")).toMatchObject({
      requestId: "request-1",
      claimedByInstanceId: "worker-a",
      claimExpiresAt: CLAIM_EXPIRES_AT,
    });
  });

  test("a duplicate request id is refused", async () => {
    const repository = getMeetingControlCommandRepository();
    await repository.writeCommand(makeCommand());
    await expect(
      repository.writeCommand(makeCommand({ userId: "user-2" })),
    ).rejects.toThrow();
    await expect(repository.getCommand("request-1")).resolves.toMatchObject({
      userId: "user-1",
    });
  });

  test("two workers claiming one untargeted command: exactly one wins", async () => {
    await getMeetingControlCommandRepository().writeCommand(makeCommand());
    const claims = await Promise.all([
      claimAs("worker-a"),
      claimAs("worker-b"),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(
      await getMeetingControlCommandRepository().getCommand("request-1"),
    ).toMatchObject({ claimedByInstanceId: "worker-a" });
  });

  test("an expired claim can be taken by another worker", async () => {
    await getMeetingControlCommandRepository().writeCommand(makeCommand());
    expect(await claimAs("worker-a")).toBeDefined();
    expect(await claimAs("worker-b")).toBeUndefined();
    expect(
      await claimAs("worker-b", { nowEpochSeconds: CLAIM_EXPIRES_AT + 1 }),
    ).toMatchObject({ claimedByInstanceId: "worker-b" });
  });

  test("a targeted command is refused to a worker that does not own the meeting and accepted by the owner", async () => {
    await getMeetingControlCommandRepository().writeCommand(
      makeCommand({
        commandType: "stop_meeting",
        input: { serverId: "guild-1", meetingId: "meeting-1" },
        targetOwnerInstanceId: "owner-1",
      }),
    );
    expect(await claimAs("owner-2")).toBeUndefined();
    expect(await claimAs("owner-1")).toMatchObject({
      claimedByInstanceId: "owner-1",
    });
  });

  test("a worker cannot claim under another worker's identity", async () => {
    await getMeetingControlCommandRepository().writeCommand(makeCommand());
    mockWorker = "worker-a";
    await expect(
      getMeetingControlCommandRepository().claimCommand({
        requestId: "request-1",
        instanceId: "worker-b",
        nowEpochSeconds: NOW,
        claimExpiresAt: CLAIM_EXPIRES_AT,
        updatedAt: "2026-01-01T00:00:01.000Z",
        claimId: "claim-b",
      }),
    ).resolves.toBeUndefined();
  });

  test("lists targeted commands for every worker, which decides whether their owner is gone", async () => {
    const repository = getMeetingControlCommandRepository();
    await repository.writeCommand(
      makeCommand({ requestId: "request-1", targetOwnerInstanceId: "owner-1" }),
    );
    await repository.writeCommand(
      makeCommand({ requestId: "request-2", targetOwnerInstanceId: "owner-2" }),
    );

    const listed = await repository.listClaimablePendingCommands({
      instanceId: "owner-1",
      nowEpochSeconds: NOW,
      limit: 10,
    });
    expect(listed.map((command) => command.requestId).sort()).toEqual([
      "request-1",
      "request-2",
    ]);
  });

  test("a targeted command is claimed on behalf of its owner only when that owner is named", async () => {
    await getMeetingControlCommandRepository().writeCommand(
      makeCommand({ targetOwnerInstanceId: "owner-1" }),
    );
    await expect(
      claimAs("worker-a", { takeOverFrom: "owner-2" }),
    ).resolves.toBeUndefined();
    await expect(
      claimAs("worker-a", { takeOverFrom: "owner-1" }),
    ).resolves.toMatchObject({ claimedByInstanceId: "worker-a" });
  });

  test("does not list or claim expired pending commands", async () => {
    const repository = getMeetingControlCommandRepository();
    await repository.writeCommand(makeCommand({ expiresAt: NOW }));

    await expect(
      repository.listClaimablePendingCommands({
        instanceId: "worker-a",
        nowEpochSeconds: NOW + 1,
        limit: 10,
      }),
    ).resolves.toHaveLength(0);

    await expect(
      claimAs("worker-a", { nowEpochSeconds: NOW + 1 }),
    ).resolves.toBeUndefined();
  });

  test("completes commands claimed by the same worker", async () => {
    const repository = getMeetingControlCommandRepository();
    await repository.writeCommand(makeCommand());
    await claimAs("worker-a");

    await expect(
      repository.completeCommand({
        requestId: "request-1",
        instanceId: "worker-a",
        updatedAt: "2026-01-01T00:00:02.000Z",
        claimId: "claim-worker-a",
        nowEpochSeconds: NOW + 2,
        result: {
          status: "started",
          serverId: "guild-1",
          meetingId: "meeting-1",
          voiceChannelId: "voice-1",
          textChannelId: "text-1",
          startedAt: "2026-01-01T00:00:02.000Z",
        },
      }),
    ).resolves.toBe(true);

    await expect(repository.getCommand("request-1")).resolves.toMatchObject({
      queueStatus: "completed",
      result: { status: "started", meetingId: "meeting-1" },
    });
  });
});
