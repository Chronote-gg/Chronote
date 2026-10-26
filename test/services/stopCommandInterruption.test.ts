/** @jest-environment node */
import type { Client } from "discord.js";
import type { MeetingData } from "../../src/types/meeting-data";
import type { SessionReservation } from "../../src/types/deploymentControl";
import type { MeetingControlCommand } from "../../src/types/meetingControl";
import { processMeetingControlCommand } from "../../src/services/meetingControlWorkerService";
import { runEndMeetingFlow } from "../../src/commands/endMeeting";
import { getMeetingInterruptionCheckpoints } from "../../src/services/ownedMeetingInterruption";
import { getRuntimeWorkAdmissionCheckpoints } from "../../src/services/runtimeWorkAdmissionService";
const mockRepository = {
  claimCommand: jest.fn(),
  renewCommand: jest.fn(async () => true),
  failCommand: jest.fn(async () => true),
  completeCommand: jest.fn(),
};
const mockReconcile = jest.fn(async () => true);
const mockClose = jest.fn(async () => {});
const mockTerminalRead = jest.fn();
let mockMeeting: MeetingData;
let mockOwnership = new AbortController();
const mockReservations: Array<{ reservation: SessionReservation }> = [];
jest.mock("../../src/commands/startMeeting", () => ({}));
jest.mock("../../src/services/runtimeInstanceService", () => ({
  getRuntimeInstanceId: () => "synthetic-owner",
}));
jest.mock("../../src/repositories/meetingControlCommandRepository", () => ({
  getMeetingControlCommandRepository: () => mockRepository,
}));
jest.mock("../../src/services/runtimeLifecycleService", () => ({
  beginRuntimeWork: () => {
    throw new Error("Unexpected independent work");
  },
}));
jest.mock("../../src/services/activeMeetingLeaseService", () => ({
  getOwnedSessionReservations: () => mockReservations,
  getReservationSignal: () => mockOwnership.signal,
  isReservationControlEligible: () => true,
  reconcilePreservedRecordingReservation: (...args: unknown[]) =>
    mockReconcile(...args),
}));
jest.mock("../../src/meetings", () => ({
  getMeeting: () => mockMeeting,
  deleteMeeting: jest.fn(),
  restoreVoiceSessionNickname: async () => true,
}));
jest.mock("../../src/audio", () => ({
  stopRecordingCapture: jest.fn(),
  closeFailedInitializationOutput: async () => true,
  closeOutputFile: () => mockClose(),
  waitForCaptureStreamSettlement: async () => {},
}));
jest.mock("../../src/audio/soundCues", () => ({
  stopThinkingCueLoop: jest.fn(),
}));
jest.mock("../../src/services/recordingContentService", () => ({
  checkpointRecordingContext: jest.fn(),
}));
jest.mock("../../src/services/guildVoiceOperationService", () => ({
  settleOwnedVoiceSession: async () => "settled",
  waitOwnedVoiceEffects: async () => {},
}));
jest.mock("../../src/db", () => ({
  getDeploymentControlRepository: () => ({
    getMeetingHistory: () => mockTerminalRead(),
  }),
}));
jest.mock("../../src/services/recordingCheckpointService", () => ({
  createRecordingCheckpointService: () => ({
    read: async () => ({
      missing: [],
      manifest: { captureState: { kind: "complete" } },
    }),
  }),
}));
function held() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
test.each(["acknowledged", "lost_ack", "changed_original"] as const)(
  "actual stop-command finalization failure handles %s without releasing before actual parent effects",
  async (outcome) => {
    jest.clearAllMocks();
    mockOwnership = new AbortController();
    mockReservations.length = 0;
    mockRepository.failCommand.mockReset();
    if (outcome === "lost_ack")
      mockRepository.failCommand.mockRejectedValue(
        new Error("Synthetic lost terminal ACK"),
      );
    else mockRepository.failCommand.mockResolvedValue(true);
    const cleanup = held();
    mockClose.mockReturnValue(cleanup.promise);
    const childSettled = jest.fn();
    const original = {
      guildId: `synthetic-parent-${outcome}`,
      meetingId: "synthetic-recording",
      sessionMode: "meeting",
      ownerInstanceId: "synthetic-owner",
      executionVersion: 1,
      voiceOperationAttemptId: "synthetic-voice",
      reservedAt: 0,
      historyKey: {
        guildId: `synthetic-parent-${outcome}`,
        channelId_timestamp: "voice#start",
      },
      workHandle: {
        transition: jest.fn(),
        settle: jest.fn(),
        beginOwnedControl: () => ({ settle: childSettled }),
      },
    } as unknown as SessionReservation;
    mockReservations.push({ reservation: original });
    const checkpoint = {
      revision: 1,
      capture: { ...original, channelId_timestamp: "voice#start" },
    };
    mockTerminalRead.mockResolvedValue({
      ...original,
      status: "complete",
      checkpoint,
    });
    const client = {
      guilds: {
        cache: new Map([
          [
            original.guildId,
            { members: { cache: new Map([["synthetic-user", {}]]) } },
          ],
        ]),
      },
    } as unknown as Client;
    mockMeeting = {
      ...original,
      reservation: original,
      creator: { id: "synthetic-user" },
      channelId: "voice",
      startTime: new Date(0),
      setFinished: jest.fn(),
      audioData: {},
      recordingCapture: {
        finish: jest.fn(async () => {
          if (outcome === "changed_original") {
            original.executionVersion += 1;
            mockOwnership.abort();
          }
          throw new Error("Synthetic processing failure");
        }),
        fence: jest.fn(),
        settled: async () => {},
        releaseSettledBuffers: jest.fn(),
      },
      onEndMeeting: (meeting: MeetingData) =>
        runEndMeetingFlow({ client, meeting }),
    } as unknown as MeetingData;
    const command: MeetingControlCommand = {
      requestId: `synthetic-stop-parent-${outcome}`,
      commandType: "stop_meeting",
      queueStatus: "pending",
      userId: "synthetic-user",
      input: { serverId: original.guildId, meetingId: original.meetingId },
      createdAt: "synthetic",
      updatedAt: "synthetic",
      expiresAt: 9_999_999_999,
    };
    mockRepository.claimCommand.mockResolvedValue(command);
    try {
      await processMeetingControlCommand(client, command);
      expect(mockRepository.failCommand).toHaveBeenCalledTimes(
        outcome === "changed_original" ? 0 : 1,
      );
      expect(mockRepository.completeCommand).not.toHaveBeenCalled();
      expect(mockReconcile).not.toHaveBeenCalled();
      expect(mockMeeting.setFinished).not.toHaveBeenCalled();
      cleanup.release();
      const interruption = getMeetingInterruptionCheckpoints().find(
        ({ meeting }) => meeting === mockMeeting,
      )!;
      expect(await interruption.actual).toEqual({
        kind: outcome === "acknowledged" ? "settled" : "unresolved",
      });
      expect(childSettled).toHaveBeenCalledTimes(
        outcome === "acknowledged" ? 1 : 0,
      );
      const claim = getRuntimeWorkAdmissionCheckpoints().find(
        ({ id }) => id === command.requestId,
      );
      if (outcome === "acknowledged") expect(claim).toBeUndefined();
      else expect(claim).toMatchObject({ fenced: true, localSettled: true });
      expect(mockReconcile).toHaveBeenCalledTimes(
        outcome === "acknowledged" ? 1 : 0,
      );
    } finally {
      cleanup.release();
      await getMeetingInterruptionCheckpoints().find(
        ({ meeting }) => meeting === mockMeeting,
      )?.actual;
    }
  },
);
