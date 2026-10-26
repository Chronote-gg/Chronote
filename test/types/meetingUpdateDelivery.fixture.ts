import type { MeetingHistory } from "../../src/types/db";
import {
  meetingUpdateDeliverySchema,
  meetingUpdateMutationSchema,
  preparedMeetingUpdateAttemptSchema,
} from "../../src/types/meetingUpdateDelivery";
export const now = 1792670400;
export const key = {
  guildId: "999999999999999990",
  channelId_timestamp: "999999999999999991#2026-10-22T12:00:00.000Z",
};
export const pointers = {
  notesChannelId: "999999999999999992",
  notesMessageIds: ["999999999999999993"],
};
export const history = (): MeetingHistory => ({
  ...key,
  meetingId: "synthetic-meeting",
  channelId: "999999999999999991",
  timestamp: "2026-10-22T12:00:00.000Z",
  notes: "Original synthetic notes",
  participants: [],
  duration: 60,
  transcribeMeeting: true,
  generateNotes: true,
});
export const notes = meetingUpdateMutationSchema.parse({
  kind: "notes",
  notes: "Edited synthetic notes",
});
export const rename = meetingUpdateMutationSchema.parse({
  kind: "rename",
  meetingName: "Synthetic planning",
});
export function parts() {
  return {
    notesBody: { desired: 0, acknowledged: 0 },
    notesTitle: { desired: 0, acknowledged: 0 },
    notesWarning: { desired: 0, acknowledged: 0 },
    summaryBody: { desired: 0, acknowledged: 0 },
    summaryTitle: { desired: 0, acknowledged: 0 },
    summaryWarning: { desired: 0, acknowledged: 0 },
  };
}
export function pending() {
  return meetingUpdateDeliverySchema.parse({
    revision: "delivery-1",
    policy: { kind: "active" },
    parts: {
      ...parts(),
      notesBody: { desired: 1, acknowledged: 0 },
    },
    progress: { kind: "pending", nextCheckAt: now },
  });
}
export function attempt() {
  return preparedMeetingUpdateAttemptSchema.parse({
    attemptId: "attempt-1",
    contentRevision: 1,
    capturedParts: { notesBody: 1 },
    expectedPointers: pointers,
    operations: [
      {
        kind: "patch",
        operationId: "patch-notes",
        channelId: pointers.notesChannelId,
        messageId: pointers.notesMessageIds[0],
        beforeFingerprint: "a".repeat(64),
        desiredFingerprint: "b".repeat(64),
      },
    ],
  });
}
export function running(submission: "submitted" | "verified" = "submitted") {
  return meetingUpdateDeliverySchema.parse({
    ...pending(),
    progress: {
      kind: "running",
      attempt: attempt(),
      claim: {
        ownerInstanceId: "synthetic-owner",
        leaseExpiresAt: now - 1,
      },
      nextCheckAt: now,
      operations: [
        {
          operationId: "patch-notes",
          submission:
            submission === "submitted"
              ? {
                  kind: "submitted",
                  submissionId: "submission-1",
                  submittedAt: now - 30,
                }
              : {
                  kind: "verified",
                  submissionId: "submission-1",
                  submittedAt: now - 30,
                  verifiedAt: now - 2,
                  fingerprint: "b".repeat(64),
                },
        },
      ],
    },
  });
}

export const submittedState = {
  kind: "submitted",
  submissionId: "synthetic-submission",
  submittedAt: now,
};
export const rejectedState = {
  ...submittedState,
  kind: "rejected",
  rejectedAt: now + 1,
  retryAt: now + 100,
  reason: "rate_limited",
};
export const verifiedState = (messageId?: string) => ({
  ...submittedState,
  kind: "verified",
  verifiedAt: now + 1,
  fingerprint: "b".repeat(64),
  receipt: messageId ? { kind: "message", messageId } : { kind: "none" },
});
export const patchOperation = (operationId: string) => ({
  ...attempt().operations[0],
  operationId,
});
export const postOperation = {
  kind: "post",
  operationId: "post-notes",
  channelId: pointers.notesChannelId,
  desiredFingerprint: "b".repeat(64),
};
export const registerOperation = (created = false) => ({
  kind: "register",
  operationId: "register-notes",
  expectedPointers: pointers,
  notesChannelId: pointers.notesChannelId,
  slots: [
    created
      ? { kind: "created", operationId: "post-notes" }
      : { kind: "existing", messageId: pointers.notesMessageIds[0] },
  ],
});
export const deleteOperation = {
  kind: "delete",
  operationId: "delete-notes",
  channelId: pointers.notesChannelId,
  messageId: pointers.notesMessageIds[0],
  beforeFingerprint: "b".repeat(64),
};
export function planDelivery(operations: unknown[], submissions: unknown[]) {
  const planned = preparedMeetingUpdateAttemptSchema.parse({
    ...attempt(),
    operations,
  });
  return meetingUpdateDeliverySchema.parse({
    ...pending(),
    progress: {
      kind: "running",
      attempt: planned,
      claim: { ownerInstanceId: "synthetic-owner", leaseExpiresAt: now + 200 },
      nextCheckAt: now,
      operations: planned.operations.map((op, index) => ({
        operationId: op.operationId,
        submission: submissions[index],
      })),
    },
  });
}
export function changedProgress(
  delivery: ReturnType<typeof planDelivery>,
  submissions: unknown[],
) {
  if (
    delivery.progress.kind !== "running" &&
    delivery.progress.kind !== "reconciling"
  )
    throw new Error("Expected attempt fixture");
  return {
    ...delivery.progress,
    operations: delivery.progress.operations.map((op, index) => ({
      operationId: op.operationId,
      submission: submissions[index],
    })),
  };
}

export function observedAttemptInput() {
  return {
    ...attempt(),
    operations: [],
    observations: [
      {
        channelId: pointers.notesChannelId,
        messageId: pointers.notesMessageIds[0],
        fingerprint: "b".repeat(64),
        observedAt: now,
      },
    ],
  };
}
