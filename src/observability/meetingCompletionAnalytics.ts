import { getNotesLatencyProperties } from "./meetingNotesLatency";
import { captureEvent } from "../services/analyticsService";
import { resolveHistoryActorId } from "../utils/meetingLifecycle";
import { MEETING_END_REASONS } from "../types/meetingLifecycle";
import type { MeetingData } from "../types/meeting-data";
import type { MeetingHistory } from "../types/db";

const MS_PER_SECOND = 1000;

/** The facts meeting_completed reports, read from a live meeting or a saved row. */
type CompletedMeeting = {
  meetingId: string;
  guildId: string;
  userId?: string;
  durationMs: number;
  attendeeCount: number;
  endReason?: MeetingData["endReason"];
  startReason?: MeetingData["startReason"];
  transcribed: boolean;
  notesGenerated: boolean;
  cancelled: boolean;
  processing?: MeetingData["processing"];
  hasNotes: boolean;
  historySaved?: boolean;
  delivery?: MeetingData["delivery"];
  capture?: MeetingData["recordingCaptureState"];
  timing?: MeetingData["notesDeliveryTiming"];
};

/**
 * Counts and flags only. Notes, transcript, and chat content are user data and
 * must not leave the system as event properties.
 *
 * Reading the meeting to build those properties happens inside the guard on
 * purpose. This runs on a finalization path, so an unexpected shape here would
 * otherwise throw into the caller's error cleanup and tear down a meeting that
 * had already finished, for the sake of an analytics event.
 *
 * A cancelled meeting emits it too. Skipping it would leave those meetings
 * emitting meeting_started with no completion, so ordinary cancellation would
 * read as funnel abandonment.
 */
function hasUsableMeetingNotes(meeting: CompletedMeeting): boolean {
  return (
    !meeting.cancelled &&
    meeting.processing?.transcription === "ready" &&
    meeting.processing?.notes === "generated" &&
    meeting.hasNotes &&
    meeting.historySaved === true &&
    meeting.delivery?.notes?.outcome === "complete"
  );
}

function captureCompleted(
  meetingId: string,
  read: () => CompletedMeeting,
): void {
  try {
    const meeting = read();
    captureEvent("meeting_completed", {
      userId: meeting.userId,
      guildId: meeting.guildId,
      properties: {
        duration_ms: meeting.durationMs,
        attendee_count: meeting.attendeeCount,
        end_reason: meeting.endReason ?? MEETING_END_REASONS.UNKNOWN,
        trigger: meeting.startReason,
        transcribed: meeting.transcribed,
        notes_generated: meeting.notesGenerated,
        cancelled: meeting.cancelled,
        event_version: 3,
        surface: "discord",
        transcription_outcome: meeting.processing?.transcription ?? "unknown",
        notes_outcome: meeting.processing?.notes ?? "unknown",
        history_persistence:
          meeting.historySaved === undefined
            ? "unknown"
            : meeting.historySaved
              ? "saved"
              : "not_saved",
        notes_delivery: meeting.delivery?.notes?.outcome ?? "unknown",
        usable_notes: hasUsableMeetingNotes(meeting),
        ...getNotesLatencyProperties({
          capture: meeting.capture,
          timing: meeting.timing,
          eligible:
            meeting.transcribed && meeting.notesGenerated && !meeting.cancelled,
        }),
      },
    });
  } catch (error) {
    console.warn("Failed to capture meeting_completed", { meetingId, error });
  }
}

/** The same event for a meeting finished from its saved history row. */
export function captureHistoryMeetingCompleted(history: MeetingHistory): void {
  captureCompleted(history.meetingId, () => ({
    meetingId: history.meetingId,
    guildId: history.guildId,
    userId: resolveHistoryActorId(history),
    durationMs: history.duration * MS_PER_SECOND,
    attendeeCount: history.participants.length,
    endReason: history.endReason,
    startReason: history.startReason,
    transcribed: history.transcribeMeeting,
    notesGenerated: history.generateNotes,
    cancelled: history.status === "cancelled",
    processing: history.processing,
    hasNotes: Boolean(history.notes?.trim()),
    historySaved: true,
    delivery: history.delivery,
    capture: history.capture,
    timing: history.notesDeliveryTiming,
  }));
}
