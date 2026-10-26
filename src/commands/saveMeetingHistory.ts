import { getMeetingProcessingSignal } from "../services/meetingProcessingLifetime";
import { assertNotionOutcomeKnown } from "../services/notionOperationLifetime";
import { assertMeetingProcessingSucceeded } from "../utils/meetingProcessing";
import { notesDeliveryTimingSchema } from "../types/meetingNotesTiming";
import { MeetingData } from "../types/meeting-data";
import { MeetingHistory } from "../types/db";
import { MEETING_STATUS } from "../types/meetingLifecycle";
import { saveOwnedMeetingHistoryService } from "../services/meetingHistoryService";
import { maybeAutoExportCompletedMeeting } from "../services/notionAutomationService";
import {
  ensureLiveMeetingNotes as ensureMeetingNotes,
  ensureLiveMeetingSummaries as ensureMeetingSummaries,
} from "../services/liveMeetingNotesService";
import { trimNotesForHistory } from "../utils/notesHistory";
import { transitionMeetingHistory } from "../db";

function buildNotesMetadata(
  meeting: MeetingData,
  notes: string | undefined,
  timestamp: string,
) {
  const notesVersion = resolveNotesVersion(meeting, notes);
  const notesLastEditedBy = resolveNotesLastEditedBy(meeting, notes);
  const notesLastEditedAt = resolveNotesLastEditedAt(
    meeting,
    notesVersion,
    timestamp,
  );
  const notesHistory = buildNotesHistory({
    meeting,
    notes,
    notesVersion,
    notesLastEditedBy,
    notesLastEditedAt,
    timestamp,
  });

  return { notesVersion, notesLastEditedBy, notesLastEditedAt, notesHistory };
}

function resolveNotesVersion(
  meeting: MeetingData,
  notes: string | undefined,
): number | undefined {
  if (meeting.notesVersion != null) return meeting.notesVersion;
  return notes ? 1 : undefined;
}

function resolveNotesLastEditedBy(
  meeting: MeetingData,
  notes: string | undefined,
): string | undefined {
  if (meeting.notesLastEditedBy) return meeting.notesLastEditedBy;
  return notes ? meeting.creator.id : undefined;
}

function resolveNotesLastEditedAt(
  meeting: MeetingData,
  notesVersion: number | undefined,
  timestamp: string,
): string | undefined {
  if (meeting.notesLastEditedAt) return meeting.notesLastEditedAt;
  if (!notesVersion) return undefined;
  return meeting.endTime?.toISOString() ?? timestamp;
}

function buildNotesHistory(options: {
  meeting: MeetingData;
  notes: string | undefined;
  notesVersion: number | undefined;
  notesLastEditedBy: string | undefined;
  notesLastEditedAt: string | undefined;
  timestamp: string;
}) {
  const {
    meeting,
    notes,
    notesVersion,
    notesLastEditedBy,
    notesLastEditedAt,
    timestamp,
  } = options;
  if (!notes || !notesVersion) return undefined;
  return [
    {
      version: notesVersion,
      notes: trimNotesForHistory(notes),
      editedBy: notesLastEditedBy ?? meeting.creator.id,
      editedAt: notesLastEditedAt ?? timestamp,
    },
  ];
}

function buildDeliveryMetadata(
  meeting: MeetingData,
  notesDeliveryTiming: MeetingHistory["notesDeliveryTiming"],
) {
  return {
    startReason: meeting.startReason,
    startTriggeredByUserId: meeting.startTriggeredByUserId,
    autoRecordRule: meeting.autoRecordRule,
    endReason: meeting.endReason,
    endTriggeredByUserId: meeting.endTriggeredByUserId,
    cancellationReason: meeting.cancellationReason,
    summaryMessageId:
      meeting.summaryMessageId ?? meeting.startMessageId ?? undefined,
    notesMessageIds: meeting.notesMessageIds,
    notesDeliveryTiming,
    delivery: meeting.delivery,
    notesChannelId: meeting.notesChannelId,
  };
}

export async function saveMeetingHistoryToDatabase(meeting: MeetingData) {
  meeting.historySaved = false;
  if (meeting.sessionMode === "tts_only") return;

  try {
    assertMeetingProcessingSucceeded(meeting);
    const timing = notesDeliveryTimingSchema.safeParse(
      meeting.notesDeliveryTiming,
    );
    const notesDeliveryTiming = timing.success ? timing.data : undefined;
    const timestamp = meeting.startTime.toISOString();
    const duration = meeting.endTime
      ? Math.floor(
          (meeting.endTime.getTime() - meeting.startTime.getTime()) / 1000,
        )
      : 0;

    if (meeting.cancelled) {
      const history: MeetingHistory = {
        guildId: meeting.guildId,
        channelId_timestamp: `${meeting.voiceChannel.id}#${timestamp}`,
        meetingId: meeting.meetingId,
        channelId: meeting.voiceChannel.id,
        textChannelId: meeting.textChannel.id,
        timestamp,
        tags: meeting.tags,
        context: meeting.meetingContext,
        participants: Array.from(meeting.participants.values()),
        duration,
        transcribeMeeting: meeting.transcribeMeeting,
        generateNotes: meeting.generateNotes,
        meetingCreatorId: meeting.creator.id,
        isAutoRecording: meeting.isAutoRecording,
        status: MEETING_STATUS.CANCELLED,
        processing: meeting.processing,
        ...buildDeliveryMetadata(meeting, notesDeliveryTiming),
        transcriptS3Key: meeting.transcriptS3Key,
        audioS3Key: meeting.audioS3Key,
        chatS3Key: meeting.chatS3Key,
      };
      await saveOwnedMeetingHistoryService(meeting, history);
      meeting.historySaved = true;
      console.log(
        `Cancelled meeting history saved for guild ${meeting.guildId}, channel ${meeting.voiceChannel.id}`,
      );
      return;
    }

    const notes = await ensureMeetingNotes(meeting);
    const summaries = await ensureMeetingSummaries(meeting, notes);
    assertMeetingProcessingSucceeded(meeting);
    const transcriptS3Key = meeting.transcriptS3Key;
    const { notesVersion, notesLastEditedBy, notesLastEditedAt, notesHistory } =
      buildNotesMetadata(meeting, notes, timestamp);

    const history: MeetingHistory = {
      guildId: meeting.guildId,
      channelId_timestamp: `${meeting.voiceChannel.id}#${timestamp}`,
      meetingId: meeting.meetingId,
      channelId: meeting.voiceChannel.id,
      textChannelId: meeting.textChannel.id,
      timestamp,
      tags: meeting.tags,
      notes,
      meetingName: meeting.meetingName,
      summarySentence: summaries.summarySentence,
      summaryLabel: summaries.summaryLabel,
      context: meeting.meetingContext,
      participants: Array.from(meeting.participants.values()),
      duration,
      transcribeMeeting: meeting.transcribeMeeting,
      generateNotes: meeting.generateNotes,
      processing: meeting.processing,
      meetingCreatorId: meeting.creator.id,
      isAutoRecording: meeting.isAutoRecording,
      status: MEETING_STATUS.COMPLETE,
      ...buildDeliveryMetadata(meeting, notesDeliveryTiming),
      notesVersion,
      notesLastEditedBy,
      notesLastEditedAt,
      notesHistory,
      transcriptS3Key,
      audioS3Key: meeting.audioS3Key,
      chatS3Key: meeting.chatS3Key,
    };

    await saveOwnedMeetingHistoryService(meeting, history);
    meeting.historySaved = true;
    try {
      await maybeAutoExportCompletedMeeting(
        history,
        getMeetingProcessingSignal(meeting),
      );
    } catch (error) {
      assertNotionOutcomeKnown(error, getMeetingProcessingSignal(meeting));
      console.warn("Completed meeting Notion export failed", {
        meetingId: meeting.meetingId,
        error,
      });
    }
    console.log(
      `Meeting history saved for guild ${meeting.guildId}, channel ${meeting.voiceChannel.id}`,
    );
  } catch (error) {
    console.error("Failed to save meeting history:", error);
    throw error;
  }
}

export async function saveMeetingStartToDatabase(
  meeting: MeetingData,
): Promise<void> {
  if (meeting.reservation) {
    const reservation = meeting.reservation;
    if (reservation.sessionMode === "tts_only") return;
    const result = await transitionMeetingHistory({
      key: reservation.historyKey,
      expectedMeetingId: reservation.meetingId,
      expectedOwnerInstanceId: reservation.ownerInstanceId,
      expectedExecutionVersion: reservation.executionVersion,
      expectedStatus: MEETING_STATUS.STARTING,
      patch: {
        status: MEETING_STATUS.IN_PROGRESS,
        updatedAt: new Date().toISOString(),
      },
    });
    if (result !== "applied")
      throw new Error("Meeting initialization lost history ownership");
    return;
  }
  throw new Error("Recording initialization requires its owned reservation");
}
