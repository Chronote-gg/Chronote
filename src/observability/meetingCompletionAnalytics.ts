import { getNotesLatencyProperties } from "./meetingNotesLatency";
import { captureEvent } from "../services/analyticsService";
import { resolveMeetingActorId } from "../utils/meetingLifecycle";
import { MEETING_END_REASONS } from "../types/meetingLifecycle";
import type { MeetingData } from "../types/meeting-data";

/**
 * Counts and flags only. Notes, transcript, and chat content are user data and
 * must not leave the system as event properties.
 *
 * Reading the meeting to build those properties happens inside the guard on
 * purpose. This runs on a finalization path, so an unexpected shape here would
 * otherwise throw into the caller's error cleanup and tear down a meeting that
 * had already finished, for the sake of an analytics event.
 *
 * Called from both finalization paths. A cancelled auto-recording finishes
 * through its own branch, and skipping it there would leave those meetings
 * emitting meeting_started with no completion, so ordinary cancellation would
 * read as funnel abandonment.
 */
function hasUsableMeetingNotes(meeting: MeetingData): boolean {
  return (
    !meeting.cancelled &&
    meeting.processing?.transcription === "ready" &&
    meeting.processing?.notes === "generated" &&
    Boolean(meeting.notesText?.trim()) &&
    meeting.historySaved === true &&
    meeting.delivery?.notes?.outcome === "complete"
  );
}

export function captureMeetingCompleted(meeting: MeetingData): void {
  try {
    const endTime = meeting.endTime ?? new Date();
    captureEvent("meeting_completed", {
      userId: resolveMeetingActorId(meeting),
      guildId: meeting.guildId,
      properties: {
        duration_ms: endTime.getTime() - meeting.startTime.getTime(),
        attendee_count: meeting.attendance.size,
        end_reason: meeting.endReason ?? MEETING_END_REASONS.UNKNOWN,
        trigger: meeting.startReason,
        transcribed: meeting.transcribeMeeting,
        notes_generated: meeting.generateNotes,
        cancelled: Boolean(meeting.cancelled),
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
          capture: meeting.recordingCaptureState,
          timing: meeting.notesDeliveryTiming,
          eligible:
            meeting.transcribeMeeting &&
            meeting.generateNotes &&
            !meeting.cancelled,
        }),
      },
    });
  } catch (error) {
    console.warn("Failed to capture meeting_completed", {
      meetingId: meeting.meetingId,
      error,
    });
  }
}
