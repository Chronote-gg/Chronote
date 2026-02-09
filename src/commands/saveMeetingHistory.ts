import { MeetingData } from "../types/meeting-data";
import { MeetingHistory } from "../types/db";
import { MEETING_STATUS } from "../types/meetingLifecycle";
import { writeMeetingHistoryService } from "../services/meetingHistoryService";
import {
  ensureMeetingNotes,
  ensureMeetingSummaries,
} from "../services/meetingNotesService";
import { trimNotesForHistory } from "../utils/notesHistory";

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

export async function saveMeetingHistoryToDatabase(meeting: MeetingData) {
  if (!meeting.transcribeMeeting) {
    return;
  }

  try {
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
        startReason: meeting.startReason,
        startTriggeredByUserId: meeting.startTriggeredByUserId,
        autoRecordRule: meeting.autoRecordRule,
        endReason: meeting.endReason,
        endTriggeredByUserId: meeting.endTriggeredByUserId,
        cancellationReason: meeting.cancellationReason,
        summaryMessageId:
          meeting.summaryMessageId ?? meeting.startMessageId ?? undefined,
        notesMessageIds: meeting.notesMessageIds,
        notesChannelId: meeting.notesChannelId,
        transcriptS3Key: meeting.transcriptS3Key,
        audioS3Key: meeting.audioS3Key,
        chatS3Key: meeting.chatS3Key,
      };
      await writeMeetingHistoryService(history);
      console.log(
        `Cancelled meeting history saved for guild ${meeting.guildId}, channel ${meeting.voiceChannel.id}`,
      );
      return;
    }

    const notes = await ensureMeetingNotes(meeting);
    const summaries = await ensureMeetingSummaries(meeting, notes);
    const transcriptS3Key = meeting.transcriptS3Key;
    const { notesVersion, notesLastEditedBy, notesLastEditedAt, notesHistory } =
      buildNotesMetadata(meeting, notes, timestamp);

    const history: MeetingHistory = {
      guildId: meeting.guildId,
      channelId_timestamp: `${meeting.voiceChannel.id}#${timestamp}`,
      meetingId: meeting.meetingId,
      channelId: meeting.voiceChannel.id,
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
      meetingCreatorId: meeting.creator.id,
      isAutoRecording: meeting.isAutoRecording,
      status: MEETING_STATUS.COMPLETE,
      startReason: meeting.startReason,
      startTriggeredByUserId: meeting.startTriggeredByUserId,
      autoRecordRule: meeting.autoRecordRule,
      endReason: meeting.endReason,
      endTriggeredByUserId: meeting.endTriggeredByUserId,
      cancellationReason: meeting.cancellationReason,
      summaryMessageId:
        meeting.summaryMessageId ?? meeting.startMessageId ?? undefined,
      notesMessageIds: meeting.notesMessageIds,
      notesChannelId: meeting.notesChannelId,
      notesVersion,
      notesLastEditedBy,
      notesLastEditedAt,
      notesHistory,
      transcriptS3Key,
      audioS3Key: meeting.audioS3Key,
      chatS3Key: meeting.chatS3Key,
    };

    await writeMeetingHistoryService(history);
    console.log(
      `Meeting history saved for guild ${meeting.guildId}, channel ${meeting.voiceChannel.id}`,
    );
  } catch (error) {
    console.error("Failed to save meeting history:", error);
    // Don't throw - we don't want to fail the meeting end process if history save fails
  }
}

export async function saveMeetingStartToDatabase(
  meeting: MeetingData,
): Promise<void> {
  if (!meeting.transcribeMeeting) return;
  try {
    const timestamp = meeting.startTime.toISOString();
    const history: MeetingHistory = {
      guildId: meeting.guildId,
      channelId_timestamp: `${meeting.voiceChannel.id}#${timestamp}`,
      meetingId: meeting.meetingId,
      channelId: meeting.voiceChannel.id,
      timestamp,
      tags: meeting.tags,
      context: meeting.meetingContext,
      participants: Array.from(meeting.participants.values()),
      duration: 0,
      transcribeMeeting: meeting.transcribeMeeting,
      generateNotes: meeting.generateNotes,
      meetingCreatorId: meeting.creator.id,
      isAutoRecording: meeting.isAutoRecording,
      status: MEETING_STATUS.IN_PROGRESS,
      startReason: meeting.startReason,
      startTriggeredByUserId: meeting.startTriggeredByUserId,
      autoRecordRule: meeting.autoRecordRule,
    };
    await writeMeetingHistoryService(history);
  } catch (error) {
    console.error("Failed to save meeting start history:", error);
  }
}
