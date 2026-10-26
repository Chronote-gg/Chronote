import {
  planDelivery,
  registerOperation,
  deleteOperation,
  pointers,
  verifiedState,
  now,
} from "./meetingUpdateDelivery.fixture";

export function sequentialCleanupPlan() {
  const obsolete = ["999999999999999994", "999999999999999995"].map(
    (messageId, index) => ({
      ...deleteOperation,
      operationId: "delete-" + index,
      messageId,
    }),
  );
  const register = {
    ...registerOperation(),
    expectedPointers: {
      ...pointers,
      notesMessageIds: [
        ...pointers.notesMessageIds,
        ...obsolete.map((op) => op.messageId),
      ],
    },
  };
  return planDelivery(
    [register, ...obsolete],
    [verifiedState(), { kind: "prepared" }, { kind: "prepared" }],
  );
}
export function advanceCleanup(
  before: ReturnType<typeof sequentialCleanupPlan>,
  index: number,
  verified: boolean,
) {
  if (!("attempt" in before.progress))
    throw new Error("Expected retained attempt");
  const submission = verified
    ? {
        ...verifiedState(),
        submissionId: "cleanup-" + index,
        submittedAt: now,
        verifiedAt: now + 1,
      }
    : { kind: "submitted", submissionId: "cleanup-" + index, submittedAt: now };
  return {
    kind: "progress",
    revision: crypto.randomUUID(),
    progress: {
      ...before.progress,
      operations: before.progress.operations.map((op, i) =>
        i === index ? { ...op, submission } : op,
      ),
    },
  };
}
