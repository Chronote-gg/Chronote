import type { MeetingData } from "../types/meeting-data";

export function assertMeetingFinalizationActive(meeting: MeetingData): void {
  if (meeting.finalizationFenced)
    throw new Error("Meeting finalization fenced");
  meeting.ownershipSignal?.throwIfAborted();
  meeting.finalization?.controller.signal.throwIfAborted();
}

/** Recording and TTS retain one promise and one transitionable reservation handle. */
export function runOwnedMeetingFinalization(
  meeting: MeetingData,
  run: () => Promise<void>,
): Promise<void> {
  if (meeting.finalization) return meeting.finalization.promise;
  if (meeting.finished) return Promise.resolve();
  if (meeting.finalizationFenced)
    return Promise.reject(new Error("Meeting finalization fenced"));
  const controller = new AbortController();
  const promise = Promise.resolve().then(run);
  meeting.finalization = { promise, controller, disposition: "pending" };
  meeting.reservation?.workHandle.transition("finalization");
  return promise;
}
