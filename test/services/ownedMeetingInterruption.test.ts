/** @jest-environment node */
jest.mock("dotenv", () => ({ config: jest.fn() }));
import {
  interruptOwnedMeeting,
  getMeetingInterruptionCheckpoints,
} from "../../src/services/ownedMeetingInterruption";
import type { MeetingData } from "../../src/types/meeting-data";
import {
  closeOutputFile,
  waitForCaptureStreamSettlement,
} from "../../src/audio";
import { fenceAndSettleSessionWork } from "../../src/services/runtimeWorkAdmissionService";
import { waitOwnedVoiceEffects } from "../../src/services/guildVoiceOperationService";
import { stopMeetingProcessing } from "../../src/services/meetingProcessingLifetime";
import {
  getActiveMeetingLease,
  getDeploymentControlRepository,
} from "../../src/db";
import { createRecordingCheckpointService } from "../../src/services/recordingCheckpointService";
import {
  reconcilePreservedTtsReservation,
  reconcilePreservedRecordingReservation,
} from "../../src/services/activeMeetingLeaseService";
const mockPreserve = jest.fn(async () => ({
  kind: "committed",
  checkpoint: { revision: 2 },
}));
const mockRead = jest.fn(async () => ({
  missing: [],
  manifest: { captureState: { kind: "complete" } },
}));
jest.mock("../../src/services/runtimeWorkAdmissionService", () => ({
  fenceAndSettleSessionWork: jest.fn(async () => true),
}));
jest.mock("../../src/audio", () => ({
  closeOutputFile: jest.fn(async () => {}),
  waitForCaptureStreamSettlement: jest.fn(async () => {}),
}));
jest.mock("../../src/commands/endMeeting", () => ({
  fenceMeetingFinalization: jest.fn((meeting) => {
    meeting.finishing = true;
    meeting.captureAudio = false;
    meeting.recordingCapture?.fence();
  }),
}));
jest.mock("../../src/services/meetingProcessingLifetime", () => ({
  ...jest.requireActual("../../src/services/meetingProcessingLifetime"),
  stopMeetingProcessing: jest.fn(async () => {}),
}));
jest.mock("../../src/services/guildVoiceOperationService", () => ({
  whenOwnedVoiceSettled: jest.fn(async () => {}),
  settleOwnedVoiceSession: jest.fn(async () => "settled"),
  waitOwnedVoiceEffects: jest.fn(async () => {}),
}));
jest.mock("../../src/services/activeMeetingLeaseService", () => ({
  reconcilePreservedRecordingReservation: jest.fn(async () => true),
  reconcilePreservedTtsReservation: jest.fn(async () => true),
}));
jest.mock("../../src/meetings", () => ({
  getPendingMeetingInitializations: () => [],
  getMeeting: jest.fn(),
  deleteMeeting: jest.fn(),
  restoreVoiceSessionNickname: jest.fn(async () => true),
}));
jest.mock("../../src/db", () => ({
  getActiveMeetingLease: jest.fn(),
  getDeploymentControlRepository: jest.fn(),
}));
jest.mock("../../src/services/recordingCheckpointService", () => ({
  createRecordingCheckpointService: jest.fn(() => ({
    read: mockRead,
    preserveInitialTerminalRecordingCheckpoint: mockPreserve,
    preserveTerminalRecordingCheckpoint: mockPreserve,
  })),
}));
function held() {
  let release!: () => void;
  const promise = new Promise<void>((done) => {
    release = done;
  });
  return { release, promise };
}
beforeEach(() => {
  jest.clearAllMocks();
  mockPreserve.mockReset();
  mockPreserve.mockResolvedValue({
    kind: "committed",
    checkpoint: { revision: 2 },
  });
});
test.each([true, false])(
  "actual interruption adapter waits content, preservation, receiver and exact child disposition: %s",
  async (childrenSettled) => {
    jest
      .mocked(fenceAndSettleSessionWork)
      .mockResolvedValueOnce(childrenSettled);
    const processing = held();
    const receiver = held();
    const content = held();
    const preservation = held();
    const voiceEffects = held();
    jest
      .mocked(waitOwnedVoiceEffects)
      .mockReturnValueOnce(voiceEffects.promise);
    jest.mocked(stopMeetingProcessing).mockReturnValueOnce(processing.promise);
    jest
      .mocked(waitForCaptureStreamSettlement)
      .mockReturnValueOnce(receiver.promise);
    const owner = {
      guildId: "synthetic",
      meetingId: "synthetic",
      ownerInstanceId: "original",
      executionVersion: 1,
      voiceOperationAttemptId: "original-voice",
      sessionMode: "meeting" as const,
    };
    const meeting = {
      ...owner,
      channelId: "voice",
      voiceChannel: { id: "voice" },
      transcribeMeeting: true,
      generateNotes: true,
      reservation: {
        ...owner,
        reservedAt: 0,
        historyKey: {
          guildId: owner.guildId,
          channelId_timestamp: "voice#start",
        },
      },
      captureStartedAt: new Date(0),
      recordingCaptureState: {
        kind: "interrupted",
        startedAt: new Date(0).toISOString(),
        detectedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
      },
      recordingContentTask: content.promise,
      recordingPreservationTask: preservation.promise.then(() => false),
      recordingCapture: {
        fence: jest.fn(),
        settled: jest.fn(async () => {}),
        pending: () => [],
        releaseSettledBuffers: jest.fn(),
      },
      setFinished: jest.fn(),
      audioData: {},
      ownershipSignal: new AbortController().signal,
    } as unknown as MeetingData;
    jest.mocked(getActiveMeetingLease).mockResolvedValue({
      ...owner,
      leaseExpiresAt: Math.floor(Date.now() / 1000) + 120,
    } as never);
    jest.mocked(getDeploymentControlRepository).mockReturnValue({
      getMeetingHistory: jest.fn(async () => ({
        ...owner,
        status: "processing",
      })),
    } as never);
    const pending = interruptOwnedMeeting(meeting, {
      reason: "shutdown",
      deadline: Date.now() + 100000,
    });
    expect(meeting.captureAudio).toBe(false);
    expect(closeOutputFile).toHaveBeenCalledTimes(1);
    processing.release();
    receiver.release();
    content.release();
    await new Promise<void>((done) => setImmediate(done));
    expect(mockPreserve).not.toHaveBeenCalled();
    preservation.release();
    await new Promise<void>((done) => setImmediate(done));
    expect(mockPreserve).not.toHaveBeenCalled();
    voiceEffects.release();
    expect(await pending).toMatchObject({
      kind: childrenSettled ? "settled" : "unresolved",
    });
    expect(createRecordingCheckpointService).toHaveBeenCalled();
    expect(mockPreserve).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedStatus: "processing",
        status: "interrupted",
        preservation: expect.objectContaining({
          ownership: expect.objectContaining(owner),
        }),
      }),
    );
    expect(reconcilePreservedRecordingReservation).toHaveBeenCalledTimes(
      childrenSettled ? 1 : 0,
    );
    expect(
      meeting.recordingCapture!.releaseSettledBuffers,
    ).toHaveBeenCalledTimes(childrenSettled ? 1 : 0);
    expect(meeting.ownershipSignal!.aborted).toBe(false);
  },
);

test.each(["complete", "processing"] as const)(
  "absent original lease permits only verified completed disposition: %s",
  async (status) => {
    const original = {
      guildId: `synthetic-${status}`,
      meetingId: "synthetic",
      ownerInstanceId: "original",
      executionVersion: 1,
      voiceOperationAttemptId: "original-voice",
      sessionMode: "meeting" as const,
      historyKey: {
        guildId: `synthetic-${status}`,
        channelId_timestamp: "voice#start",
      },
      reservedAt: 0,
    };
    const checkpoint = {
      revision: 1,
      capture: { ...original, ...original.historyKey },
    };
    const meeting = {
      reservation: original,
      guildId: original.guildId,
      channelId: "voice",
      voiceChannel: { id: "voice" },
      captureStartedAt: new Date(0),
      recordingCheckpoint: checkpoint,
      transcribeMeeting: true,
      generateNotes: true,
      recordingCapture: {
        fence: jest.fn(),
        settled: jest.fn(async () => {}),
        pending: () => [],
        releaseSettledBuffers: jest.fn(),
      },
      setFinished: jest.fn(),
      audioData: {},
    } as unknown as MeetingData;
    jest.mocked(getActiveMeetingLease).mockResolvedValue(undefined);
    jest.mocked(getDeploymentControlRepository).mockReturnValue({
      getMeetingHistory: jest.fn(async () => ({
        ...original,
        checkpoint,
        status,
      })),
    } as never);
    mockPreserve.mockImplementationOnce(async () => {
      throw new Error("Original lease absent");
    });
    const result = await interruptOwnedMeeting(meeting, {
      reason: "processing_failure",
      deadline: Date.now() + 100000,
    });
    expect(result.kind).toBe(status === "complete" ? "settled" : "unresolved");
    expect(mockRead).toHaveBeenCalledWith(checkpoint, expect.any(AbortSignal));
    expect(mockPreserve).toHaveBeenCalledTimes(status === "complete" ? 0 : 1);
    expect(reconcilePreservedRecordingReservation).toHaveBeenCalledTimes(
      status === "complete" ? 1 : 0,
    );
    if (status === "processing")
      expect(getMeetingInterruptionCheckpoints()).toContainEqual(
        expect.objectContaining({
          meeting,
          originalAttempt: expect.objectContaining({ executionVersion: 1 }),
          lastAcknowledgedCheckpoint: checkpoint,
        }),
      );
  },
);

test.each([false, true])(
  "TTS interruption waits actual processing and voice effects, retaining prior finalizer uncertainty: %s",
  async (uncertainFinalizer) => {
    const processing = held();
    const transport = held();
    jest.mocked(stopMeetingProcessing).mockReturnValueOnce(processing.promise);
    jest.mocked(waitOwnedVoiceEffects).mockReturnValueOnce(transport.promise);
    const meeting = {
      guildId: `synthetic-tts-${uncertainFinalizer}`,
      meetingId: "synthetic-tts",
      reservation: {
        guildId: `synthetic-tts-${uncertainFinalizer}`,
        meetingId: "synthetic-tts",
        sessionMode: "tts_only",
        ownerInstanceId: "original",
        executionVersion: 1,
        voiceOperationAttemptId: "original-tts",
        reservedAt: 0,
      },
      sessionMode: "tts_only",
      audioData: {},
      setFinished: jest.fn(),
      ...(uncertainFinalizer
        ? {
            finalization: {
              promise: Promise.resolve(),
              disposition: "unresolved",
              controller: new AbortController(),
            },
          }
        : {}),
    } as unknown as MeetingData;
    const interrupted = interruptOwnedMeeting(meeting, {
      reason: "shutdown",
      deadline: Date.now() + 100_000,
    });
    processing.release();
    await new Promise<void>((done) => setImmediate(done));
    expect(reconcilePreservedTtsReservation).not.toHaveBeenCalled();
    transport.release();
    expect(await interrupted).toEqual({
      kind: uncertainFinalizer ? "unresolved" : "settled",
    });
    expect(getDeploymentControlRepository).not.toHaveBeenCalled();
    expect(reconcilePreservedTtsReservation).toHaveBeenCalledTimes(
      uncertainFinalizer ? 0 : 1,
    );
    expect(meeting.setFinished).toHaveBeenCalledTimes(
      uncertainFinalizer ? 0 : 1,
    );
  },
);

test.each(["original", "stale", "wrong-voice"] as const)(
  "actual preservation keeps distinct voice/text identity and %s ownership",
  async (ownership) => {
    const { createRecordingCheckpointService: createRealService } =
      jest.requireActual<
        typeof import("../../src/services/recordingCheckpointService")
      >("../../src/services/recordingCheckpointService");
    const { createMockDeploymentControlRepository } =
      await import("../../src/repositories/deploymentControlRepository");
    const { history } = await import("../deployment/controlFixtures");
    const { createHash } = await import("node:crypto");
    const row = {
      ...history,
      textChannelId: "separate-notes",
      status: "in_progress" as const,
    };
    const original = {
      guildId: row.guildId,
      meetingId: row.meetingId,
      ownerInstanceId: "old",
      executionVersion: 1,
      voiceOperationAttemptId: "voice",
      sessionMode: "meeting" as const,
      reservedAt: Date.parse(row.timestamp),
      historyKey: {
        guildId: row.guildId,
        channelId_timestamp: row.channelId_timestamp,
      },
      workHandle: {
        settle: jest.fn(),
        transition: jest.fn(),
        beginOwnedControl: () => ({ settle: jest.fn() }),
      },
    };
    const lease = {
      ...original,
      voiceChannelId: row.channelId,
      textChannelId: row.textChannelId,
      isAutoRecording: false,
      leaseExpiresAt: Math.floor(Date.now() / 1000) + 120,
      createdAt: row.timestamp,
      updatedAt: row.timestamp,
      expiresAt: 0,
      ...(ownership === "stale"
        ? { ownerInstanceId: "new-owner", executionVersion: 2 }
        : {}),
    };
    const repo = createMockDeploymentControlRepository(
      new Map(),
      new Map([[row.guildId, [row]]]),
      new Map([[row.guildId, lease]]),
    );
    const objects = new Map<string, Buffer>();
    const service = createRealService({
      repository: repo,
      objects: {
        upload: async (key, bytes) => {
          objects.set(key, Buffer.from(bytes));
          return key;
        },
        read: async (key) => objects.get(key),
      },
    });
    jest
      .mocked(createRecordingCheckpointService)
      .mockImplementationOnce(() => service)
      .mockImplementationOnce(() => service);
    jest.mocked(getDeploymentControlRepository).mockReturnValue(repo);
    jest.mocked(getActiveMeetingLease).mockResolvedValue(lease);
    const bytes = Buffer.alloc(96000);
    const artifact = {
      kind: "audio" as const,
      sourceId: "user:generated",
      sequence: 0,
      bytes,
      checksumSha256: createHash("sha256").update(bytes).digest("hex"),
      contentType: "application/octet-stream",
      format: {
        encoding: "pcm_s16le" as const,
        sampleRate: 48000,
        channels: 1,
      },
      coverage: {
        kind: "known" as const,
        intervals: [
          { sourceId: "user:generated", startOffsetMs: 0, durationMs: 1000 },
        ],
      },
    };
    const meeting = {
      guildId: row.guildId,
      meetingId: row.meetingId,
      channelId: "separate-notes",
      textChannel: { id: "separate-notes", send: jest.fn() },
      voiceChannel: {
        id: ownership === "wrong-voice" ? "wrong-voice" : row.channelId,
      },
      reservation: original,
      captureStartedAt: new Date("2026-01-01T00:00:02Z"),
      transcribeMeeting: true,
      generateNotes: true,
      ownershipSignal: new AbortController().signal,
      recordingCaptureState: {
        kind: "interrupted",
        startedAt: "2026-01-01T00:00:02.000Z",
        endedAt: "2026-01-01T00:00:03.000Z",
        detectedAt: "2026-01-01T00:00:03.000Z",
      },
      recordingCapture: {
        fence: jest.fn(),
        settled: async () => {},
        pending: () => [{ artifact }],
        releaseSettledBuffers: jest.fn(),
      },
      setFinished: jest.fn(),
      audioData: {},
    } as unknown as MeetingData;
    expect(
      await interruptOwnedMeeting(meeting, {
        reason: "shutdown",
        deadline: Date.now() + 100000,
      }),
    ).toEqual({ kind: ownership === "original" ? "settled" : "unresolved" });
    expect(meeting.channelId).toBe("separate-notes");
    expect(meeting.textChannel.id).toBe("separate-notes");
    expect(row.textChannelId).toBe("separate-notes");
    expect(meeting.textChannel.send).not.toHaveBeenCalled();
    if (ownership === "original") {
      expect(row.checkpoint!.capture.channelId).toBe(row.channelId);
      expect((await service.read(row.checkpoint!)).manifest.capture).toEqual(
        row.checkpoint!.capture,
      );
      expect(reconcilePreservedRecordingReservation).toHaveBeenCalledWith(
        original,
        expect.anything(),
      );
    } else {
      expect(row.checkpoint).toBeUndefined();
      expect(reconcilePreservedRecordingReservation).not.toHaveBeenCalled();
      expect(
        meeting.recordingCapture!.releaseSettledBuffers,
      ).not.toHaveBeenCalled();
    }
  },
);
