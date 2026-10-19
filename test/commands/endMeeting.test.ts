import {
  finalizationFixture,
  finalizationCaptureState,
  autoRecordFinalizationFixture,
  acknowledgedEndMeetingButton,
  recordingLimitMeeting,
  recordingOnlyFinalizationState,
  successfulArtifactUpload,
} from "../fixtures/endMeeting";
/** @jest-environment node */

import { interruptOwnedMeeting } from "../../src/services/ownedMeetingInterruption";

import { getNotes } from "../../src/services/notesService";
import { notifyRecordingLimit } from "../../src/services/recordingLimitService";

import { settleOwnedVoiceSession } from "../../src/services/guildVoiceOperationService";

import { getRollingUsageForGuild } from "../../src/services/meetingUsageService";

import type { ButtonInteraction, Client } from "discord.js";
import type { MeetingData } from "../../src/types/meeting-data";
import { Collection } from "discord.js";
import {
  handleEndMeetingButton,
  handleEndMeetingOther,
  runEndMeetingFlow,
  fenceMeetingFinalization,
  preserveMeetingFinalizationCapture,
  persistExplicitMeetingStop,
} from "../../src/commands/endMeeting";
import { startProcessingSnippet } from "../../src/audio";
import { withMeetingEndTrace } from "../../src/observability/meetingTrace";
import { evaluateAutoRecordCancellation } from "../../src/services/autoRecordCancellationService";
import {
  buildMixedAudio,
  cleanupSpeakerTracks,
  closeOutputFile,
  compileTranscriptions,
  waitForAudioOnlyFinishProcessing,
  waitForFinishProcessing,
} from "../../src/audio";
import { uploadMeetingArtifacts } from "../../src/services/uploadService";
import { saveMeetingHistoryToDatabase } from "../../src/commands/saveMeetingHistory";
import {
  cleanupMeetingTempDir,
  retainMeetingTempDir,
} from "../../src/services/tempFileService";
import { getGuildLimits } from "../../src/services/subscriptionService";
import { transitionOwnedMeetingHistoryService } from "../../src/services/meetingHistoryService";
import { deleteIfExists } from "../../src/util";
import { deleteMeeting, getMeeting, hasMeeting } from "../../src/meetings";
import { describeAutoRecordRule } from "../../src/utils/meetingLifecycle";
import { MEETING_END_REASONS } from "../../src/types/meetingLifecycle";
import { releaseMeetingLeaseForMeeting } from "../../src/services/activeMeetingLeaseService";
import { runTranscriptionFinalPass } from "../../src/services/transcriptionFinalPassService";
import { captureEvent } from "../../src/services/analyticsService";
import { ensureMeetingNotes } from "../../src/services/meetingNotesService";
import {
  updateMeetingProcessingMessage,
  updateMeetingSummaryMessage,
} from "../../src/embed";

const mockedStartProcessingSnippet =
  startProcessingSnippet as jest.MockedFunction<typeof startProcessingSnippet>;
const mockedWithMeetingEndTrace = withMeetingEndTrace as jest.MockedFunction<
  typeof withMeetingEndTrace
>;
const mockedEvaluateAutoRecordCancellation =
  evaluateAutoRecordCancellation as jest.MockedFunction<
    typeof evaluateAutoRecordCancellation
  >;
const mockedBuildMixedAudio = buildMixedAudio as jest.MockedFunction<
  typeof buildMixedAudio
>;
const mockedCleanupSpeakerTracks = cleanupSpeakerTracks as jest.MockedFunction<
  typeof cleanupSpeakerTracks
>;
const mockedCloseOutputFile = closeOutputFile as jest.MockedFunction<
  typeof closeOutputFile
>;
const mockedCompileTranscriptions =
  compileTranscriptions as jest.MockedFunction<typeof compileTranscriptions>;
const mockedWaitForAudioOnlyFinishProcessing =
  waitForAudioOnlyFinishProcessing as jest.MockedFunction<
    typeof waitForAudioOnlyFinishProcessing
  >;
const mockedWaitForFinishProcessing =
  waitForFinishProcessing as jest.MockedFunction<
    typeof waitForFinishProcessing
  >;
const mockedUploadMeetingArtifacts =
  uploadMeetingArtifacts as jest.MockedFunction<typeof uploadMeetingArtifacts>;
const mockedCleanupMeetingTempDir =
  cleanupMeetingTempDir as jest.MockedFunction<typeof cleanupMeetingTempDir>;
const mockedRetainMeetingTempDir = retainMeetingTempDir as jest.MockedFunction<
  typeof retainMeetingTempDir
>;
const mockedDeleteIfExists = deleteIfExists as jest.MockedFunction<
  typeof deleteIfExists
>;
const mockedSaveMeetingHistoryToDatabase =
  saveMeetingHistoryToDatabase as jest.MockedFunction<
    typeof saveMeetingHistoryToDatabase
  >;
const mockedGetGuildLimits = getGuildLimits as jest.MockedFunction<
  typeof getGuildLimits
>;
const mockedUpdateMeetingStatusService =
  transitionOwnedMeetingHistoryService as jest.MockedFunction<
    typeof transitionOwnedMeetingHistoryService
  >;
const mockedGetMeeting = getMeeting as jest.MockedFunction<typeof getMeeting>;
const mockedDeleteMeeting = deleteMeeting as jest.MockedFunction<
  typeof deleteMeeting
>;
const mockedHasMeeting = hasMeeting as jest.MockedFunction<typeof hasMeeting>;
const mockedDescribeAutoRecordRule =
  describeAutoRecordRule as jest.MockedFunction<typeof describeAutoRecordRule>;
const mockedReleaseMeetingLeaseForMeeting =
  releaseMeetingLeaseForMeeting as jest.MockedFunction<
    typeof releaseMeetingLeaseForMeeting
  >;
const mockedRunTranscriptionFinalPass =
  runTranscriptionFinalPass as jest.MockedFunction<
    typeof runTranscriptionFinalPass
  >;

describe("handleEndMeetingOther", () => {
  let warning: jest.SpiedFunction<typeof console.warn>;
  beforeEach(() => {
    jest.clearAllMocks();
    mockedReleaseMeetingLeaseForMeeting.mockResolvedValue(true);
    warning = jest.spyOn(console, "warn");
    jest.mocked(ensureMeetingNotes).mockReset();
    jest.mocked(updateMeetingSummaryMessage).mockReset();
    mockedCleanupSpeakerTracks.mockResolvedValue(undefined);
    mockedUploadMeetingArtifacts.mockResolvedValue(successfulArtifactUpload);
    mockedRetainMeetingTempDir.mockResolvedValue(
      "tmp/retained-meetings/meeting-1",
    );
    mockedRunTranscriptionFinalPass.mockResolvedValue({
      enabled: true,
      applied: false,
      processedChunks: 0,
      totalChunks: 0,
      totalSegments: 0,
      candidateEdits: 0,
      acceptedEdits: 0,
      replacedSegments: 0,
      droppedSegments: 0,
      rejectedTrivialEdits: 0,
      repetitionFilteredSegments: 0,
      fallbackApplied: false,
    });
  });

  afterEach(() => {
    expect(
      warning.mock.calls.some(
        ([message]) =>
          String(message).includes("Failed to capture meeting_completed") ||
          String(message).includes("No active OTEL span"),
      ),
    ).toBe(false);
    warning.mockRestore();
  });

  it.each([
    { used: 240, outcome: "exhausted_after_meeting", fails: false },
    {
      used: 240,
      outcome: "exhausted_after_meeting",
      fails: false,
      routed: true,
    },
    { used: 200, outcome: "near_limit", fails: false },
    { used: 240, outcome: "exhausted_after_meeting", fails: true },
    {
      used: 240,
      outcome: "exhausted_after_meeting",
      fails: false,
      pending: true,
    },
  ])(
    "flushes and saves despite a $outcome notice (failure=$fails)",
    async ({ used, outcome, fails, pending, routed }) => {
      const events: string[] = [];
      jest.mocked(settleOwnedVoiceSession).mockImplementationOnce(async () => {
        events.push("voice-settled");
        return "settled";
      });
      mockedStartProcessingSnippet.mockImplementation(() => {
        events.push("flush");
      });
      mockedWithMeetingEndTrace.mockImplementation(async (_meeting, fn) =>
        fn(),
      );
      mockedEvaluateAutoRecordCancellation.mockResolvedValue({ cancel: false });
      mockedBuildMixedAudio.mockResolvedValue(undefined);
      mockedCloseOutputFile.mockResolvedValue(undefined);
      mockedWaitForAudioOnlyFinishProcessing.mockResolvedValue(undefined);
      mockedSaveMeetingHistoryToDatabase.mockResolvedValue(undefined);
      mockedGetGuildLimits.mockResolvedValue({ limits: {} } as never);
      mockedUpdateMeetingStatusService.mockResolvedValue(undefined);

      const { meeting, connection } = recordingLimitMeeting(events);

      mockedGetGuildLimits.mockResolvedValue({
        limits: { maxMeetingMinutesRolling: 240 },
        subscription: { tier: "free" },
      } as never);
      jest.mocked(getRollingUsageForGuild).mockResolvedValue({
        usedSeconds: used * 60,
        meetings: [],
        windowStartIso: "2026-10-01T00:00:00Z",
        windowEndIso: "2026-10-02T00:00:00Z",
        nextAvailableAtIso: null,
      });
      let finishNotice: (() => void) | undefined;
      if (pending)
        jest.mocked(notifyRecordingLimit).mockReturnValueOnce(
          new Promise((resolve) => {
            finishNotice = () => resolve(undefined);
          }),
        );
      else if (fails)
        jest
          .mocked(notifyRecordingLimit)
          .mockRejectedValueOnce(new Error("test notice failure"));
      else jest.mocked(notifyRecordingLimit).mockResolvedValueOnce(undefined);
      const button = {
        guildId: meeting.guildId,
        message: { id: "published-recording" },
        user: { id: "user-1" },
        deferred: false,
        replied: false,
        deferUpdate: jest.fn(),
        reply: jest.fn(),
        followUp: jest.fn(),
      } as unknown as ButtonInteraction;
      if (routed) {
        mockedGetMeeting.mockReturnValueOnce(meeting);
      }
      const ending = routed
        ? handleEndMeetingButton({} as Client, button)
        : handleEndMeetingOther({} as Client, meeting);
      if (pending) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(meeting.setFinished).not.toHaveBeenCalled();
        expect(mockedReleaseMeetingLeaseForMeeting).not.toHaveBeenCalled();
        finishNotice?.();
      }
      await ending;

      if (routed) {
        expect(button.deferUpdate).toHaveBeenCalled();
        expect(button.followUp).not.toHaveBeenCalled();
        expect(meeting.textChannel.id).toBe("original-notes");
        expect(updateMeetingProcessingMessage).toHaveBeenCalledWith(meeting);
        expect(updateMeetingSummaryMessage).toHaveBeenCalledWith(meeting, {
          finalization: true,
        });
      }
      expect(notifyRecordingLimit).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome,
          limitMinutes: 240,
          usedMinutes: used,
          userId: "user-1",
        }),
        meeting.textChannel,
        meeting.recordingLimitNotice,
        meeting,
      );
      expect(meeting.setFinished).toHaveBeenCalled();
      expect(deleteMeeting).toHaveBeenCalledWith(meeting.guildId);
      expect(mockedSaveMeetingHistoryToDatabase).toHaveBeenCalledWith(meeting);
      expect(captureEvent).toHaveBeenCalledWith(
        "meeting_completed",
        expect.objectContaining({
          properties: expect.objectContaining({ attendee_count: 0 }),
        }),
      );
      expect(mockedCleanupMeetingTempDir).toHaveBeenCalledWith(meeting);
      expect(mockedReleaseMeetingLeaseForMeeting).toHaveBeenCalledWith(meeting);
      expect(events.indexOf("flush")).toBeGreaterThanOrEqual(0);
      expect(events.indexOf("flush")).toBeLessThan(
        events.indexOf("voice-settled"),
      );
      expect(settleOwnedVoiceSession).toHaveBeenCalledWith(meeting.reservation);
      expect(connection.disconnect).not.toHaveBeenCalled();
      expect(connection.destroy).not.toHaveBeenCalled();
    },
  );

  it("skips auto-record cancellation evaluation when a dismissed auto-record meeting already crossed completion thresholds", async () => {
    const { autoRecordJoinSuppressionService } = jest.requireMock(
      "../../src/services/autoRecordJoinSuppressionService",
    ) as {
      autoRecordJoinSuppressionService: {
        suppressUntilEmpty: jest.Mock;
      };
    };

    mockedWithMeetingEndTrace.mockImplementation(async (_meeting, fn) => fn());
    mockedWaitForAudioOnlyFinishProcessing.mockResolvedValue(undefined);
    mockedCloseOutputFile.mockResolvedValue(undefined);
    mockedDescribeAutoRecordRule.mockReturnValue(
      "Auto-record rule: test-channel",
    );
    mockedWaitForFinishProcessing.mockResolvedValue(undefined);
    mockedBuildMixedAudio.mockResolvedValue(undefined);
    mockedCompileTranscriptions.mockResolvedValue("Recovered transcript");
    mockedGetGuildLimits.mockResolvedValue({ limits: {} } as never);
    mockedSaveMeetingHistoryToDatabase.mockResolvedValue(undefined);

    const members = new Collection<
      string,
      { id: string; user: { bot: boolean } }
    >([
      ["user-1", { id: "user-1", user: { bot: false } }],
      ["bot-1", { id: "bot-1", user: { bot: true } }],
    ]);

    const meeting = {
      attendance: new Set<string>(),
      guildId: "guild-1",
      channelId: "text-1",
      meetingId: "meeting-1",
      voiceChannel: {
        id: "voice-1",
        name: "Voice",
        members,
      },
      textChannel: {
        send: jest.fn().mockResolvedValue(undefined),
        messages: { fetch: jest.fn() },
      },
      connection: {
        disconnect: jest.fn(),
        destroy: jest.fn(),
      },
      chatLog: [],
      audioData: {
        audioFiles: [{ processing: false }],
        currentSnippets: new Map(),
        outputFileName: "recording.mp3",
      },
      startTime: new Date("2025-01-01T00:00:00.000Z"),
      endTime: undefined,
      finishing: false,
      finished: false,
      transcribeMeeting: true,
      generateNotes: false,
      isAutoRecording: true,
      cancelled: true,
      cancellationReason: "Stopped by user",
      endReason: MEETING_END_REASONS.DISMISSED,
      endTriggeredByUserId: "user-1",
      creator: { id: "bot-1" },
      guild: { id: "guild-1", members: { cache: new Map() } },
      ttsQueue: { stopAndClear: jest.fn() },
      setFinished: jest.fn(),
    } as unknown as MeetingData;

    await handleEndMeetingOther({} as Client, meeting);

    expect(mockedEvaluateAutoRecordCancellation).not.toHaveBeenCalled();
    expect(mockedBuildMixedAudio).toHaveBeenCalled();
    expect(mockedCompileTranscriptions).toHaveBeenCalledTimes(2);
    expect(mockedUploadMeetingArtifacts).toHaveBeenCalledWith(meeting, {
      audioFilePath: "recording.mp3",
      chatFilePath: expect.stringContaining("chat.txt"),
      transcriptText: "Recovered transcript",
    });
    expect(meeting.cancelled).toBe(false);
    expect(meeting.cancellationReason).toBeUndefined();
    expect(meeting.setFinished).toHaveBeenCalled();
    expect(meeting.finished).toBe(true);
    expect(mockedDeleteMeeting).toHaveBeenCalledWith("guild-1");
    expect(
      autoRecordJoinSuppressionService.suppressUntilEmpty,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: "guild-1",
        channelId: "voice-1",
        nonBotMemberIds: ["user-1"],
        reason: "explicit_end",
      }),
    );
  });

  it("finalizes a short dismissed auto-record meeting when chat activity crosses the threshold", async () => {
    mockedWithMeetingEndTrace.mockImplementation(async (_meeting, fn) => fn());
    mockedWaitForAudioOnlyFinishProcessing.mockResolvedValue(undefined);
    mockedCloseOutputFile.mockResolvedValue(undefined);
    mockedBuildMixedAudio.mockResolvedValue(undefined);
    mockedCompileTranscriptions.mockResolvedValue("Recovered transcript");
    mockedGetGuildLimits.mockResolvedValue({ limits: {} } as never);
    mockedSaveMeetingHistoryToDatabase.mockResolvedValue(undefined);

    const meeting = {
      attendance: new Set<string>(),
      guildId: "guild-1",
      channelId: "text-1",
      meetingId: "meeting-1",
      voiceChannel: {
        id: "voice-1",
        name: "Voice",
        members: new Collection(),
      },
      textChannel: {
        send: jest.fn().mockResolvedValue(undefined),
        messages: { fetch: jest.fn() },
      },
      connection: {
        disconnect: jest.fn(),
        destroy: jest.fn(),
      },
      chatLog: [
        { type: "message", content: "one" },
        { type: "message", content: "two" },
      ],
      audioData: {
        audioFiles: [{ processing: false }],
        currentSnippets: new Map(),
        outputFileName: "recording.mp3",
      },
      startTime: new Date(Date.now() - 2 * 60 * 1000),
      endTime: undefined,
      finishing: false,
      finished: false,
      transcribeMeeting: true,
      generateNotes: false,
      isAutoRecording: true,
      cancelled: true,
      cancellationReason: "Stopped by user",
      endReason: MEETING_END_REASONS.DISMISSED,
      creator: { id: "bot-1" },
      guild: { id: "guild-1", members: { cache: new Map() } },
      ttsQueue: { stopAndClear: jest.fn() },
      setFinished: jest.fn(),
      participants: new Map(),
    } as unknown as MeetingData;

    await handleEndMeetingOther({} as Client, meeting);

    expect(mockedEvaluateAutoRecordCancellation).not.toHaveBeenCalled();
    expect(mockedBuildMixedAudio).toHaveBeenCalled();
    expect(meeting.cancelled).toBe(false);
    expect(meeting.cancellationReason).toBeUndefined();
  });

  it.each([
    "complete",
    "partial",
    "history_failed",
    "empty",
    "notes_failed",
    "transcription_error",
    "upload_error",
    "history_error",
    "cleanup_error",
  ])(
    "runs final transcription and counts useful notes only for accepted %s outcome",
    async (state) => {
      const { compileTranscriptions } = jest.requireMock("../../src/audio") as {
        compileTranscriptions: jest.Mock;
      };

      mockedWithMeetingEndTrace.mockImplementation(async (_meeting, fn) =>
        fn(),
      );
      mockedEvaluateAutoRecordCancellation.mockResolvedValue({ cancel: false });
      mockedBuildMixedAudio.mockResolvedValue(undefined);
      mockedCloseOutputFile.mockResolvedValue(undefined);
      mockedWaitForAudioOnlyFinishProcessing.mockResolvedValue(undefined);
      mockedSaveMeetingHistoryToDatabase.mockImplementation(async (meeting) => {
        meeting.historySaved =
          state !== "history_failed" && state !== "history_error";
        if (state === "history_error" || state === "history_failed")
          throw new Error("history unavailable");
      });
      jest.mocked(ensureMeetingNotes).mockImplementation(async (meeting) => {
        meeting.notesText = state === "empty" ? "" : "Private notes";
        meeting.processing = {
          ...meeting.processing,
          notes: state === "notes_failed" ? "failed" : "generated",
        };
        return meeting.notesText;
      });
      jest
        .mocked(updateMeetingSummaryMessage)
        .mockImplementation(async (meeting) => {
          const delivery = {
            outcome:
              state === "partial"
                ? ("partial" as const)
                : ("complete" as const),
            sent: 1,
            intended: state === "partial" ? 2 : 1,
            errors: [],
          };
          meeting.delivery = { notes: delivery };
          return { summary: delivery, notes: delivery };
        });
      mockedGetGuildLimits.mockResolvedValue({ limits: {} } as never);
      mockedUpdateMeetingStatusService.mockResolvedValue(undefined);
      compileTranscriptions.mockResolvedValue("transcript text");
      if (state === "transcription_error")
        compileTranscriptions.mockRejectedValueOnce(
          new Error("transcription unavailable"),
        );
      if (state === "upload_error")
        mockedUploadMeetingArtifacts.mockRejectedValueOnce(
          new Error("upload unavailable"),
        );
      if (state === "cleanup_error")
        mockedCleanupMeetingTempDir.mockRejectedValueOnce(
          new Error("cleanup unavailable"),
        );
      let active = true;
      mockedHasMeeting.mockImplementation(() => active);
      mockedDeleteMeeting.mockImplementation(() => {
        active = false;
      });

      const meeting = {
        attendance: new Set<string>(),
        guildId: "guild-1",
        channelId: "text-1",
        meetingId: "meeting-1",
        voiceChannel: {
          id: "voice-1",
          name: "Voice",
          members: new Collection(),
        },
        textChannel: {
          id: "text-1",
          send: jest.fn().mockResolvedValue(undefined),
          messages: { fetch: jest.fn() },
        },
        connection: {
          disconnect: jest.fn(),
          destroy: jest.fn(),
        },
        chatLog: [],
        audioData: {
          audioFiles: [{ processing: false, transcript: "transcript text" }],
          currentSnippets: new Map(),
          outputFileName: "recording.mp3",
        },
        startTime: new Date("2025-01-01T00:00:00.000Z"),
        endTime: undefined,
        finishing: false,
        finished: false,
        transcribeMeeting: true,
        generateNotes: true,
        isAutoRecording: false,
        creator: { id: "user-1" },
        guild: { id: "guild-1", name: "Guild", members: { cache: new Map() } },
        ttsQueue: { stopAndClear: jest.fn() },
        runtimeConfig: {
          transcription: {
            finalPassEnabled: true,
          },
        },
        setFinished: jest.fn(),
      } as unknown as MeetingData;

      meeting.attendance = new Set(["user-1"]);
      await handleEndMeetingOther({} as Client, meeting);

      expect(mockedRunTranscriptionFinalPass).toHaveBeenCalledWith(meeting, {
        audioFilePath: "recording.mp3",
      });
      if (state !== "transcription_error")
        expect(meeting.processing).toMatchObject({ transcription: "ready" });
      if (state.endsWith("_error") || state.endsWith("_failed")) {
        expect(captureEvent).not.toHaveBeenCalled();
        expect(meeting.setFinished).not.toHaveBeenCalled();
        expect(mockedReleaseMeetingLeaseForMeeting).not.toHaveBeenCalled();
      } else {
        expect(captureEvent).toHaveBeenCalledTimes(1);
        expect(captureEvent).toHaveBeenCalledWith(
          "meeting_completed",
          expect.objectContaining({
            properties: expect.objectContaining({
              usable_notes: state === "complete",
              event_version: 3,
            }),
          }),
        );
      }
      expect(
        JSON.stringify(jest.mocked(captureEvent).mock.calls),
      ).not.toContain("Private notes");
    },
  );

  it("retains local artifacts when completed meeting audio upload is not durable", async () => {
    mockedWithMeetingEndTrace.mockImplementation(async (_meeting, fn) => fn());
    mockedEvaluateAutoRecordCancellation.mockResolvedValue({ cancel: false });
    mockedBuildMixedAudio.mockResolvedValue(undefined);
    mockedCloseOutputFile.mockResolvedValue(undefined);
    mockedWaitForAudioOnlyFinishProcessing.mockResolvedValue(undefined);
    mockedUploadMeetingArtifacts.mockResolvedValue({
      audioUploadExpected: true,
      chatUploadExpected: true,
      transcriptUploadExpected: false,
    });
    mockedCloseOutputFile.mockReset().mockResolvedValue(undefined);
    mockedSaveMeetingHistoryToDatabase.mockResolvedValue(undefined);
    mockedGetGuildLimits.mockResolvedValue({ limits: {} } as never);

    const meeting = {
      attendance: new Set<string>(),
      guildId: "guild-1",
      channelId: "text-1",
      meetingId: "meeting-1",
      voiceChannel: { id: "voice-1", name: "Voice", members: new Collection() },
      textChannel: {
        id: "text-1",
        send: jest.fn().mockResolvedValue(undefined),
        messages: { fetch: jest.fn() },
      },
      ...finalizationCaptureState(),
      ...recordingOnlyFinalizationState(),
    } as unknown as MeetingData;

    await handleEndMeetingOther({} as Client, meeting);

    expect(mockedRetainMeetingTempDir).toHaveBeenCalledWith(
      meeting,
      "artifact_upload_failed",
    );
    expect(mockedDeleteIfExists).not.toHaveBeenCalledWith("recording.mp3");
    expect(mockedCleanupSpeakerTracks).not.toHaveBeenCalled();
    expect(mockedCleanupMeetingTempDir).not.toHaveBeenCalled();
  });

  it("does not release or finish when the trace wrapper fails", async () => {
    mockedWithMeetingEndTrace.mockRejectedValue(new Error("end flow failed"));
    mockedHasMeeting.mockReturnValue(true);
    mockedReleaseMeetingLeaseForMeeting.mockRejectedValue(
      new Error("lease release failed"),
    );

    const meeting = {
      attendance: new Set<string>(),
      guildId: "guild-1",
      meetingId: "meeting-1",
      setFinished: jest.fn(),
      finished: false,
      creator: { id: "user-1" },
      startTime: new Date("2025-01-01T00:00:00Z"),
    } as unknown as MeetingData;

    await expect(handleEndMeetingOther({} as Client, meeting)).resolves.toBe(
      undefined,
    );

    expect(mockedReleaseMeetingLeaseForMeeting).not.toHaveBeenCalled();
    expect(meeting.setFinished).not.toHaveBeenCalled();
    expect(meeting.finished).toBe(false);
    expect(mockedDeleteMeeting).not.toHaveBeenCalled();
  });

  it("retains cancelled artifacts and ownership when cancellation delivery has no ACK", async () => {
    mockedWithMeetingEndTrace.mockImplementation(async (_meeting, fn) => fn());
    mockedWaitForAudioOnlyFinishProcessing.mockResolvedValue(undefined);
    mockedCloseOutputFile.mockResolvedValue(undefined);
    mockedWaitForFinishProcessing.mockImplementationOnce(async (meeting) => {
      meeting.audioData.audioFiles.forEach((file) => {
        file.processing = false;
      });
    });
    mockedCompileTranscriptions.mockResolvedValueOnce(
      "Transcript without cues",
    );
    mockedDescribeAutoRecordRule.mockReturnValue(
      "Auto-record rule: test-channel",
    );
    mockedSaveMeetingHistoryToDatabase.mockResolvedValue(undefined);

    const meeting = {
      attendance: new Set<string>(),
      guildId: "guild-1",
      channelId: "text-1",
      meetingId: "meeting-1",
      voiceChannel: {
        id: "voice-1",
        name: "Voice",
        members: new Collection(),
      },
      textChannel: {
        send: jest.fn().mockRejectedValue(new Error("send denied")),
        messages: { fetch: jest.fn() },
      },
      connection: {
        disconnect: jest.fn(),
        destroy: jest.fn(),
      },
      chatLog: [],
      audioData: {
        audioFiles: [{ processing: true }],
        currentSnippets: new Map(),
        outputFileName: "recording.mp3",
      },
      startTime: new Date("2025-01-01T00:00:00.000Z"),
      endTime: undefined,
      finishing: false,
      finished: false,
      transcribeMeeting: true,
      generateNotes: false,
      isAutoRecording: true,
      cancelled: true,
      cancellationReason: "Stopped by user",
      endReason: MEETING_END_REASONS.AUTO_CANCELLED,
      creator: { id: "bot-1" },
      guild: { id: "guild-1", members: { cache: new Map() } },
      ttsQueue: { stopAndClear: jest.fn() },
      setFinished: jest.fn(),
      participants: new Map(),
    } as unknown as MeetingData;

    await handleEndMeetingOther({} as Client, meeting);

    expect(mockedWaitForFinishProcessing).toHaveBeenCalledWith(meeting);
    expect(mockedUploadMeetingArtifacts).toHaveBeenCalledWith(meeting, {
      audioFilePath: "recording.mp3",
      chatFilePath: expect.stringContaining("chat.txt"),
      transcriptText: "Transcript without cues",
    });
    expect(mockedSaveMeetingHistoryToDatabase).not.toHaveBeenCalled();
    expect(meeting.finished).toBe(false);
    expect(mockedCleanupSpeakerTracks).not.toHaveBeenCalled();
    expect(mockedReleaseMeetingLeaseForMeeting).not.toHaveBeenCalled();
    expect(interruptOwnedMeeting).toHaveBeenCalledWith(
      meeting,
      expect.objectContaining({ reason: "processing_failure" }),
    );
  });

  it("retains cancelled auto-record artifacts when audio upload is not durable", async () => {
    mockedWithMeetingEndTrace.mockImplementation(async (_meeting, fn) => fn());
    mockedWaitForAudioOnlyFinishProcessing.mockResolvedValue(undefined);
    mockedCloseOutputFile.mockResolvedValue(undefined);
    mockedUploadMeetingArtifacts.mockResolvedValue({
      audioUploadExpected: true,
      chatUploadExpected: true,
      transcriptUploadExpected: false,
    });
    mockedDescribeAutoRecordRule.mockReturnValue(
      "Auto-record rule: test-channel",
    );
    mockedSaveMeetingHistoryToDatabase.mockResolvedValue(undefined);

    const meeting = {
      ...autoRecordFinalizationFixture(),
      cancelled: true,
      cancellationReason: "Stopped by user",
      endReason: MEETING_END_REASONS.AUTO_CANCELLED,
      creator: { id: "bot-1" },
      participants: new Map(),
    } as unknown as MeetingData;

    await handleEndMeetingOther({} as Client, meeting);

    expect(mockedRetainMeetingTempDir).toHaveBeenCalledWith(
      meeting,
      "cancelled_artifact_upload_failed",
    );
    expect(mockedDeleteIfExists).not.toHaveBeenCalledWith("recording.mp3");
    expect(mockedCleanupSpeakerTracks).not.toHaveBeenCalled();
    expect(mockedCleanupMeetingTempDir).not.toHaveBeenCalled();
  });

  it("uses stopped messaging for short dismissed auto-record meetings", async () => {
    mockedWithMeetingEndTrace.mockImplementation(async (_meeting, fn) => fn());
    mockedWaitForAudioOnlyFinishProcessing.mockResolvedValue(undefined);
    mockedCloseOutputFile.mockResolvedValue(undefined);
    mockedSaveMeetingHistoryToDatabase.mockResolvedValue(undefined);
    mockedDescribeAutoRecordRule.mockReturnValue(
      "Auto-record rule: test-channel",
    );

    const fixture = autoRecordFinalizationFixture();
    const send = fixture.textChannel.send;
    const meeting = {
      ...fixture,
      startTime: new Date(Date.now() - 2 * 60 * 1000),
      cancelled: true,
      cancellationReason: "Stopped by user",
      endReason: MEETING_END_REASONS.DISMISSED,
      creator: { id: "bot-1" },
      participants: new Map(),
    } as unknown as MeetingData;

    await handleEndMeetingOther({} as Client, meeting);

    const payload = send.mock.calls[0][0] as {
      embeds: [{ data: { title: string } }];
    };
    expect(payload.embeds[0].data.title).toBe("Auto-Recording Stopped");
  });

  it("skips duplicate lease release when meeting is already finishing", async () => {
    mockedWithMeetingEndTrace.mockRejectedValue(new Error("end flow failed"));
    mockedHasMeeting.mockReturnValue(true);

    const meeting = {
      attendance: new Set<string>(),
      guildId: "guild-1",
      meetingId: "meeting-1",
      finishing: true,
      finished: false,
      setFinished: jest.fn(),
      creator: { id: "user-1" },
      startTime: new Date("2025-01-01T00:00:00Z"),
    } as unknown as MeetingData;

    await expect(handleEndMeetingOther({} as Client, meeting)).resolves.toBe(
      undefined,
    );

    expect(mockedReleaseMeetingLeaseForMeeting).not.toHaveBeenCalled();
    expect(meeting.setFinished).not.toHaveBeenCalled();
    expect(mockedDeleteMeeting).not.toHaveBeenCalled();
  });
});

describe("handleEndMeetingButton", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedReleaseMeetingLeaseForMeeting.mockResolvedValue(true);
  });
  it("rejects a current stop after ownership release has begun without claiming suppression", async () => {
    const { autoRecordJoinSuppressionService } =
      await import("../../src/services/autoRecordJoinSuppressionService");
    const meeting = {
      guildId: "guild-1",
      meetingId: "meeting-1",
      startMessageId: "current-start",
      creator: { id: "user-1" },
      isAutoRecording: true,
      finishing: true,
      reservation: { guildId: "guild-1", meetingId: "meeting-1" },
    } as unknown as MeetingData;
    mockedGetMeeting.mockReturnValue(meeting);
    const interaction = {
      guildId: "guild-1",
      user: { id: "user-1" },
      message: { id: "current-start" },
      reply: jest.fn(),
      deferUpdate: jest.fn(),
      followUp: jest.fn(),
    } as unknown as ButtonInteraction;
    await handleEndMeetingButton({} as Client, interaction);
    expect(
      autoRecordJoinSuppressionService.suppressUntilEmpty,
    ).not.toHaveBeenCalled();
    expect(interaction.followUp).toHaveBeenCalledWith({
      content: "Meeting stop could not be confirmed. Please retry.",
      ephemeral: true,
    });
    expect(mockedReleaseMeetingLeaseForMeeting).not.toHaveBeenCalled();
  });
  it("rejects a historical button without suppressing the current meeting", async () => {
    const { autoRecordJoinSuppressionService } =
      await import("../../src/services/autoRecordJoinSuppressionService");
    mockedGetMeeting.mockReturnValue({
      guildId: "guild-1",
      meetingId: "new-meeting",
      startMessageId: "new-start",
      creator: { id: "user-1" },
      isAutoRecording: true,
      finishing: true,
      voiceChannel: {
        id: "voice-1",
        members: new Collection([
          ["user-1", { id: "user-1", user: { bot: false } }],
        ]),
      },
    } as unknown as MeetingData);
    const interaction = {
      guildId: "guild-1",
      user: { id: "user-1" },
      message: { id: "old-start" },
      reply: jest.fn(),
      deferUpdate: jest.fn(),
      followUp: jest.fn(),
    } as unknown as ButtonInteraction;
    await handleEndMeetingButton({} as Client, interaction);
    expect(
      autoRecordJoinSuppressionService.suppressUntilEmpty,
    ).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(
      "This meeting control is no longer active.",
    );
  });
  it("persists a late explicit stop while finalization is already running", async () => {
    const { autoRecordJoinSuppressionService } =
      await import("../../src/services/autoRecordJoinSuppressionService");
    let resume!: () => void;
    const held = new Promise<void>((resolve) => {
      resume = resolve;
    });
    jest
      .mocked(autoRecordJoinSuppressionService.suppressUntilEmpty)
      .mockImplementationOnce(async () => {
        await held;
        return true;
      });
    const meeting = {
      guildId: "synthetic-guild",
      meetingId: "synthetic-meeting",
      isAutoRecording: true,
      finishing: true,
      voiceChannel: {
        id: "voice",
        members: new Collection([
          ["member", { id: "member", user: { bot: false } }],
        ]),
      },
    } as unknown as MeetingData;
    let returned = false;
    const stop = persistExplicitMeetingStop(
      meeting,
      MEETING_END_REASONS.LEAVE_COMMAND,
    ).then(() => {
      returned = true;
    });
    await Promise.resolve();
    expect(returned).toBe(false);
    expect(
      autoRecordJoinSuppressionService.suppressUntilEmpty,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        meetingId: meeting.meetingId,
        reason: "explicit_end",
      }),
    );
    expect(mockedReleaseMeetingLeaseForMeeting).not.toHaveBeenCalled();
    resume();
    await stop;
    expect(returned).toBe(true);
  });

  it("does not report completion or delete after failed button preparation", async () => {
    mockedWithMeetingEndTrace.mockRejectedValueOnce(
      new Error("transcription unavailable"),
    );
    mockedHasMeeting.mockReturnValue(true);
    const meeting = {
      startMessageId: "start-message",
      guildId: "guild-1",
      meetingId: "meeting-1",
      creator: { id: "user-1" },
      startTime: new Date(),
      attendance: new Set(["user-1"]),
      transcribeMeeting: true,
      setFinished: jest.fn(),
    } as unknown as MeetingData;
    mockedGetMeeting.mockReturnValue(meeting);
    const interaction = {
      message: { id: "start-message" },
      guildId: "guild-1",
      user: { id: "user-1" },
      deferUpdate: jest.fn(),
      reply: jest.fn(),
      followUp: jest.fn(),
    } as unknown as ButtonInteraction;
    await handleEndMeetingButton({} as Client, interaction);
    expect(captureEvent).not.toHaveBeenCalled();
    expect(mockedDeleteMeeting).not.toHaveBeenCalled();
    expect(meeting.setFinished).not.toHaveBeenCalled();
  });

  it("acknowledges the end meeting button when auto-recording is cancelled", async () => {
    mockedWithMeetingEndTrace.mockImplementation(async (_meeting, fn) => fn());
    mockedEvaluateAutoRecordCancellation.mockResolvedValue({
      cancel: true,
      reason: "No meaningful content detected.",
    });
    mockedWaitForAudioOnlyFinishProcessing.mockResolvedValue(undefined);
    mockedCloseOutputFile.mockResolvedValue(undefined);
    mockedDescribeAutoRecordRule.mockReturnValue(
      "Auto-record rule: test-channel",
    );

    const fixture = autoRecordFinalizationFixture();
    fixture.textChannel.messages.fetch.mockResolvedValue({
      id: "start-message",
      edit: jest.fn().mockResolvedValue(undefined),
    });
    const meeting = {
      ...fixture,
      startMessageId: "start-message",
    } as unknown as MeetingData;

    mockedGetMeeting.mockReturnValue(meeting);

    const interaction = acknowledgedEndMeetingButton();

    await handleEndMeetingButton({} as Client, interaction);

    expect(interaction.deferUpdate).toHaveBeenCalled();
  });

  it("suppresses auto-record rejoin until the channel is empty", async () => {
    const { autoRecordJoinSuppressionService } = jest.requireMock(
      "../../src/services/autoRecordJoinSuppressionService",
    ) as {
      autoRecordJoinSuppressionService: {
        suppressUntilEmpty: jest.Mock;
      };
    };

    mockedWithMeetingEndTrace.mockImplementation(async (_meeting, fn) => fn());
    mockedEvaluateAutoRecordCancellation.mockResolvedValue({
      cancel: false,
    });
    mockedWaitForAudioOnlyFinishProcessing.mockResolvedValue(undefined);
    mockedCloseOutputFile.mockResolvedValue(undefined);
    mockedDescribeAutoRecordRule.mockReturnValue(
      "Auto-record rule: test-channel",
    );

    const members = new Collection<
      string,
      { id: string; user: { bot: boolean } }
    >([
      ["user-1", { id: "user-1", user: { bot: false } }],
      ["bot-1", { id: "bot-1", user: { bot: true } }],
    ]);

    const meeting = {
      ...autoRecordFinalizationFixture(),
      startMessageId: "start-message",
      voiceChannel: { id: "voice-1", name: "Voice", members },
    } as unknown as MeetingData;

    mockedGetMeeting.mockReturnValue(meeting);

    const interaction = acknowledgedEndMeetingButton();

    await handleEndMeetingButton({} as Client, interaction);

    expect(
      autoRecordJoinSuppressionService.suppressUntilEmpty,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: "guild-1",
        channelId: "voice-1",
        nonBotMemberIds: ["user-1"],
        reason: "explicit_end",
      }),
    );
  });
});

describe("owned finalization durability", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedReleaseMeetingLeaseForMeeting.mockResolvedValue(true);
    mockedWithMeetingEndTrace.mockImplementation(async (_meeting, fn) => fn());
    mockedEvaluateAutoRecordCancellation.mockResolvedValue({ cancel: false });
    mockedUploadMeetingArtifacts.mockResolvedValue(successfulArtifactUpload);
    mockedCloseOutputFile.mockReset().mockResolvedValue(undefined);
    mockedSaveMeetingHistoryToDatabase.mockResolvedValue(undefined);
    mockedGetGuildLimits.mockResolvedValue({ limits: {} } as never);
    mockedUpdateMeetingStatusService.mockResolvedValue(undefined);
  });
  it("onlyOneFinalizerWins", async () => {
    const meeting = finalizationFixture();
    let finish!: () => void;
    mockedCloseOutputFile.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const first = runEndMeetingFlow({ client: {} as Client, meeting });
    const second = runEndMeetingFlow({ client: {} as Client, meeting });
    expect(first).toBe(second);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockedCloseOutputFile).toHaveBeenCalledTimes(1);
    expect(meeting.setFinished).not.toHaveBeenCalled();
    finish();
    await first;
  });
  it("historyFailureRetainsArtifactsAndWork", async () => {
    const meeting = finalizationFixture();
    mockedSaveMeetingHistoryToDatabase.mockRejectedValueOnce(
      new Error("storage unavailable"),
    );
    await handleEndMeetingOther({} as Client, meeting);
    expect(mockedCleanupMeetingTempDir).not.toHaveBeenCalled();
    expect(mockedCleanupSpeakerTracks).not.toHaveBeenCalled();
    expect(mockedDeleteIfExists).not.toHaveBeenCalled();
    expect(meeting.setFinished).not.toHaveBeenCalled();
    expect(mockedReleaseMeetingLeaseForMeeting).not.toHaveBeenCalled();
    expect(captureEvent).not.toHaveBeenCalled();
  });
});

// Preparation errors occur before encoders/providers; the owned failure path still persists them.
it("preparationFailurePersistsFailure", async () => {
  jest.clearAllMocks();
  jest
    .mocked(transitionOwnedMeetingHistoryService)
    .mockResolvedValue(undefined);
  jest
    .mocked(updateMeetingProcessingMessage)
    .mockRejectedValueOnce(new Error("Discord unavailable"));
  const meeting = finalizationFixture();
  await expect(
    runEndMeetingFlow({ client: {} as Client, meeting }),
  ).rejects.toThrow("Discord unavailable");
  expect(interruptOwnedMeeting).toHaveBeenCalledWith(
    meeting,
    expect.objectContaining({ reason: "processing_failure" }),
  );
  expect(interruptOwnedMeeting).toHaveBeenCalledWith(
    meeting,
    expect.objectContaining({ reason: "processing_failure" }),
  );
  expect(meeting.setFinished).not.toHaveBeenCalled();
  expect(mockedCleanupMeetingTempDir).not.toHaveBeenCalled();
});
it("preservation fence prevents a held encoder result from publishing or cleaning up", async () => {
  jest.clearAllMocks();
  jest
    .mocked(transitionOwnedMeetingHistoryService)
    .mockResolvedValue(undefined);
  let finish!: () => void;
  mockedCloseOutputFile.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const meeting = finalizationFixture();
  const promise = runEndMeetingFlow({ client: {} as Client, meeting });
  const rejection = expect(promise).rejects.toThrow("fenced");
  await new Promise((resolve) => setTimeout(resolve, 0));
  fenceMeetingFinalization(meeting);
  await expect(preserveMeetingFinalizationCapture(meeting)).resolves.toBe(true);
  finish();
  await rejection;
  expect(mockedSaveMeetingHistoryToDatabase).not.toHaveBeenCalled();
  expect(mockedCleanupMeetingTempDir).not.toHaveBeenCalled();
  expect(meeting.setFinished).not.toHaveBeenCalled();
});

it("held ancillary delivery remains counted until completion", async () => {
  jest.clearAllMocks();
  mockedCloseOutputFile.mockResolvedValue(undefined);
  mockedSaveMeetingHistoryToDatabase.mockResolvedValue(undefined);
  mockedReleaseMeetingLeaseForMeeting.mockResolvedValue(true);
  mockedEvaluateAutoRecordCancellation.mockResolvedValue({ cancel: false });
  mockedUploadMeetingArtifacts.mockResolvedValue(successfulArtifactUpload);
  jest
    .mocked(transitionOwnedMeetingHistoryService)
    .mockResolvedValue(undefined);
  mockedGetGuildLimits.mockResolvedValue({
    limits: { maxMeetingMinutesRolling: 240 },
  } as never);
  jest.mocked(getRollingUsageForGuild).mockResolvedValue({
    usedSeconds: 14400,
    meetings: [],
    windowStartIso: "2026-10-01T00:00:00Z",
    windowEndIso: "2026-10-02T00:00:00Z",
    nextAvailableAtIso: null,
  });
  let finish!: () => void;
  jest.mocked(notifyRecordingLimit).mockReturnValueOnce(
    new Promise((resolve) => {
      finish = () => resolve(undefined);
    }),
  );
  const meeting = finalizationFixture();
  const promise = runEndMeetingFlow({ client: {} as Client, meeting });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(notifyRecordingLimit).toHaveBeenCalledTimes(1);
  expect(meeting.setFinished).not.toHaveBeenCalled();
  expect(mockedReleaseMeetingLeaseForMeeting).not.toHaveBeenCalled();
  expect(meeting.reservation?.workHandle.transition).toHaveBeenCalledWith(
    "finalization",
  );
  expect(meeting.reservation?.workHandle.settle).not.toHaveBeenCalled();
  finish();
  await promise;
  expect(meeting.setFinished).toHaveBeenCalledTimes(1);
});

it("held minutes limits read cannot dispatch a notice after the finalizer is fenced", async () => {
  jest.clearAllMocks();
  mockedCloseOutputFile.mockResolvedValue(undefined);
  mockedSaveMeetingHistoryToDatabase.mockResolvedValue(undefined);
  mockedReleaseMeetingLeaseForMeeting.mockResolvedValue(true);
  mockedEvaluateAutoRecordCancellation.mockResolvedValue({ cancel: false });
  mockedUploadMeetingArtifacts.mockResolvedValue(successfulArtifactUpload);
  jest
    .mocked(transitionOwnedMeetingHistoryService)
    .mockResolvedValue(undefined);
  let finish!: () => void;
  mockedGetGuildLimits.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = () =>
        resolve({ limits: { maxMeetingMinutesRolling: 240 } } as never);
    }),
  );
  const meeting = finalizationFixture();
  const promise = runEndMeetingFlow({ client: {} as Client, meeting });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(notifyRecordingLimit).not.toHaveBeenCalled();
  const rejection = expect(promise).rejects.toThrow();
  fenceMeetingFinalization(meeting);
  expect(meeting.setFinished).not.toHaveBeenCalled();
  expect(mockedReleaseMeetingLeaseForMeeting).not.toHaveBeenCalled();
  expect(meeting.reservation?.workHandle.transition).toHaveBeenCalledWith(
    "finalization",
  );
  expect(meeting.reservation?.workHandle.settle).not.toHaveBeenCalled();
  finish();
  await rejection;
  expect(notifyRecordingLimit).not.toHaveBeenCalled();
  expect(meeting.setFinished).not.toHaveBeenCalled();
  expect(mockedReleaseMeetingLeaseForMeeting).not.toHaveBeenCalled();
});

describe("H4 review outcome and fence regressions", () => {
  let errorOutput: jest.SpiedFunction<typeof console.error>;
  beforeEach(() => {
    jest.clearAllMocks();
    errorOutput = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    mockedReleaseMeetingLeaseForMeeting.mockResolvedValue(true);
    mockedCleanupMeetingTempDir.mockResolvedValue(undefined);
    mockedCloseOutputFile.mockResolvedValue(undefined);
    mockedSaveMeetingHistoryToDatabase.mockResolvedValue(undefined);
    mockedEvaluateAutoRecordCancellation.mockResolvedValue({ cancel: false });
    mockedUploadMeetingArtifacts.mockResolvedValue(successfulArtifactUpload);
    mockedGetGuildLimits.mockResolvedValue({ limits: {} } as never);
    mockedCompileTranscriptions.mockResolvedValue("Fixture speech");
    jest.mocked(updateMeetingSummaryMessage).mockReset();
    jest
      .mocked(transitionOwnedMeetingHistoryService)
      .mockResolvedValue(undefined);
  });
  afterEach(() => {
    errorOutput.mockRestore();
  });
  it("caught notes-provider failure cannot complete", async () => {
    const actual = jest.requireActual<
      typeof import("../../src/services/meetingNotesService")
    >("../../src/services/meetingNotesService");
    jest
      .mocked(ensureMeetingNotes)
      .mockImplementationOnce(actual.ensureMeetingNotes);
    jest
      .mocked(getNotes)
      .mockRejectedValueOnce(new Error("fixture provider unavailable"));
    const meeting = finalizationFixture();
    meeting.transcribeMeeting = true;
    meeting.generateNotes = true;
    meeting.audioData.audioFiles = [
      { transcript: "Fixture speech", processing: false },
    ] as never;
    await expect(
      runEndMeetingFlow({ client: {} as Client, meeting }),
    ).rejects.toThrow("processing");
    expect(meeting.processing?.notes).toBe("failed");
    expect(errorOutput).toHaveBeenCalledWith(
      "Error generating meeting notes:",
      expect.objectContaining({ message: "fixture provider unavailable" }),
    );
    expect(mockedSaveMeetingHistoryToDatabase).not.toHaveBeenCalled();
    expect(mockedDeleteIfExists).not.toHaveBeenCalled();
    expect(mockedReleaseMeetingLeaseForMeeting).not.toHaveBeenCalled();
    expect(interruptOwnedMeeting).toHaveBeenCalledWith(
      meeting,
      expect.objectContaining({ reason: "processing_failure" }),
    );
  });
  it.each(["audio", "chat", "transcript"] as const)(
    "missing expected %s never commits complete or deletes artifacts",
    async (missing) => {
      const meeting = finalizationFixture();
      const upload = {
        audioUploadExpected: true,
        chatUploadExpected: true,
        transcriptUploadExpected: true,
        audioS3Key: "audio",
        chatS3Key: "chat",
        transcriptS3Key: "transcript",
      };
      delete (upload as Partial<typeof upload>)[`${missing}S3Key`];
      mockedUploadMeetingArtifacts.mockResolvedValueOnce(upload);
      await expect(
        runEndMeetingFlow({ client: {} as Client, meeting }),
      ).rejects.toThrow("artifact");
      expect(mockedSaveMeetingHistoryToDatabase).not.toHaveBeenCalled();
      expect(mockedDeleteIfExists).not.toHaveBeenCalled();
      expect(mockedCleanupSpeakerTracks).not.toHaveBeenCalled();
      expect(mockedReleaseMeetingLeaseForMeeting).not.toHaveBeenCalled();
      expect(captureEvent).not.toHaveBeenCalled();
      expect(interruptOwnedMeeting).toHaveBeenCalledWith(
        meeting,
        expect.objectContaining({ reason: "processing_failure" }),
      );
      expect(errorOutput).toHaveBeenCalledWith(
        "Expected meeting artifacts were not durably uploaded; retained local artifacts",
        expect.objectContaining({
          meetingId: meeting.meetingId,
          reason: "artifact_upload_failed",
        }),
      );
    },
  );
  it.each(["audio", "chat", "transcript"] as const)(
    "automatic cancellation refuses a missing expected %s artifact",
    async (missing) => {
      mockedEvaluateAutoRecordCancellation.mockResolvedValueOnce({
        cancel: true,
        reason: "No substantive content",
      });
      const meeting = finalizationFixture();
      const upload = {
        audioUploadExpected: true,
        chatUploadExpected: true,
        transcriptUploadExpected: true,
        audioS3Key: "audio",
        chatS3Key: "chat",
        transcriptS3Key: "transcript",
      };
      delete (upload as Partial<typeof upload>)[`${missing}S3Key`];
      mockedUploadMeetingArtifacts.mockResolvedValueOnce(upload);
      await expect(
        runEndMeetingFlow({ client: {} as Client, meeting }),
      ).rejects.toThrow("artifact");
      expect(mockedRetainMeetingTempDir).toHaveBeenCalledWith(
        meeting,
        "cancelled_artifact_upload_failed",
      );
      // The cancellation intention survives artifact/notice failure; resources remain unresolved.
      expect(meeting.cancelled).toBe(true);
      expect(interruptOwnedMeeting).toHaveBeenCalledWith(
        meeting,
        expect.objectContaining({ reason: "processing_failure" }),
      );
      expect(mockedSaveMeetingHistoryToDatabase).not.toHaveBeenCalled();
      expect(mockedDeleteIfExists).not.toHaveBeenCalled();
      expect(mockedReleaseMeetingLeaseForMeeting).not.toHaveBeenCalled();
    },
  );
  it.each(["failed-segment", "partial", "capture-incomplete"] as const)(
    "required %s processing cannot reach automatic cancellation",
    async (failure) => {
      const meeting = finalizationFixture();
      meeting.transcribeMeeting = true;
      meeting.audioData.audioFiles = [
        {
          transcript: "",
          processing: false,
          transcriptionFailed: failure === "failed-segment",
        },
      ] as never;
      meeting.audioData.captureIncomplete = failure === "capture-incomplete";
      if (failure === "partial")
        meeting.processing = { transcription: "partial" };
      await expect(
        runEndMeetingFlow({ client: {} as Client, meeting }),
      ).rejects.toThrow("processing");
      expect(mockedEvaluateAutoRecordCancellation).not.toHaveBeenCalled();
      expect(interruptOwnedMeeting).toHaveBeenCalledWith(
        meeting,
        expect.objectContaining({ reason: "processing_failure" }),
      );
      expect(mockedDeleteIfExists).not.toHaveBeenCalled();
      expect(mockedReleaseMeetingLeaseForMeeting).not.toHaveBeenCalled();
    },
  );
  it("deliberately suppressed empty speech permits completion with skipped notes", async () => {
    const meeting = finalizationFixture();
    meeting.transcribeMeeting = true;
    meeting.processing = {
      transcription: "empty",
      notes: "skipped",
      summary: "skipped",
    };
    meeting.audioData.audioFiles = [
      { transcript: "", processing: false, transcriptionFailed: false },
    ] as never;
    await runEndMeetingFlow({ client: {} as Client, meeting });
    expect(meeting.processing.transcription).toBe("empty");
    expect(meeting.finished).toBe(true);
  });
  it("does not require artifacts that were empty or disabled", async () => {
    mockedUploadMeetingArtifacts.mockResolvedValueOnce({
      audioUploadExpected: false,
      chatUploadExpected: false,
      transcriptUploadExpected: false,
    });
    const meeting = finalizationFixture();
    await runEndMeetingFlow({ client: {} as Client, meeting });
    expect(meeting.finalization?.historyDisposition).toBe("complete");
    expect(meeting.finished).toBe(true);
  });
  it("optional final verification fallback preserves usable baseline completion", async () => {
    const meeting = finalizationFixture();
    meeting.transcribeMeeting = true;
    meeting.audioData.audioFiles = [
      { transcript: "Fixture speech", processing: false },
    ] as never;
    const fallback = {
      enabled: true,
      applied: false,
      processedChunks: 1,
      totalChunks: 1,
      totalSegments: 1,
      candidateEdits: 1,
      acceptedEdits: 0,
      replacedSegments: 0,
      droppedSegments: 0,
      rejectedTrivialEdits: 0,
      repetitionFilteredSegments: 0,
      fallbackApplied: true,
      fallbackReason: "guardrail_threshold",
    };
    mockedRunTranscriptionFinalPass.mockResolvedValueOnce(fallback);
    await runEndMeetingFlow({ client: {} as Client, meeting });
    expect(meeting.processing?.transcription).toBe("ready");
    expect(meeting.audioData.audioFiles[0].transcript).toBe("Fixture speech");
    expect(meeting.finished).toBe(true);
    expect(fallback.fallbackApplied).toBe(true);
  });
  it.each(["cleanup", "release"] as const)(
    "fence during held %s blocks the completion tail",
    async (held) => {
      let finish!: () => void;
      const wait = new Promise<void>((resolve) => {
        finish = resolve;
      });
      if (held === "cleanup")
        mockedCleanupMeetingTempDir.mockImplementationOnce(() => wait);
      else
        mockedReleaseMeetingLeaseForMeeting.mockImplementationOnce(async () => {
          await wait;
          return true;
        });
      const meeting = finalizationFixture();
      const promise = runEndMeetingFlow({ client: {} as Client, meeting });
      const outcome = promise.then(
        () => "completed",
        () => "fenced",
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      fenceMeetingFinalization(meeting);
      finish();
      expect(await outcome).toBe("fenced");
      if (held === "cleanup")
        expect(mockedReleaseMeetingLeaseForMeeting).not.toHaveBeenCalled();
      expect(meeting.setFinished).not.toHaveBeenCalled();
      expect(captureEvent).not.toHaveBeenCalled();
      expect(deleteMeeting).not.toHaveBeenCalled();
    },
  );
});

it("late actual notes-provider result cannot publish after fencing", async () => {
  jest.clearAllMocks();
  mockedCloseOutputFile.mockResolvedValue(undefined);
  mockedEvaluateAutoRecordCancellation.mockResolvedValue({ cancel: false });
  mockedCompileTranscriptions.mockResolvedValue("Fixture speech");
  jest
    .mocked(transitionOwnedMeetingHistoryService)
    .mockResolvedValue(undefined);
  const actual = jest.requireActual<
    typeof import("../../src/services/meetingNotesService")
  >("../../src/services/meetingNotesService");
  jest
    .mocked(ensureMeetingNotes)
    .mockImplementationOnce(actual.ensureMeetingNotes);
  let finish!: () => void;
  jest.mocked(getNotes).mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return "Fixture notes";
  });
  const meeting = finalizationFixture();
  meeting.transcribeMeeting = true;
  meeting.generateNotes = true;
  meeting.audioData.audioFiles = [
    { transcript: "Fixture speech", processing: false },
  ] as never;
  const promise = runEndMeetingFlow({ client: {} as Client, meeting });
  const rejected = expect(promise).rejects.toThrow("fenced");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(getNotes).toHaveBeenCalledTimes(1);
  fenceMeetingFinalization(meeting);
  finish();
  await rejected;
  expect(mockedSaveMeetingHistoryToDatabase).not.toHaveBeenCalled();
  expect(updateMeetingSummaryMessage).not.toHaveBeenCalled();
  expect(mockedReleaseMeetingLeaseForMeeting).not.toHaveBeenCalled();
});
it("aiDoesNotPrecedeDurableCapture", async () => {
  jest.clearAllMocks();
  mockedWithMeetingEndTrace.mockImplementation(async (_meeting, fn) => fn());
  jest
    .mocked(transitionOwnedMeetingHistoryService)
    .mockResolvedValue(undefined);
  let acknowledge!: (confirmed: boolean) => void;
  const meeting = finalizationFixture();
  meeting.transcribeMeeting = true;
  meeting.generateNotes = true;
  meeting.recordingCapture = {
    fence: jest.fn(),
    finish: jest.fn(
      () =>
        new Promise<boolean>((resolve) => {
          acknowledge = resolve;
        }),
    ),
  } as unknown as NonNullable<MeetingData["recordingCapture"]>;
  const task = runEndMeetingFlow({ client: {} as Client, meeting });
  const failed = expect(task).rejects.toThrow(
    "Durable capture preservation failed",
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(meeting.recordingCapture.finish).toHaveBeenCalledTimes(1);
  expect(runTranscriptionFinalPass).not.toHaveBeenCalled();
  expect(getNotes).not.toHaveBeenCalled();
  expect(ensureMeetingNotes).not.toHaveBeenCalled();
  expect(updateMeetingProcessingMessage).not.toHaveBeenCalled();
  acknowledge(false);
  await failed;
  expect(runTranscriptionFinalPass).not.toHaveBeenCalled();
  expect(ensureMeetingNotes).not.toHaveBeenCalled();
  expect(meeting.setFinished).not.toHaveBeenCalled();
  expect(mockedReleaseMeetingLeaseForMeeting).not.toHaveBeenCalled();
  expect(mockedCleanupMeetingTempDir).not.toHaveBeenCalled();
});

it("actual finalization fence cancels held text storage while retaining tail and original authority", async () => {
  const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");
  const { NodeHttpHandler } = await import("@smithy/node-http-handler");
  const { createRecordingCheckpointCapture } =
    await import("../../src/services/recordingCheckpointCapture");
  const { createHash } = await import("node:crypto");
  const fs = jest.requireActual<typeof import("node:fs")>("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const directory = fs.mkdtempSync(path.join(tmpdir(), "fenced-text-"));
  const controller = new AbortController();
  const handler = new NodeHttpHandler();
  const client = new S3Client({
    endpoint: "http://127.0.0.1:1",
    region: "local",
    forcePathStyle: true,
    credentials: { accessKeyId: "dummy", secretAccessKey: "dummy" },
    requestHandler: handler,
    maxAttempts: 1,
  });
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let settled = false;
  let watchdogFired = false;
  jest
    .spyOn(handler, "handle")
    .mockImplementation(async (_request, options) => {
      try {
        return await new Promise<never>((_resolve, reject) => {
          const signal = options!.abortSignal!;
          const abort = () => {
            clearTimeout(watchdog);
            signal.onabort = null;
            reject(
              Object.assign(new Error("generated fenced text"), {
                name: "AbortError",
              }),
            );
          };
          const watchdog = setTimeout(() => {
            watchdogFired = true;
            abort();
          }, 1000);
          signal.onabort = abort;
          entered();
        });
      } finally {
        settled = true;
      }
    });
  const meeting = finalizationFixture();
  meeting.ownershipSignal = controller.signal;
  meeting.recordingCapture = createRecordingCheckpointCapture({
    directory,
    startedAt: 0,
    signal: controller.signal,
    stopCapture: jest.fn(),
    commit: async (artifacts, signal) => {
      await client.send(
        new PutObjectCommand({
          Bucket: "generated",
          Key: "generated-text",
          Body: artifacts[0].bytes,
        }),
        { abortSignal: signal },
      );
      return true;
    },
  });
  try {
    const bytes = Buffer.from("generated late text");
    meeting.recordingCapture.queueContent({
      kind: "transcription",
      sourceId: "transcription",
      sequence: 0,
      bytes,
      checksumSha256: createHash("sha256").update(bytes).digest("hex"),
      contentType: "application/json",
      coverage: { kind: "unknown" },
    });
    await ready;
    fenceMeetingFinalization(meeting);
    await meeting.recordingCapture.settled();
    expect(settled).toBe(true);
    expect(watchdogFired).toBe(false);
    expect(meeting.recordingCapture.publicationSignal.aborted).toBe(true);
    expect(controller.signal.aborted).toBe(false);
    expect(await meeting.recordingCapture.drainContent()).toBe(false);
    expect(meeting.recordingCapture.pending()).toHaveLength(1);
    expect(meeting.setFinished).not.toHaveBeenCalled();
    meeting.recordingCapture.releaseSettledBuffers();
  } finally {
    client.destroy();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
