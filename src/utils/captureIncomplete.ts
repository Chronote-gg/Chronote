import type { MeetingData } from "../types/meeting-data";

export const CAPTURE_INCOMPLETE_LOG = "Meeting capture marked incomplete";

/** Flags lost capture audio, logging the reason the first time the flag is set. */
export function markCaptureIncomplete(
  meeting: Pick<MeetingData, "meetingId" | "audioData">,
  reason: string,
): void {
  if (meeting.audioData.captureIncomplete) return;
  meeting.audioData.captureIncomplete = true;
  console.warn(CAPTURE_INCOMPLETE_LOG, {
    meetingId: meeting.meetingId,
    reason,
  });
}
