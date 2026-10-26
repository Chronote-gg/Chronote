/** @jest-environment node */
import type { Client } from "discord.js";
import type { SessionReservation } from "../../src/types/deploymentControl";
import type { MeetingControlCommand } from "../../src/types/meetingControl";
import { processMeetingControlCommand } from "../../src/services/meetingControlWorkerService";
import {
  beginRuntimeWorkClaim,
  fenceAndSettleSessionWork,
  getRuntimeWorkAdmissionCheckpoints,
} from "../../src/services/runtimeWorkAdmissionService";
import { executeMeetingControlCommand } from "../../src/services/meetingControlBotService";
const mockReservations: Array<{ reservation: SessionReservation }> = [];
const mockRepository = {
  claimCommand: jest.fn(),
  renewCommand: jest.fn(),
  completeCommand: jest.fn(),
  failCommand: jest.fn(),
};
jest.mock("../../src/services/activeMeetingLeaseService", () => ({
  getOwnedSessionReservations: () => mockReservations,
  getReservationSignal: () => new AbortController().signal,
  isReservationControlEligible: () => true,
}));
jest.mock("../../src/services/runtimeLifecycleService", () => ({
  beginRuntimeWork: () => ({ settle: jest.fn(), transition: jest.fn() }),
}));
jest.mock("../../src/services/runtimeInstanceService", () => ({
  getRuntimeInstanceId: () => "synthetic-owner",
}));
jest.mock("../../src/services/meetingControlBotService", () => ({
  executeMeetingControlCommand: jest.fn(),
}));
jest.mock("../../src/repositories/meetingControlCommandRepository", () => ({
  getMeetingControlCommandRepository: () => mockRepository,
}));
function held<T>() {
  let release!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    release = done;
  });
  return { promise, release };
}

test("session interruption seals new children and retains the actual worker renewal after its handler settles", async () => {
  jest.useFakeTimers();
  try {
    const owner = {
      guildId: "synthetic-guild",
      meetingId: "synthetic-meeting",
      ownerInstanceId: "synthetic-owner",
      executionVersion: 1,
      voiceOperationAttemptId: "synthetic-voice",
      sessionMode: "meeting",
      workHandle: { beginOwnedControl: () => ({ settle: jest.fn() }) },
    } as unknown as SessionReservation;
    const other = {
      ...owner,
      guildId: "synthetic-other",
      meetingId: "other",
      voiceOperationAttemptId: "other-voice",
    };
    mockReservations.push({ reservation: owner }, { reservation: other });
    const command: MeetingControlCommand = {
      requestId: "synthetic-command",
      queueStatus: "pending",
      commandType: "get_live_meeting_status",
      userId: "synthetic-user",
      input: { serverId: owner.guildId },
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
      expiresAt: 9999999999,
    };
    const provider = held<never>();
    const renewal = held<boolean>();
    mockRepository.claimCommand.mockResolvedValue(command);
    mockRepository.renewCommand.mockReturnValue(renewal.promise);
    jest.mocked(executeMeetingControlCommand).mockReturnValue(provider.promise);
    const actual = processMeetingControlCommand({} as Client, command);
    await jest.advanceTimersByTimeAsync(30000);
    expect(mockRepository.renewCommand).toHaveBeenCalledTimes(1);
    let settled = false;
    const drain = fenceAndSettleSessionWork(owner).then((result) => {
      settled = true;
      return result;
    });
    expect(() =>
      beginRuntimeWorkClaim("interaction", "late-child", { ...owner }),
    ).toThrow("closing");
    expect(() =>
      beginRuntimeWorkClaim("interaction", "missing-session", {
        guildId: "absent",
        meetingId: owner.meetingId,
      }),
    ).toThrow("not locally owned");
    expect(() =>
      beginRuntimeWorkClaim("interaction", "mismatched-session", {
        guildId: owner.guildId,
        meetingId: "absent",
      }),
    ).toThrow("not locally owned");
    const unrelated = beginRuntimeWorkClaim(
      "interaction",
      "unrelated-child",
      other,
    );
    await unrelated.trackEffect(async () => {});
    await unrelated.settle();
    provider.release({} as never);
    await jest.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    expect(
      getRuntimeWorkAdmissionCheckpoints().find(
        ({ id }) => id === command.requestId,
      ),
    ).toMatchObject({ fenced: true, localSettled: false });
    expect(mockRepository.completeCommand).not.toHaveBeenCalled();
    expect(mockRepository.failCommand).not.toHaveBeenCalled();
    renewal.release(true);
    await actual;
    expect(await drain).toBe(false);
    expect(
      getRuntimeWorkAdmissionCheckpoints().find(
        ({ id }) => id === command.requestId,
      ),
    ).toMatchObject({ fenced: true, localSettled: true });
  } finally {
    jest.useRealTimers();
  }
});
