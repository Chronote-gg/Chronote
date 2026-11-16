import { getMeetingHistoryTransitionRepository } from "../repositories/meetingHistoryTransitions";
import type { MeetingData } from "../types/meeting-data";
import { MEETING_STATUS, type MeetingStatus } from "../types/meetingLifecycle";
import { LIFECYCLE } from "./lifecycleTiming";

/** A replacement posted at the stop lands while close may already have moved the row on. */
const STOPPED_MEETING_STATUSES: readonly MeetingStatus[] = [
  MEETING_STATUS.IN_PROGRESS,
  MEETING_STATUS.PROCESSING,
];

/**
 * Saves the recording message id to the row, so whichever worker finishes the
 * meeting edits that message. Tried at each expected status in turn, because a
 * transition names one; never touches the status, the finish claim or the
 * content revision. Best effort: a failure is a warning.
 */
export async function saveStartMessageId(
  meeting: MeetingData,
  messageId: string,
  statuses: readonly MeetingStatus[] = [MEETING_STATUS.IN_PROGRESS],
): Promise<void> {
  const reservation = meeting.reservation;
  if (reservation?.sessionMode !== "meeting") return;
  try {
    const repository = getMeetingHistoryTransitionRepository();
    for (const expectedStatus of statuses) {
      const outcome = await repository.transitionMeetingHistory({
        key: reservation.historyKey,
        expectedMeetingId: reservation.meetingId,
        expectedOwnerInstanceId: reservation.ownerInstanceId,
        expectedExecutionVersion: reservation.executionVersion,
        expectedStatus,
        patch: {
          startMessageId: messageId,
          updatedAt: new Date().toISOString(),
        },
        signal: AbortSignal.timeout(LIFECYCLE.leaseHeartbeatMs),
      });
      if (outcome === "applied") return;
    }
    console.warn("Meeting start message id was not saved", {
      meetingId: meeting.meetingId,
    });
  } catch (error) {
    console.warn("Meeting start message id could not be saved", {
      meetingId: meeting.meetingId,
      error,
    });
  }
}

/** The replacement the stop's processing update posted when the recording message was gone. */
export const saveReplacementStartMessageId = (
  meeting: MeetingData,
  messageId: string,
) => saveStartMessageId(meeting, messageId, STOPPED_MEETING_STATUSES);
