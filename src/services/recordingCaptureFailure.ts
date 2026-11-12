import type { MeetingData } from "../types/meeting-data";
import { appendMeetingCheckpointArtifacts } from "./recordingCheckpointService";
import { MEETING_END_REASONS } from "../types/meetingLifecycle";

const PRESERVATION_TIMEOUT_MS = 5000;

function notifyCapturePreservationFailure(meeting: MeetingData): void {
  let complete!: () => void;
  const notification: NonNullable<
    MeetingData["recordingPreservationNotification"]
  > = {
    promise: new Promise<void>((resolve) => {
      complete = resolve;
    }),
    outcome: "pending",
  };
  meeting.recordingPreservationNotification = notification;
  try {
    void meeting.textChannel
      .send(
        "Recording stopped because audio could not be safely saved. Some recent audio may be unavailable.",
      )
      .then(
        () => {
          notification.outcome = "acknowledged";
          complete();
        },
        () => {
          notification.outcome = "unknown";
          complete();
        },
      );
  } catch {
    notification.outcome = "unknown";
    complete();
  }
}

export function handleRecordingCaptureFailure(
  meeting: MeetingData,
  reason: "storage_preservation" | "ownership_lost",
  stopCapture: () => void,
): void {
  console.warn("Recording checkpoint capture interrupted", {
    meetingId: meeting.meetingId,
    reason,
    checkpointRevision: meeting.recordingCheckpoint?.revision,
    ...meeting.recordingCapture?.snapshot(),
  });
  stopCapture();
  const state = meeting.recordingCaptureState;
  const stoppedAt =
    (state?.kind === "complete" || state?.kind === "interrupted"
      ? state.endedAt
      : null) ?? new Date().toISOString();
  const handoff: NonNullable<MeetingData["recordingPreservationFailure"]> = {
    reason,
    stoppedAt,
    preservation: "pending",
    lastConfirmedCheckpoint: meeting.recordingCheckpoint,
  };
  meeting.recordingPreservationFailure = handoff;
  meeting.recordingPreservationTask = Promise.resolve()
    .then(async () => {
      await meeting.recordingCapture?.settled();
      const signal = AbortSignal.any([
        ...(meeting.ownershipSignal ? [meeting.ownershipSignal] : []),
        AbortSignal.timeout(PRESERVATION_TIMEOUT_MS),
      ]);
      const result = await appendMeetingCheckpointArtifacts(
        meeting,
        meeting.recordingCapture?.pending().map((item) => item.artifact) ?? [],
        signal,
      );
      handoff.coverage = result.coverage;
      handoff.preservation =
        result.kind === "committed" ? "confirmed" : "unconfirmed";
      return result.kind === "committed";
    })
    .catch(() => {
      handoff.preservation = "unconfirmed";
      return false;
    });
  if (reason === "storage_preservation")
    notifyCapturePreservationFailure(meeting);
  // Close's flush awaits `recordingPreservationTask`, within its bound, and records an interrupted capture.
  // Loaded on use: close imports the capture path, which imports this module.
  void import("./meetingClose").then(({ closeMeeting }) =>
    closeMeeting(meeting, {
      endReason: MEETING_END_REASONS.UNKNOWN,
      abnormal: true,
    }),
  );
}
