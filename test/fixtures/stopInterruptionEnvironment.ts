import type { MeetingData } from "../../src/types/meeting-data";
import type { SessionReservation } from "../../src/types/deploymentControl";
export const mockStopEnvironment = {
  repository: {
    claimCommand: jest.fn(),
    renewCommand: jest.fn(async () => true),
    failCommand: jest.fn(async () => true),
    completeCommand: jest.fn(),
  },
  reconcile: jest.fn(async () => true),
  close: jest.fn(async () => {}),
  terminalRead: jest.fn(),
  receipt: jest.fn(),
  meeting: undefined as MeetingData | undefined,
  ownership: new AbortController(),
  reservations: [] as Array<{ reservation: SessionReservation }>,
};
export function deferredStopEffect() {
  let releaseStop!: () => void;
  const promise = new Promise<void>((completeStop) => {
    releaseStop = completeStop;
  });
  return { promise, release: releaseStop };
}
export function stoppedRecordingFixture(guildId: string) {
  const childSettled = jest.fn();
  const original = {
    guildId,
    meetingId: "synthetic-recording",
    sessionMode: "meeting",
    ownerInstanceId: "synthetic-owner",
    executionVersion: 1,
    voiceOperationAttemptId: "synthetic-voice",
    reservedAt: 0,
    historyKey: { guildId, channelId_timestamp: "voice#start" },
    workHandle: {
      transition: jest.fn(),
      settle: jest.fn(),
      beginOwnedControl: () => ({ settle: childSettled }),
    },
  } as unknown as SessionReservation;
  mockStopEnvironment.reservations.push({ reservation: original });
  mockStopEnvironment.terminalRead.mockResolvedValue({
    ...original,
    status: "complete",
    checkpoint: {
      revision: 1,
      capture: { ...original, channelId_timestamp: "voice#start" },
    },
  });
  return { original, childSettled };
}
jest.mock("../../src/services/activeMeetingLeaseService", () => ({
  getOwnedSessionReservations: () => mockStopEnvironment.reservations,
  getReservationSignal: () => mockStopEnvironment.ownership.signal,
  isReservationControlEligible: () => true,
  reconcilePreservedRecordingReservation: (...args: unknown[]) =>
    mockStopEnvironment.reconcile(...args),
}));
jest.mock("../../src/meetings", () => ({
  getPendingMeetingInitializations: () => [],
  getMeeting: () => mockStopEnvironment.meeting,
  deleteMeeting: jest.fn(),
  restoreVoiceSessionNickname: async () => true,
}));
jest.mock("../../src/audio", () => ({
  stopRecordingCapture: jest.fn(),
  closeFailedInitializationOutput: async () => true,
  closeOutputFile: () => mockStopEnvironment.close(),
  waitForCaptureStreamSettlement: async () => {},
}));
jest.mock("../../src/audio/soundCues", () => ({
  stopThinkingCueLoop: jest.fn(),
}));
jest.mock("../../src/services/recordingContentService", () => ({
  checkpointRecordingContext: jest.fn(),
}));
jest.mock("../../src/commands/startMeeting", () => ({}));
jest.mock("../../src/services/runtimeInstanceService", () => ({
  getRuntimeInstanceId: () => "synthetic-owner",
}));
jest.mock("../../src/repositories/meetingControlCommandRepository", () => ({
  getMeetingControlCommandRepository: () => mockStopEnvironment.repository,
}));
jest.mock("../../src/services/guildVoiceOperationService", () => ({
  whenOwnedVoiceSettled: jest.fn(async () => {}),
  settleOwnedVoiceSession: async () => "settled",
  waitOwnedVoiceEffects: async () => {},
}));
jest.mock("../../src/services/recordingCheckpointService", () => ({
  createRecordingCheckpointService: () => ({
    read: async () => ({
      missing: [],
      manifest: { captureState: { kind: "complete" } },
    }),
  }),
}));
