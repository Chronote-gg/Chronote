/** @jest-environment node */
jest.mock("dotenv", () => ({ config: jest.fn() }));
jest.mock("../../src/services/recordingCheckpointService", () => ({
  createRecordingCheckpointService: () => ({
    read: async () => ({ missing: [] }),
    readVerifiedObject: async () => Buffer.from("saved"),
  }),
}));
jest.mock("../../src/db", () => ({
  getActiveMeetingLease: jest.fn(),
  renewActiveMeetingLease: jest.fn(async () => true),
  releaseActiveMeetingLease: jest.fn(),
  getDeploymentControlRepository: jest.fn(),
}));
jest.mock("../../src/services/runtimeLifecycleService", () => ({
  beginRuntimeWork: jest.fn(() => ({
    settle: jest.fn(),
    transition: jest.fn(),
  })),
  getRuntimeAdmissionContext: jest.fn(async () => ({
    instanceId: "worker",
    now: 1,
  })),
}));
jest.mock("../../src/services/guildVoiceOperationService", () => ({
  whenOwnedVoiceSettled: jest.fn(async () => {}),
  prepareOwnedVoiceSession: jest.fn(),
  settleOwnedVoiceSession: jest.fn(async () => "settled"),
}));
jest.mock("../../src/services/recoveredRecordingProof", () => ({
  matchesRecoveredRecording: jest.fn(() => true),
}));
import {
  getActiveMeetingLease,
  getDeploymentControlRepository,
  releaseActiveMeetingLease,
} from "../../src/db";
import {
  tryAcquireMeetingLease,
  reconcileRecoveredRecordingReservation,
  getOwnedSessionReservations,
} from "../../src/services/activeMeetingLeaseService";
import type { MeetingHistory } from "../../src/types/db";
import { randomUUID } from "node:crypto";

test.each(["absent", "newer_lease", "stale_history"])(
  "recovered local release requires exact snapshot and absence: %s",
  async (scenario) => {
    const guildId = randomUUID();
    const row = {
      guildId,
      meetingId: guildId,
      channelId_timestamp: "voice#start",
      channelId: "voice",
      timestamp: "start",
      participants: [],
      duration: 0,
      transcribeMeeting: true,
      generateNotes: true,
      recoveryTranscript: { object: {} },
    } as MeetingHistory;
    const history = jest.fn(async () =>
      scenario === "stale_history" ? { ...row, executionVersion: 99 } : row,
    );
    jest.mocked(getDeploymentControlRepository).mockReturnValue({
      reserveSession: jest.fn(async () => ({ kind: "admitted" })),
      getMeetingHistory: history,
    } as never);
    const result = await tryAcquireMeetingLease({
      guildId,
      meetingId: guildId,
      voiceChannelId: "voice",
      textChannelId: "text",
      isAutoRecording: false,
      sessionMode: "meeting",
      reservedAt: Date.now(),
      history: row,
    });
    if (
      result.kind !== "admitted" ||
      result.reservation.sessionMode !== "meeting"
    )
      throw new Error("admission failed");
    const reservation = result.reservation;
    jest
      .mocked(getActiveMeetingLease)
      .mockResolvedValue(
        scenario === "newer_lease"
          ? ({ guildId, executionVersion: 3 } as never)
          : undefined,
      );
    const released = await reconcileRecoveredRecordingReservation(reservation, {
      history: row,
      localWork: Promise.resolve(),
      signal: new AbortController().signal,
      deadline: Date.now() + 10000,
    });
    expect(released).toBe(scenario === "absent");
    expect(reservation.workHandle.settle).toHaveBeenCalledTimes(
      scenario === "absent" ? 1 : 0,
    );
    expect(releaseActiveMeetingLease).not.toHaveBeenCalled();
    expect(
      getOwnedSessionReservations().some(
        (entry) => entry.reservation === reservation,
      ),
    ).toBe(scenario !== "absent");
  },
);
