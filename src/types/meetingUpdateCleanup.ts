import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type {
  MeetingUpdateDelivery,
  MeetingUpdateProgress,
} from "./meetingUpdateDelivery";

const id = z.string().min(1).max(512);
export const meetingUpdateCleanupCandidateSchema = z
  .object({
    sourceAttemptId: id,
    operationId: id,
    registrationOperationId: id,
    channelId: id,
    messageId: id,
    beforeFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type MeetingUpdateCleanupCandidate = z.infer<
  typeof meetingUpdateCleanupCandidateSchema
>;
export const MAX_MEETING_UPDATE_CLEANUP_CANDIDATES = 300;

export function knownCleanupCandidates(
  progress: MeetingUpdateProgress,
  includePreparedRegistration = false,
): MeetingUpdateCleanupCandidate[] {
  if (!("attempt" in progress)) return [];
  return progress.attempt.operations.flatMap((operation, index) => {
    if (
      operation.kind !== "delete" ||
      progress.operations[index]?.submission.kind === "verified"
    )
      return [];
    const registration = progress.attempt.operations
      .slice(0, index)
      .find(
        (register, registerIndex) =>
          register.kind === "register" &&
          (includePreparedRegistration ||
            progress.operations[registerIndex]?.submission.kind ===
              "verified") &&
          register.expectedPointers.notesChannelId === operation.channelId &&
          register.expectedPointers.notesMessageIds.includes(
            operation.messageId,
          ) &&
          !register.slots.some(
            (slot) =>
              slot.kind === "existing" &&
              slot.messageId === operation.messageId,
          ),
      );
    if (!registration) return [];
    return [
      {
        sourceAttemptId: progress.attempt.attemptId,
        operationId: operation.operationId,
        registrationOperationId: registration.operationId,
        channelId: operation.channelId,
        messageId: operation.messageId,
        beforeFingerprint: operation.beforeFingerprint,
      },
    ];
  });
}

export function cleanupCandidateDisposed(
  candidate: MeetingUpdateCleanupCandidate,
  progress: MeetingUpdateProgress,
): boolean {
  if (!("attempt" in progress)) return false;
  const attempt = progress.attempt;
  return attempt.operations.some((operation, index) => {
    if (progress.operations[index].submission.kind !== "verified") return false;
    if (operation.kind === "delete")
      return (
        operation.channelId === candidate.channelId &&
        operation.messageId === candidate.messageId &&
        operation.beforeFingerprint === candidate.beforeFingerprint
      );
    if (
      operation.kind !== "register" ||
      operation.notesChannelId !== candidate.channelId ||
      !operation.slots.some(
        (slot) =>
          slot.kind === "existing" && slot.messageId === candidate.messageId,
      )
    )
      return false;
    return (
      attempt.observations.some(
        (observation) =>
          observation.channelId === candidate.channelId &&
          observation.messageId === candidate.messageId &&
          observation.fingerprint === candidate.beforeFingerprint,
      ) ||
      attempt.operations
        .slice(0, index)
        .some(
          (patch) =>
            patch.kind === "patch" &&
            patch.channelId === candidate.channelId &&
            patch.messageId === candidate.messageId &&
            patch.beforeFingerprint === candidate.beforeFingerprint,
        )
    );
  });
}

export function retainCleanupCandidates(
  before: MeetingUpdateDelivery,
): MeetingUpdateCleanupCandidate[] {
  const candidates = [
    ...before.cleanupCandidates,
    ...knownCleanupCandidates(before.progress),
  ];
  return candidates.filter(
    (candidate, index) =>
      !cleanupCandidateDisposed(candidate, before.progress) &&
      candidates.findIndex((other) => isDeepStrictEqual(candidate, other)) ===
        index,
  );
}

export function assertCleanupCandidates(
  before: MeetingUpdateDelivery,
  after: MeetingUpdateDelivery,
): void {
  const required = retainCleanupCandidates(before);
  const retained = [
    ...after.cleanupCandidates,
    ...knownCleanupCandidates(after.progress),
  ];
  if (
    required.some(
      (candidate) =>
        !cleanupCandidateDisposed(candidate, after.progress) &&
        !retained.some((next) => isDeepStrictEqual(candidate, next)),
    )
  )
    throw new Error(
      "Obsolete target identity must survive until exact verified adoption or cleanup",
    );
  const admitted = [
    ...before.cleanupCandidates,
    ...knownCleanupCandidates(before.progress),
  ];
  if (
    after.cleanupCandidates.some(
      (candidate) =>
        !admitted.some((previous) => isDeepStrictEqual(candidate, previous)),
    )
  )
    throw new Error(
      "Cleanup identities require verified shorter registration provenance",
    );
}

export function cleanupCapacityExceeded(
  delivery: MeetingUpdateDelivery,
): boolean {
  const candidates = [
    ...delivery.cleanupCandidates,
    ...knownCleanupCandidates(delivery.progress, true),
  ];
  return (
    candidates.filter(
      (candidate, index) =>
        candidates.findIndex((other) => isDeepStrictEqual(candidate, other)) ===
        index,
    ).length > MAX_MEETING_UPDATE_CLEANUP_CANDIDATES
  );
}
