import {
  finalizationFixture,
  successfulArtifactUpload,
  successfulFinalPassResult,
} from "../fixtures/endMeeting";
import { getNotes } from "../../src/services/notesService";
import type { Client } from "discord.js";
import { runEndMeetingFlow } from "../../src/commands/endMeeting";
import { evaluateAutoRecordCancellation } from "../../src/services/autoRecordCancellationService";
import {
  buildMixedAudio,
  cleanupSpeakerTracks,
  closeOutputFile,
  waitForAudioOnlyFinishProcessing,
  waitForFinishProcessing,
} from "../../src/audio";
import {
  compileTranscriptions,
  createMeetingTranscriptCompiler,
  type MeetingTranscriptCompiler,
} from "../../src/services/transcriptCompilationService";
import { runTranscriptionFinalPass } from "../../src/services/transcriptionFinalPassService";
import * as recordingContent from "../../src/services/recordingContentService";
import { uploadMeetingArtifacts } from "../../src/services/uploadService";
import { saveMeetingHistoryToDatabase } from "../../src/commands/saveMeetingHistory";
import { cleanupMeetingTempDir } from "../../src/services/tempFileService";
import { getGuildLimits } from "../../src/services/subscriptionService";
import { transitionOwnedMeetingHistoryService } from "../../src/services/meetingHistoryService";
import { deleteMeeting } from "../../src/meetings";
import { MEETING_END_REASONS } from "../../src/types/meetingLifecycle";
import { releaseMeetingLeaseForMeeting } from "../../src/services/activeMeetingLeaseService";
import { describeAutoRecordRule } from "../../src/utils/meetingLifecycle";
import { captureEvent } from "../../src/services/analyticsService";
import {
  ensureMeetingNotes,
  ensureMeetingSummaries,
} from "../../src/services/meetingNotesService";
import { EMPTY_RECORDING_NOTICE } from "../../src/utils/meetingProcessing";
import { updateMeetingSummaryMessage } from "../../src/embed";

describe("completion notes latency contract", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-10-16T12:01:00.000Z"));
    jest
      .mocked(describeAutoRecordRule)
      .mockReturnValue("Auto-record rule: test-channel");
    jest.mocked(captureEvent).mockReset();
    jest.mocked(cleanupMeetingTempDir).mockResolvedValue(undefined);
    jest.mocked(cleanupSpeakerTracks).mockResolvedValue(undefined);
    jest.mocked(closeOutputFile).mockResolvedValue(undefined);
    jest.mocked(buildMixedAudio).mockResolvedValue(undefined);
    jest.mocked(waitForAudioOnlyFinishProcessing).mockResolvedValue(undefined);
    jest.mocked(waitForFinishProcessing).mockResolvedValue(undefined);
    jest.mocked(compileTranscriptions).mockResolvedValue("Private transcript");
    jest
      .mocked(saveMeetingHistoryToDatabase)
      .mockImplementation(async (meeting) => {
        meeting.historySaved = true;
      });
    jest.mocked(releaseMeetingLeaseForMeeting).mockResolvedValue(true);
    jest
      .mocked(evaluateAutoRecordCancellation)
      .mockResolvedValue({ cancel: false });
    jest
      .mocked(uploadMeetingArtifacts)
      .mockResolvedValue(successfulArtifactUpload);
    jest
      .mocked(transitionOwnedMeetingHistoryService)
      .mockResolvedValue(undefined);
    jest.mocked(getGuildLimits).mockResolvedValue({ limits: {} } as never);
    jest.mocked(ensureMeetingNotes).mockImplementation(async (input) => {
      input.notesText = "Private notes";
      input.processing = { ...input.processing, notes: "generated" };
      return input.notesText;
    });
    jest
      .mocked(updateMeetingSummaryMessage)
      .mockImplementation(async (meeting) => {
        const notes = {
          outcome: "complete" as const,
          sent: 2,
          intended: 2,
          errors: [],
        };
        meeting.delivery = { notes };
        return {
          notes,
          summary: {
            outcome: "not_applicable",
            sent: 0,
            intended: 0,
            errors: [],
          },
        };
      });
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.mocked(captureEvent).mockReset();
  });

  function timedMeeting() {
    const meeting = finalizationFixture();
    Object.assign(meeting.textChannel, {
      send: jest.fn().mockResolvedValue({ id: "cancel-notice" }),
    });
    meeting.startTime = new Date("2026-10-16T12:00:00.000Z");
    meeting.transcribeMeeting = true;
    meeting.generateNotes = true;
    meeting.audioData.audioFiles = [
      {
        userId: "creator",
        timestamp: Date.now(),
        processing: false,
        audioOnlyProcessing: false,
        transcript: "Private transcript",
      },
    ];
    meeting.recordingCaptureState = {
      kind: "complete",
      startedAt: "2026-10-16T11:59:00.000Z",
      endedAt: "2026-10-16T12:00:00.000Z",
    };
    meeting.notesDeliveryTiming = {
      kind: "complete",
      notesVersion: 1,
      path: "live",
      firstAcknowledgedAt: "2026-10-16T12:00:02.000Z",
      completeAcknowledgedAt: "2026-10-16T12:00:05.000Z",
    };
    return meeting;
  }

  function completionCapture() {
    expect(captureEvent).toHaveBeenCalledTimes(1);
    const [event, completion] = jest.mocked(captureEvent).mock.calls[0];
    expect(event).toBe("meeting_completed");
    if (!completion?.properties)
      throw new Error("Expected completion properties");
    return { ...completion, properties: completion.properties };
  }

  it("owns one compiler for notes, the processed checkpoint and cue-inclusive upload", async () => {
    const meeting = timedMeeting();
    const client = {} as Client;
    const compile = jest.fn<
      ReturnType<MeetingTranscriptCompiler>,
      Parameters<MeetingTranscriptCompiler>
    >(async (options) => {
      options?.cleanupAcknowledged?.("acknowledged");
      return options?.includeCues
        ? "Synthetic upload transcript"
        : "Synthetic notes transcript";
    });
    jest.mocked(createMeetingTranscriptCompiler).mockReturnValueOnce(compile);
    jest.mocked(runTranscriptionFinalPass).mockResolvedValueOnce({
      ...successfulFinalPassResult,
      enabled: false,
    });
    const checkpoint = jest.spyOn(
      recordingContent,
      "checkpointCompletedTranscription",
    );
    try {
      await runEndMeetingFlow({ client, meeting });
      expect(createMeetingTranscriptCompiler).toHaveBeenCalledTimes(1);
      expect(createMeetingTranscriptCompiler).toHaveBeenCalledWith(
        client,
        meeting,
      );
      expect(compile).toHaveBeenCalledTimes(2);
      expect(compile).toHaveBeenNthCalledWith(1, {
        cleanupAcknowledged: expect.any(Function),
      });
      expect(compile).toHaveBeenNthCalledWith(2, { includeCues: true });
      expect(meeting.finalTranscript).toBe("Synthetic notes transcript");
      expect(checkpoint).toHaveBeenCalledWith(meeting, {
        finalPass: "disabled",
        cleanup: "acknowledged",
        finalText: "Synthetic notes transcript",
      });
      expect(uploadMeetingArtifacts).toHaveBeenCalledWith(
        meeting,
        expect.objectContaining({
          transcriptText: "Synthetic upload transcript",
        }),
      );
    } finally {
      checkpoint.mockRestore();
    }
  });

  it("adds version 3 timing without changing recording duration", async () => {
    const meeting = timedMeeting();
    await runEndMeetingFlow({ client: {} as Client, meeting });
    const completion = completionCapture();
    expect(completion.properties.event_version).toBe(3);
    expect(completion).toEqual({
      userId: "creator",
      guildId: "h4-guild",
      properties: {
        duration_ms: 60000,
        attendee_count: 0,
        end_reason: MEETING_END_REASONS.UNKNOWN,
        trigger: undefined,
        transcribed: true,
        notes_generated: true,
        cancelled: false,
        event_version: 3,
        surface: "discord",
        transcription_outcome: "ready",
        notes_outcome: "generated",
        history_persistence: "saved",
        notes_delivery: "complete",
        usable_notes: true,
        notes_latency_status: "measured",
        notes_first_delivery_latency_ms: 2000,
        notes_complete_delivery_latency_ms: 5000,
        notes_delivery_path: "live",
      },
    });
  });

  it.each(["empty", "generated"])(
    "persists actual delivery and completion timing for %s notes",
    async (outcome) => {
      const db = await import("../../src/db");
      const historyService =
        await import("../../src/services/meetingHistoryService");
      const notion = await import("../../src/services/notionAutomationService");
      const upgrade = await import("../../src/services/summaryUpgradeService");
      const delivery =
        await import("../../src/services/recordingDeliveryService");
      const realDelivery = jest.requireActual<typeof delivery>(
        "../../src/services/recordingDeliveryService",
      );
      const realNotes = jest.requireActual<
        typeof import("../../src/services/meetingNotesService")
      >("../../src/services/meetingNotesService");
      const meeting = timedMeeting();
      meeting.notesDeliveryTiming = undefined;
      meeting.summarySentence = "Synthetic summary";
      if (outcome === "empty") {
        meeting.audioData.audioFiles = [];
        jest.mocked(compileTranscriptions).mockResolvedValue("");
      }
      meeting.startMessageId = "summary";
      const edit = jest.fn().mockResolvedValue(undefined);
      const send = jest.fn().mockResolvedValue({ id: "notes" });
      Object.assign(meeting.textChannel, {
        messages: {
          fetch: jest.fn().mockResolvedValue({ id: "summary", edit }),
        },
        send,
      });
      const row: import("../../src/types/db").MeetingHistory = {
        guildId: meeting.guildId,
        channelId_timestamp: "key",
        meetingId: meeting.meetingId,
        channelId: meeting.voiceChannel.id,
        timestamp: meeting.startTime.toISOString(),
        participants: [],
        duration: 60,
        transcribeMeeting: true,
        generateNotes: true,
        ownerInstanceId: "owner",
        executionVersion: 1,
        status: "processing",
        checkpoint: {
          artifactFolder: "synthetic",
          schemaVersion: 1,
          revision: 3,
          capture: {
            guildId: meeting.guildId,
            channelId: meeting.voiceChannel.id,
            channelId_timestamp: "key",
            meetingId: meeting.meetingId,
            ownerInstanceId: "owner",
            executionVersion: 1,
            reservedAt: meeting.startTime.toISOString(),
            captureStartedAt: meeting.startTime.toISOString(),
            requested: { transcribeMeeting: true, generateNotes: true },
          },
          manifest: {
            key: "manifest",
            checksumSha256: "a".repeat(64),
            byteLength: 1,
          },
        },
      };
      const repository = db.getDeploymentControlRepository();
      const getRepository = jest
        .spyOn(db, "getDeploymentControlRepository")
        .mockReturnValue({
          ...repository,
          getMeetingHistory: async () => ({ ...row }),
          transitionMeetingHistory: async (input) => {
            Object.assign(row, input.patch);
            return "applied";
          },
        });
      const saveHistory = jest
        .spyOn(historyService, "saveOwnedMeetingHistoryService")
        .mockImplementation(async (_meeting, history) => {
          Object.assign(row, history);
          return history;
        });
      const exportNotes = jest
        .spyOn(notion, "maybeAutoExportCompletedMeeting")
        .mockResolvedValue(undefined);
      const claimUpgrade = jest
        .spyOn(upgrade, "claimSummaryUpgrade")
        .mockResolvedValue(undefined);
      jest
        .mocked(ensureMeetingNotes)
        .mockImplementation(realNotes.ensureMeetingNotes);
      jest
        .mocked(ensureMeetingSummaries)
        .mockImplementation(realNotes.ensureMeetingSummaries);
      jest.mocked(getNotes).mockResolvedValue("Private notes");
      jest
        .mocked(saveMeetingHistoryToDatabase)
        .mockImplementation(
          jest.requireActual<
            typeof import("../../src/commands/saveMeetingHistory")
          >("../../src/commands/saveMeetingHistory")
            .saveMeetingHistoryToDatabase,
        );
      jest
        .mocked(updateMeetingSummaryMessage)
        .mockImplementationOnce(
          jest.requireActual<typeof import("../../src/embed")>(
            "../../src/embed",
          ).updateMeetingSummaryMessage,
        );
      jest
        .mocked(delivery.acknowledgeRecordingDeliveryHistory)
        .mockImplementationOnce(
          realDelivery.acknowledgeRecordingDeliveryHistory,
        );
      try {
        await runEndMeetingFlow({ client: {} as Client, meeting });
        expect(send).toHaveBeenCalledTimes(1);
        expect(send.mock.calls[0][0].embeds[0].toJSON().description).toBe(
          outcome === "empty" ? EMPTY_RECORDING_NOTICE : "Private notes",
        );
        expect(edit).toHaveBeenCalledTimes(1);
        expect(row).toMatchObject({
          status: "complete",
          notesMessageIds: ["notes"],
          notesChannelId: "text",
          recovery: { disposition: "done", outcome: "completed" },
          processing: {
            transcription: outcome === "empty" ? "empty" : "ready",
            notes: outcome === "empty" ? "skipped" : "generated",
          },
        });
        const completion = completionCapture();
        if (outcome === "empty") {
          expect(row.notes).toBeUndefined();
          expect(row.notesDeliveryTiming).toBeUndefined();
          expect(meeting.notesDeliveryTiming).toBeUndefined();
          expect(completion.properties.notes_latency_status).toBe("unknown");
          expect(completion.properties).not.toHaveProperty(
            "notes_first_delivery_latency_ms",
          );
          expect(completion.properties).not.toHaveProperty(
            "notes_complete_delivery_latency_ms",
          );
        } else {
          expect(row.notesDeliveryTiming).toEqual(meeting.notesDeliveryTiming);
          expect(row.notesDeliveryTiming?.kind).toBe("complete");
          expect(completion.properties).toMatchObject({
            notes_latency_status: "measured",
            notes_first_delivery_latency_ms: 60000,
            notes_complete_delivery_latency_ms: 60000,
            notes_delivery_path: "live",
          });
        }
        expect(meeting.historySaved).toBe(true);
        expect(meeting.setFinished).toHaveBeenCalledTimes(1);
      } finally {
        getRepository.mockRestore();
        saveHistory.mockRestore();
        exportNotes.mockRestore();
        claimUpgrade.mockRestore();
        jest.mocked(ensureMeetingSummaries).mockReset();
      }
    },
  );
  it("retains first-only timing for partial delivery", async () => {
    const meeting = timedMeeting();
    meeting.notesDeliveryTiming = {
      kind: "first",
      notesVersion: 1,
      path: "live",
      firstAcknowledgedAt: "2026-10-16T12:00:02.000Z",
    };
    jest
      .mocked(updateMeetingSummaryMessage)
      .mockImplementationOnce(async (current) => {
        const notes = {
          outcome: "partial" as const,
          sent: 1,
          intended: 2,
          errors: [],
        };
        current.delivery = { notes };
        return {
          notes,
          summary: {
            outcome: "not_applicable",
            sent: 0,
            intended: 0,
            errors: [],
          },
        };
      });
    await runEndMeetingFlow({ client: {} as Client, meeting });
    const completion = completionCapture();
    expect(completion.properties).toMatchObject({
      notes_latency_status: "partial",
      notes_first_delivery_latency_ms: 2000,
      notes_delivery_path: "live",
      notes_generated: true,
      notes_delivery: "partial",
      usable_notes: false,
    });
    expect(completion.properties).not.toHaveProperty(
      "notes_complete_delivery_latency_ms",
    );
  });

  it.each([
    "notes_disabled",
    "transcription_disabled",
    "cancelled",
    "missing_stop",
    "legacy",
  ])("keeps unavailable timing explicit for %s", async (state) => {
    const meeting = timedMeeting();
    if (state === "notes_disabled") meeting.generateNotes = false;
    if (state === "transcription_disabled") meeting.transcribeMeeting = false;
    if (state === "cancelled") meeting.cancelled = true;
    if (state === "missing_stop") meeting.recordingCaptureState = undefined;
    if (state === "legacy") meeting.notesDeliveryTiming = undefined;
    await runEndMeetingFlow({ client: {} as Client, meeting });
    const completion = completionCapture();
    expect(completion.properties).toMatchObject({
      event_version: 3,
      duration_ms: 60000,
      notes_latency_status: ["missing_stop", "legacy"].includes(state)
        ? "unknown"
        : "not_applicable",
    });
    expect(completion.properties).not.toHaveProperty(
      "notes_first_delivery_latency_ms",
    );
    expect(completion.properties).not.toHaveProperty(
      "notes_complete_delivery_latency_ms",
    );
    expect(completion.properties.notes_delivery_path).toBe(
      state === "missing_stop" ? "live" : undefined,
    );
  });

  it("does not add a completion when notes processing fails", async () => {
    const meeting = timedMeeting();
    meeting.notesDeliveryTiming = undefined;
    jest.mocked(ensureMeetingNotes).mockImplementationOnce(async (input) => {
      input.processing = { ...input.processing, notes: "failed" };
      return undefined;
    });
    await expect(
      runEndMeetingFlow({ client: {} as Client, meeting }),
    ).rejects.toThrow("processing failed");
    expect(captureEvent).not.toHaveBeenCalled();
    expect(meeting.setFinished).not.toHaveBeenCalled();
  });

  it("contains timing property assembly inside the analytics guard", async () => {
    const meeting = timedMeeting();
    Object.defineProperty(meeting, "notesDeliveryTiming", {
      get() {
        throw new Error("invalid optional timing access");
      },
    });
    const warning = jest.spyOn(console, "warn");
    try {
      await expect(
        runEndMeetingFlow({ client: {} as Client, meeting }),
      ).resolves.toBeUndefined();
      expect(captureEvent).not.toHaveBeenCalled();
      expect(deleteMeeting).toHaveBeenCalledWith(meeting.guildId);
      expect(warning).toHaveBeenCalledWith(
        "Failed to capture meeting_completed",
        expect.any(Object),
      );
    } finally {
      warning.mockRestore();
    }
  });

  it("cannot fail finalization when analytics throws", async () => {
    const meeting = timedMeeting();
    jest.mocked(captureEvent).mockImplementationOnce(() => {
      throw new Error("analytics unavailable");
    });
    const warning = jest.spyOn(console, "warn");
    try {
      await expect(
        runEndMeetingFlow({ client: {} as Client, meeting }),
      ).resolves.toBeUndefined();
      expect(meeting.setFinished).toHaveBeenCalledTimes(1);
      expect(deleteMeeting).toHaveBeenCalledWith(meeting.guildId);
      expect(warning).toHaveBeenCalledWith(
        "Failed to capture meeting_completed",
        expect.any(Object),
      );
    } finally {
      warning.mockRestore();
    }
  });
});
