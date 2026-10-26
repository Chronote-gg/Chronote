import type { MeetingHistory } from "../types/db";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import type { MeetingData } from "../types/meeting-data";
import type { SessionReservation } from "../types/deploymentControl";
import type { CompletionPolicy } from "../types/meetingCompletionPolicy";
import { getDeploymentControlRepository } from "../db";
import { getMeetingProcessingSignal } from "./meetingProcessingLifetime";
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
function originalHistory(
  row: MeetingHistory | undefined,
  original: SessionReservation,
): row is MeetingHistory {
  return Boolean(
    row &&
    row.meetingId === original.meetingId &&
    row.ownerInstanceId === original.ownerInstanceId &&
    row.executionVersion === original.executionVersion,
  );
}
function matchesIntention(row: MeetingHistory, patch: Partial<MeetingHistory>) {
  return (
    isDeepStrictEqual(row.completionPolicy, patch.completionPolicy) &&
    (patch.status !== "cancelled" ||
      (row.status === patch.status &&
        row.endReason === patch.endReason &&
        row.cancellationReason === patch.cancellationReason))
  );
}
/** Durable intention is separate from notification ACK and resource settlement. */
export async function publishCompletionPolicy(
  meeting: CompletionInput &
    Pick<
      MeetingData,
      "reservation" | "ownershipSignal" | "finalization" | "cancellationReason"
    >,
  decision: CompletionPolicy["decision"] = "undecided",
) {
  const original = meeting.reservation;
  const snapshot = completionSnapshot(meeting);
  if (!original || original.sessionMode !== "meeting") return;
  if (!snapshot) throw new Error("Original completion policy is unavailable");
  const signal = getMeetingProcessingSignal(meeting);
  signal.throwIfAborted();
  const repository = getDeploymentControlRepository();
  const row = await repository.getMeetingHistory(original.historyKey, signal);
  if (!originalHistory(row, original) || !row.status)
    throw new Error("Completion intention lost original ownership");
  const completionPolicy = { ...snapshot, decision };
  const patch = {
    completionPolicy,
    ...(decision === "cancel"
      ? {
          status: "cancelled" as const,
          endReason: meeting.endReason,
          cancellationReason: meeting.cancellationReason,
        }
      : {}),
  };
  try {
    const result = await repository.transitionMeetingHistory({
      key: original.historyKey,
      expectedMeetingId: original.meetingId,
      expectedOwnerInstanceId: original.ownerInstanceId,
      expectedExecutionVersion: original.executionVersion,
      expectedStatus: row.status,
      expectedCheckpointRevision: row.checkpoint?.revision ?? 0,
      signal,
      completionPolicyProof: {
        kind: "completion_policy",
        ownership: original,
        now: Math.floor(Date.now() / 1000),
      },
      patch,
    });
    if (result !== "applied")
      throw new Error("Completion intention was fenced");
  } catch (error) {
    signal.throwIfAborted();
    const current = await repository.getMeetingHistory(
      original.historyKey,
      signal,
    );
    if (
      !originalHistory(current, original) ||
      !matchesIntention(current, patch)
    )
      throw error;
  }
  signal.throwIfAborted();
}
