import { performance } from "node:perf_hooks";
import type { MeetingData } from "../types/meeting-data";
import type { SessionReservation } from "../types/meetingHistoryTransition";
import type { CompletionPolicy } from "../types/meetingCompletionPolicy";
import { config } from "./configService";

type CompletionInput = Pick<
  MeetingData,
  "isAutoRecording" | "chatLog" | "endReason"
> & {
  reservation?: Pick<SessionReservation, "reservedAt" | "timingReceipt">;
  runtimeConfig?: { autoRecordCancellation: { enabled: boolean } };
};
const policies = new WeakMap<object, CompletionPolicy["policy"]>();
const stoppedDurations = new WeakMap<object, number>();
export function reservationTimingReceipt(
  reservedAt: number,
  observedAt = Date.now(),
) {
  return reservedAt === observedAt
    ? { reservedAt, monotonicMilliseconds: performance.now() }
    : undefined;
}
export function freezeCompletionPolicy(meeting: CompletionInput) {
  if (!policies.has(meeting)) {
    if (!meeting.runtimeConfig)
      throw new Error("Original completion settings are unavailable");
    policies.set(meeting, {
      enabled:
        !config.mock.enabled &&
        meeting.runtimeConfig.autoRecordCancellation.enabled !== false,
      maximumSeconds: 90,
      maximumWords: 50,
      maximumChatMessages: 1,
      dismissedMinimumMilliseconds: 10 * 60 * 1000,
      dismissedMinimumChatMessages: 2,
    });
  }
  return policies.get(meeting)!;
}
export function stopCompletionClock(
  meeting: Pick<CompletionInput, "reservation">,
) {
  const original = meeting.reservation;
  if (
    !original ||
    stoppedDurations.has(original) ||
    !original.timingReceipt ||
    original.timingReceipt.reservedAt !== original.reservedAt
  )
    return;
  const elapsed =
    performance.now() - original.timingReceipt.monotonicMilliseconds;
  if (elapsed >= 0 && Number.isFinite(elapsed))
    stoppedDurations.set(original, elapsed);
}
export function completionSnapshot(
  meeting: CompletionInput,
): CompletionPolicy | undefined {
  const policy = policies.get(meeting);
  if (!policy) return undefined;
  return {
    policy,
    isAutoRecording: meeting.isAutoRecording,
    elapsedMilliseconds: meeting.reservation
      ? stoppedDurations.get(meeting.reservation)
      : undefined,
    chatMessageCount: meeting.chatLog.filter((row) => row.type === "message")
      .length,
    dismissed: meeting.endReason === "dismissed",
    decision: "undecided",
  };
}
export function resolveCompletionPolicy(
  snapshot: CompletionPolicy | undefined,
  interrupted: boolean,
): "proceed" | "cancel" | "unknown" {
  if (snapshot?.decision === "cancel") return "cancel";
  if (interrupted) return "proceed";
  if (!snapshot) return "unknown";
  if (snapshot.decision !== "undecided") return snapshot.decision;
  if (!snapshot.isAutoRecording) return "proceed";
  if (snapshot.dismissed) {
    if (
      snapshot.chatMessageCount >= snapshot.policy.dismissedMinimumChatMessages
    )
      return "proceed";
    if (snapshot.elapsedMilliseconds === undefined) return "unknown";
    return snapshot.elapsedMilliseconds >=
      snapshot.policy.dismissedMinimumMilliseconds
      ? "proceed"
      : "cancel";
  }
  if (
    !snapshot.policy.enabled ||
    snapshot.chatMessageCount > snapshot.policy.maximumChatMessages
  )
    return "proceed";
  if (
    snapshot.elapsedMilliseconds !== undefined &&
    Math.floor(snapshot.elapsedMilliseconds / 1000) >
      snapshot.policy.maximumSeconds
  )
    return "proceed";
  return "unknown";
}
