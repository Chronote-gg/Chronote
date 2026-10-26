import type { MeetingData } from "../types/meeting-data";
import type { SessionOwnership } from "../types/deploymentControl";
import { getMeetingInterruptionCheckpoints } from "./ownedMeetingInterruption";

export class InitiatingStopInterruption extends Error {
  constructor(
    readonly original: SessionOwnership,
    readonly signal: AbortSignal,
    readonly deadline: number,
    cause: unknown,
  ) {
    super("Meeting finalization interrupted; preservation remains owned", {
      cause,
    });
  }
}
export function sameOriginalSession(
  left: SessionOwnership,
  right: SessionOwnership,
): boolean {
  return (
    left.guildId === right.guildId &&
    left.meetingId === right.meetingId &&
    left.ownerInstanceId === right.ownerInstanceId &&
    left.executionVersion === right.executionVersion &&
    left.voiceOperationAttemptId === right.voiceOperationAttemptId
  );
}
export function initiatingStopInterruption(
  meeting: MeetingData,
  original: SessionOwnership | undefined,
  cause: unknown,
): unknown {
  if (!original) return cause;
  const owned = getMeetingInterruptionCheckpoints().find(
    (entry) => entry.meeting === meeting,
  );
  if (
    !owned?.originalAttempt ||
    !sameOriginalSession(owned.originalAttempt, original) ||
    owned.signal.aborted ||
    Date.now() >= owned.deadline
  )
    return cause;
  return new InitiatingStopInterruption(
    original,
    owned.signal,
    owned.deadline,
    cause,
  );
}
