import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { MeetingHistory } from "./db";
import {
  meetingUpdateCleanupCandidateSchema,
  MAX_MEETING_UPDATE_CLEANUP_CANDIDATES,
  assertCleanupCandidates,
  cleanupCapacityExceeded,
} from "./meetingUpdateCleanup";

export const MEETING_UPDATE_DELIVERY_QUEUE = "meeting-update:v1";
export const MEETING_UPDATE_DELIVERY_DUE_INDEX = "UpdateDeliveryDueIndex";
const id = z.string().min(1).max(512);
const seconds = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const revisionNumber = seconds;
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);

export type MeetingUpdateKey = Pick<
  MeetingHistory,
  "guildId" | "channelId_timestamp"
>;
export const presentationPartSchema = z.enum([
  "notesBody",
  "notesTitle",
  "notesWarning",
  "summaryBody",
  "summaryTitle",
  "summaryWarning",
]);
export type PresentationPart = z.infer<typeof presentationPartSchema>;
const watermarkSchema = z
  .object({ desired: revisionNumber, acknowledged: revisionNumber })
  .strict()
  .refine((part) => part.acknowledged <= part.desired);
export const partWatermarksSchema = z.record(
  presentationPartSchema,
  watermarkSchema,
);
export type PartWatermarks = z.infer<typeof partWatermarksSchema>;

export const notesPointersSchema = z
  .object({
    notesChannelId: id.nullable(),
    notesMessageIds: z.array(id).max(100),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.notesMessageIds).size === value.notesMessageIds.length &&
      (value.notesChannelId !== null || value.notesMessageIds.length === 0),
  );
export type NotesPointers = z.infer<typeof notesPointersSchema>;

const notesMutation = z
  .object({
    kind: z.literal("notes"),
    notes: z.string(),
    notesDelta: z.unknown().optional(),
  })
  .strict();
const renameMutation = z
  .object({ kind: z.literal("rename"), meetingName: z.string().min(1) })
  .strict();
const contentChange = z.discriminatedUnion("kind", [
  notesMutation,
  renameMutation,
  z.object({ kind: z.literal("summarySentence"), value: z.string() }).strict(),
  z.object({ kind: z.literal("summaryLabel"), value: z.string() }).strict(),
]);
export const meetingUpdateMutationSchema = z.discriminatedUnion("kind", [
  notesMutation,
  renameMutation,
  z
    .object({
      kind: z.literal("correction"),
      changes: z
        .array(contentChange)
        .min(1)
        .max(4)
        .refine(
          (changes) =>
            new Set(changes.map((c) => c.kind)).size === changes.length,
        ),
    })
    .strict(),
  z
    .object({
      kind: z.literal("warning"),
      target: z.enum(["notes", "summary", "both"]),
    })
    .strict(),
]);
export type MeetingUpdateMutation = z.infer<typeof meetingUpdateMutationSchema>;

export function requestedPartsForMutation(
  mutation: MeetingUpdateMutation,
  history?: Pick<MeetingHistory, "meetingName" | "summaryLabel">,
): PresentationPart[] {
  const parsed = meetingUpdateMutationSchema.parse(mutation);
  switch (parsed.kind) {
    case "notes":
      return ["notesBody"];
    case "rename":
      return ["notesTitle", "summaryTitle"];
    case "warning":
      return parsed.target === "both"
        ? ["notesWarning", "summaryWarning"]
        : parsed.target === "notes"
          ? ["notesWarning"]
          : ["summaryWarning"];
    case "correction":
      return presentationPartSchema.options.filter((part) =>
        parsed.changes.some(
          (change) =>
            partsForContentChange(change).includes(part) ||
            (part === "summaryTitle" &&
              change.kind === "summaryLabel" &&
              history !== undefined &&
              !history.meetingName?.trim() &&
              (history.summaryLabel?.trim() || "Meeting Summary") !==
                (change.value.trim() || "Meeting Summary")),
        ),
      );
    default: {
      const exhaustive: never = parsed;
      return exhaustive;
    }
  }
}

function partsForContentChange(
  change: z.infer<typeof contentChange>,
): PresentationPart[] {
  if (change.kind === "summarySentence" || change.kind === "summaryLabel")
    return ["summaryBody"];
  return requestedPartsForMutation(change);
}

const operationBase = z.object({ operationId: id });
const messageTarget = operationBase.extend({ channelId: id, messageId: id });
const slot = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("existing"), messageId: id }).strict(),
  z.object({ kind: z.literal("created"), operationId: id }).strict(),
]);
export const meetingUpdateProviderOperationSchema = z.discriminatedUnion(
  "kind",
  [
    messageTarget
      .extend({
        kind: z.literal("patch"),
        beforeFingerprint: fingerprint,
        desiredFingerprint: fingerprint,
      })
      .strict(),
    operationBase
      .extend({
        kind: z.literal("post"),
        channelId: id,
        desiredFingerprint: fingerprint,
      })
      .strict(),
    operationBase
      .extend({
        kind: z.literal("register"),
        expectedPointers: notesPointersSchema,
        notesChannelId: id,
        slots: z.array(slot).min(1).max(100),
      })
      .strict(),
    messageTarget
      .extend({ kind: z.literal("delete"), beforeFingerprint: fingerprint })
      .strict(),
  ],
);
export type MeetingUpdateProviderOperation = z.infer<
  typeof meetingUpdateProviderOperationSchema
>;
export const preparedMeetingUpdateAttemptSchema = z
  .object({
    attemptId: id,
    contentRevision: revisionNumber.positive(),
    capturedParts: z
      .partialRecord(presentationPartSchema, revisionNumber.positive())
      .refine((parts) => Object.keys(parts).length > 0),
    expectedPointers: notesPointersSchema,
    operations: z.array(meetingUpdateProviderOperationSchema).max(300),
    observations: z
      .array(
        z
          .object({
            channelId: id,
            messageId: id,
            fingerprint,
            observedAt: seconds,
          })
          .strict(),
      )
      .max(400)
      .default([]),
  })
  .strict()
  .superRefine((attempt, context) => {
    if (attempt.operations.length === 0 && attempt.observations.length === 0)
      context.addIssue({
        code: "custom",
        message: "A no-mutation attempt requires exact target observations",
      });
    if (
      new Set(
        attempt.observations.map(
          (target) => target.channelId + "/" + target.messageId,
        ),
      ).size !== attempt.observations.length
    )
      context.addIssue({
        code: "custom",
        message: "Observation identities must be unique",
      });
    if (
      Object.values(attempt.capturedParts).some(
        (revision) => revision > attempt.contentRevision,
      ) ||
      new Set(attempt.operations.map((op) => op.operationId)).size !==
        attempt.operations.length
    )
      context.addIssue({
        code: "custom",
        message: "Invalid attempt revisions or operation identity",
      });
    for (const [index, operation] of attempt.operations.entries()) {
      if (
        operation.kind === "register" &&
        operation.slots.some(
          (entry) =>
            entry.kind === "created" &&
            !attempt.operations
              .slice(0, index)
              .some(
                (op) =>
                  op.kind === "post" && op.operationId === entry.operationId,
              ),
        )
      )
        context.addIssue({
          code: "custom",
          message: "Registered slots require their recorded POST",
        });
    }
  });
export type PreparedMeetingUpdateAttempt = z.infer<
  typeof preparedMeetingUpdateAttemptSchema
>;

const submittedFields = z.object({ submissionId: id, submittedAt: seconds });
const receipt = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z.object({ kind: z.literal("message"), messageId: id }).strict(),
]);
export const meetingUpdateSubmissionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("prepared") }).strict(),
  submittedFields.extend({ kind: z.literal("submitted") }).strict(),
  submittedFields
    .extend({
      kind: z.literal("returned"),
      messageId: id,
      returnedAt: seconds,
    })
    .strict(),
  submittedFields
    .extend({
      kind: z.literal("verified"),
      verifiedAt: seconds,
      fingerprint,
      receipt: receipt.default({ kind: "none" }),
    })
    .strict(),
  submittedFields
    .extend({
      kind: z.literal("rejected"),
      rejectedAt: seconds,
      retryAt: seconds,
      reason: z.enum(["rate_limited", "provider_rejected", "not_submitted"]),
    })
    .strict(),
  submittedFields
    .extend({
      kind: z.literal("uncertain"),
      reason: z.enum(["provider_outcome_unknown", "completion_unknown"]),
    })
    .strict(),
]);
export type MeetingUpdateSubmission = z.infer<
  typeof meetingUpdateSubmissionSchema
>;
const operationProgress = z
  .object({
    operationId: id,
    submission: meetingUpdateSubmissionSchema,
  })
  .strict();
const attemptProgress = z.object({
  attempt: preparedMeetingUpdateAttemptSchema,
  claim: z.object({ ownerInstanceId: id, leaseExpiresAt: seconds }).strict(),
  nextCheckAt: seconds,
  operations: z.array(operationProgress).max(300),
});
const pendingProgress = z
  .object({ kind: z.literal("pending"), nextCheckAt: seconds })
  .strict();
const reason = z.enum([
  "missing_target",
  "inaccessible_destination",
  "unsupported_layout",
  "initial_publication_unsettled",
  "legacy_publication_unknown",
  "provider_outcome_unknown",
  "retry_exhausted",
]);
export const meetingUpdateProgressSchema = z.discriminatedUnion("kind", [
  pendingProgress,
  z
    .object({
      kind: z.literal("retrying"),
      nextCheckAt: seconds,
      reason: z.enum(["rate_limited", "provider_rejected", "not_submitted"]),
    })
    .strict(),
  attemptProgress.extend({ kind: z.literal("running") }).strict(),
  attemptProgress.extend({ kind: z.literal("reconciling") }).strict(),
  attemptProgress
    .omit({ nextCheckAt: true })
    .extend({
      kind: z.literal("uncertain"),
      reason: z.literal("provider_outcome_unknown"),
    })
    .strict(),
  z.object({ kind: z.literal("synced"), syncedAt: seconds }).strict(),
  z.object({ kind: z.literal("blocked"), reason }).strict(),
]);
export type MeetingUpdateProgress = z.infer<typeof meetingUpdateProgressSchema>;
type AttemptProgress = Extract<
  MeetingUpdateProgress,
  { kind: "running" | "reconciling" | "uncertain" }
>;
export const meetingUpdatePolicySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("active") }).strict(),
  z.object({ kind: z.literal("unpublished") }).strict(),
  z
    .object({
      kind: z.literal("held"),
      reason: z.enum([
        "stored_only",
        "explicit_hold",
        "initial_publication_unsettled",
        "legacy_publication_unknown",
      ]),
    })
    .strict(),
]);
export const meetingUpdateCreatedCandidateSchema = z
  .object({
    operationId: id,
    channelId: id,
    messageId: id,
    fingerprint,
  })
  .strict();
export type MeetingUpdateCreatedCandidate = z.infer<
  typeof meetingUpdateCreatedCandidateSchema
>;
export const meetingUpdateLastSuccessSchema = z
  .object({ at: seconds, contentRevision: revisionNumber.positive() })
  .strict();
export type MeetingUpdateLastSuccess = z.infer<
  typeof meetingUpdateLastSuccessSchema
>;
export const meetingUpdateDeliverySchema = z
  .object({
    revision: id,
    policy: meetingUpdatePolicySchema,
    attempts: revisionNumber.default(0),
    lastSuccess: meetingUpdateLastSuccessSchema.nullable().default(null),
    createdCandidates: z
      .array(meetingUpdateCreatedCandidateSchema)
      .max(300)
      .default([]),
    cleanupCandidates: z
      .array(meetingUpdateCleanupCandidateSchema)
      .max(MAX_MEETING_UPDATE_CLEANUP_CANDIDATES)
      .default([]),
    parts: partWatermarksSchema,
    progress: meetingUpdateProgressSchema,
  })
  .strict()
  .superRefine((delivery, context) => {
    if (
      delivery.progress.kind === "synced" &&
      presentationPartSchema.options.some(
        (part) =>
          delivery.parts[part].desired !== delivery.parts[part].acknowledged,
      )
    )
      context.addIssue({
        code: "custom",
        message: "Synced delivery has pending parts",
      });
    if (
      delivery.progress.kind === "synced" &&
      (delivery.createdCandidates.length || delivery.cleanupCandidates.length)
    )
      context.addIssue({
        code: "custom",
        message: "Synced delivery cannot retain undisposed targets",
      });
    if (delivery.progress.kind === "retrying" && delivery.attempts === 0)
      context.addIssue({
        code: "custom",
        message: "Retrying requires retained failure history",
      });
    if (
      delivery.progress.kind === "synced" &&
      delivery.lastSuccess &&
      delivery.progress.syncedAt !== delivery.lastSuccess.at
    )
      context.addIssue({
        code: "custom",
        message: "Synced time must match verified last success",
      });
    if (hasAttempt(delivery.progress))
      validateAttemptProgress(delivery.progress, delivery.parts, context);
    if (cleanupCapacityExceeded(delivery))
      context.addIssue({
        code: "custom",
        message:
          "Cleanup candidate capacity must be reserved before registration",
      });
  });
export type MeetingUpdateDelivery = z.infer<typeof meetingUpdateDeliverySchema>;

function hasAttempt(
  progress: MeetingUpdateProgress,
): progress is AttemptProgress {
  return (
    progress.kind === "running" ||
    progress.kind === "reconciling" ||
    progress.kind === "uncertain"
  );
}
function validateAttemptProgress(
  progress: AttemptProgress,
  parts: PartWatermarks,
  context: z.RefinementCtx,
): void {
  const plan = progress.attempt;
  validateOperationOrder(progress.operations, context);
  if (
    progress.operations.length !== plan.operations.length ||
    progress.operations.some(
      (op, index) => op.operationId !== plan.operations[index].operationId,
    ) ||
    Object.entries(plan.capturedParts).some(
      ([part, captured]) =>
        captured > parts[presentationPartSchema.parse(part)].desired,
    )
  )
    context.addIssue({
      code: "custom",
      message: "Progress must match the captured plan",
    });
  for (const [index, operation] of plan.operations.entries())
    validateOperationReceipt(
      operation,
      progress.operations[index]?.submission,
      context,
    );
}
function validateOperationOrder(
  operations: AttemptProgress["operations"],
  context: z.RefinementCtx,
): void {
  const first = operations.findIndex((op) => op.submission.kind !== "verified");
  if (
    first !== -1 &&
    operations.slice(first + 1).some((op) => op.submission.kind !== "prepared")
  )
    context.addIssue({
      code: "custom",
      message: "Operations require a verified predecessor prefix",
    });
}
function validateOperationReceipt(
  operation: MeetingUpdateProviderOperation,
  submission: MeetingUpdateSubmission | undefined,
  context: z.RefinementCtx,
): void {
  if (!submission) return;
  if (submission.kind === "returned" && operation.kind !== "post")
    context.addIssue({
      code: "custom",
      message: "Only POST returns a new message identity",
    });
  if (submission.kind !== "verified") return;
  const expected =
    operation.kind === "patch" || operation.kind === "post"
      ? operation.desiredFingerprint
      : operation.kind === "delete"
        ? operation.beforeFingerprint
        : undefined;
  if (
    (expected !== undefined && submission.fingerprint !== expected) ||
    (operation.kind === "post" && submission.receipt.kind !== "message") ||
    (operation.kind !== "post" && submission.receipt.kind !== "none")
  )
    context.addIssue({
      code: "custom",
      message: "Verification must match the recorded operation",
    });
}

const revisionsSchema = z
  .object({
    contentRevision: revisionNumber.default(0),
    notesVersion: revisionNumber.positive().default(1),
  })
  .strict();
export function readMeetingUpdateRevisions(
  history: Pick<MeetingHistory, "contentRevision" | "notesVersion">,
) {
  return revisionsSchema.parse({
    contentRevision: history.contentRevision,
    notesVersion: history.notesVersion,
  });
}
export function requestMeetingUpdateDelivery(input: {
  history: Pick<
    MeetingHistory,
    | "contentRevision"
    | "notesVersion"
    | "updateDelivery"
    | "meetingName"
    | "summaryLabel"
  >;
  mutation: MeetingUpdateMutation;
  revision: string;
  now: number;
  policy: z.infer<typeof meetingUpdatePolicySchema>;
}): MeetingUpdateDelivery {
  const previous = input.history.updateDelivery
    ? meetingUpdateDeliverySchema.parse(input.history.updateDelivery)
    : undefined;
  const contentRevision = revisionNumber.parse(
    readMeetingUpdateRevisions(input.history).contentRevision + 1,
  );
  const parts: PartWatermarks = previous
    ? structuredClone(previous.parts)
    : partWatermarksSchema.parse(
        Object.fromEntries(
          presentationPartSchema.options.map((part) => [
            part,
            { desired: 0, acknowledged: 0 },
          ]),
        ),
      );
  for (const part of requestedPartsForMutation(input.mutation, input.history))
    parts[part].desired = contentRevision;
  const next = meetingUpdateDeliverySchema.parse({
    revision: input.revision,
    policy: previous?.policy ?? input.policy,
    parts,
    createdCandidates: previous?.createdCandidates,
    cleanupCandidates: previous?.cleanupCandidates,
    lastSuccess: previous?.lastSuccess,
    attempts: previous && hasAttempt(previous.progress) ? previous.attempts : 0,
    progress: requestedProgress(previous?.progress, input.now),
  });
  if (previous) assertMeetingUpdateDeliveryTransition(previous, next);
  return next;
}

function requestedProgress(
  previous: MeetingUpdateProgress | undefined,
  now: number,
): MeetingUpdateProgress {
  if (!previous || previous.kind === "synced")
    return { kind: "pending", nextCheckAt: seconds.parse(now) };
  if (previous.kind === "retrying")
    return { kind: "pending", nextCheckAt: previous.nextCheckAt };
  return previous;
}

export function meetingUpdateDeliveryNextCheck(
  delivery: MeetingUpdateDelivery,
): number | undefined {
  const parsed = meetingUpdateDeliverySchema.parse(delivery);
  return parsed.policy.kind === "active" && "nextCheckAt" in parsed.progress
    ? parsed.progress.nextCheckAt
    : undefined;
}

export function assertMeetingUpdateDeliveryTransition(
  before: MeetingUpdateDelivery,
  after: MeetingUpdateDelivery,
): void {
  before = meetingUpdateDeliverySchema.parse(before);
  after = meetingUpdateDeliverySchema.parse(after);
  if (before.revision === after.revision)
    throw new Error("Delivery transitions require a fresh revision");
  assertWatermarks(before, after);
  assertCreatedCandidates(before, after);
  assertCleanupCandidates(before, after);
  assertSubmissionAdmission(before, after);
  assertRetryHistory(before, after);
  assertLastSuccess(before, after);
  if (hasAttempt(before.progress))
    assertAttemptTransition(before.progress, after.progress);
}
function assertWatermarks(
  before: MeetingUpdateDelivery,
  after: MeetingUpdateDelivery,
): void {
  const completing = hasAttempt(before.progress) && !hasAttempt(after.progress);
  for (const part of presentationPartSchema.options) {
    const previous = before.parts[part];
    const next = after.parts[part];
    if (
      next.desired < previous.desired ||
      next.acknowledged < previous.acknowledged
    )
      throw new Error("Part revisions cannot regress");
    if (next.acknowledged === previous.acknowledged) continue;
    if (
      !completing ||
      !hasAttempt(before.progress) ||
      !before.progress.operations.every(
        (op) => op.submission.kind === "verified",
      ) ||
      next.acknowledged !==
        Math.max(
          previous.acknowledged,
          before.progress.attempt.capturedParts[part] ?? 0,
        )
    )
      throw new Error("Only verified captured parts may be acknowledged");
  }
}
export function knownCreatedCandidates(
  progress: MeetingUpdateProgress,
): MeetingUpdateCreatedCandidate[] {
  if (!hasAttempt(progress)) return [];
  return progress.operations.flatMap((operation, index) => {
    const plan = progress.attempt.operations[index];
    const result = operation.submission;
    if (plan.kind !== "post") return [];
    const messageId =
      result.kind === "returned"
        ? result.messageId
        : result.kind === "verified" && result.receipt.kind === "message"
          ? result.receipt.messageId
          : undefined;
    return messageId
      ? [
          {
            operationId: operation.operationId,
            channelId: plan.channelId,
            messageId,
            fingerprint: plan.desiredFingerprint,
          },
        ]
      : [];
  });
}
export function candidateRegisteredOrDeleted(
  candidate: MeetingUpdateCreatedCandidate,
  progress: MeetingUpdateProgress,
): boolean {
  if (!hasAttempt(progress)) return false;
  return progress.attempt.operations.some((plan, index) => {
    if (progress.operations[index].submission.kind !== "verified") return false;
    if (plan.kind === "delete")
      return (
        plan.messageId === candidate.messageId &&
        plan.channelId === candidate.channelId
      );
    if (plan.kind !== "register" || plan.notesChannelId !== candidate.channelId)
      return false;
    return plan.slots.some((slot) =>
      slot.kind === "existing"
        ? slot.messageId === candidate.messageId
        : createdSlotMessage(
            slot.operationId,
            candidate.channelId,
            progress,
          ) === candidate.messageId,
    );
  });
}
function createdSlotMessage(
  operationId: string,
  channelId: string,
  progress: AttemptProgress,
): string | undefined {
  const index = progress.attempt.operations.findIndex(
    (op) => op.operationId === operationId,
  );
  const operation = progress.attempt.operations[index];
  const result = progress.operations[index]?.submission;
  if (operation?.kind !== "post" || operation.channelId !== channelId)
    return undefined;
  if (result?.kind === "returned") return result.messageId;
  return result?.kind === "verified" && result.receipt.kind === "message"
    ? result.receipt.messageId
    : undefined;
}
function assertCreatedCandidates(
  before: MeetingUpdateDelivery,
  after: MeetingUpdateDelivery,
): void {
  const candidates = [
    ...before.createdCandidates,
    ...knownCreatedCandidates(before.progress),
  ];
  const retained = [
    ...after.createdCandidates,
    ...knownCreatedCandidates(after.progress),
  ];
  for (const candidate of candidates)
    if (
      !retained.some((next) => isDeepStrictEqual(candidate, next)) &&
      !candidateRegisteredOrDeleted(candidate, before.progress)
    )
      throw new Error(
        "Created message identity must survive until registration or cleanup",
      );
}
function isSettled(submission: MeetingUpdateSubmission): boolean {
  return submission.kind === "verified" || submission.kind === "rejected";
}
function assertAttemptTransition(
  before: AttemptProgress,
  after: MeetingUpdateProgress,
): void {
  if (!hasAttempt(after)) {
    if (
      before.operations.some(
        (op) => op.submission.kind !== "prepared" && !isSettled(op.submission),
      )
    )
      throw new Error("Unsettled attempt cannot be discarded");
    return;
  }
  if (!isDeepStrictEqual(before.attempt, after.attempt))
    throw new Error("Prepared attempt is immutable");
  if (
    after.kind === "running" &&
    (before.claim.ownerInstanceId !== after.claim.ownerInstanceId ||
      (before.kind !== "running" &&
        before.operations.some((op) => !isSettled(op.submission))))
  )
    throw new Error("Reconciliation does not authorize provider replay");
  for (const [index, previous] of before.operations.entries()) {
    const next = after.operations[index];
    assertSubmissionTransition(previous.submission, next.submission);
    if (
      previous.submission.kind === "prepared" &&
      next.submission.kind !== "prepared" &&
      (after.kind !== "running" ||
        next.submission.kind !== "submitted" ||
        next.submission.submittedAt >= after.claim.leaseExpiresAt)
    )
      throw new Error("Submission requires an active running claim");
  }
}
function assertSubmissionTransition(
  before: MeetingUpdateSubmission,
  after: MeetingUpdateSubmission,
): void {
  if (isDeepStrictEqual(before, after)) return;
  if (before.kind === "prepared") return;
  if (
    after.kind === "prepared" ||
    before.submissionId !== after.submissionId ||
    before.submittedAt !== after.submittedAt ||
    isSettled(before)
  )
    throw new Error("Recorded submission cannot be replaced or replayed");
  if (
    before.kind === "returned" &&
    (after.kind !== "verified" ||
      after.receipt.kind !== "message" ||
      after.receipt.messageId !== before.messageId)
  )
    throw new Error("Returned POST identity must survive verification");
  if (after.kind === "submitted")
    throw new Error(
      "Submitted effects can only advance to known results or reconciliation",
    );
}

function assertSubmissionAdmission(
  before: MeetingUpdateDelivery,
  after: MeetingUpdateDelivery,
): void {
  if (!hasAttempt(after.progress)) return;
  if (!hasAttempt(before.progress)) {
    if (
      after.progress.operations.some((op) => op.submission.kind !== "prepared")
    )
      throw new Error("New claims must start with prepared operations");
    return;
  }
  const operations = before.progress.operations;
  const newlySubmitted = after.progress.operations.flatMap((op, index) =>
    operations[index]?.submission.kind === "prepared" &&
    op.submission.kind !== "prepared"
      ? [index]
      : [],
  );
  if (newlySubmitted.length > 1)
    throw new Error("Only one operation can be admitted per transition");
  for (const index of newlySubmitted) {
    if (before.policy.kind !== "active" || after.policy.kind !== "active")
      throw new Error("Publication policy must be active before submission");
    if (
      operations.slice(0, index).some((op) => op.submission.kind !== "verified")
    )
      throw new Error(
        "Predecessors must already be verified before submission",
      );
  }
}
function isVerifiedCompletion(
  before: MeetingUpdateDelivery,
  after: MeetingUpdateDelivery,
): boolean {
  if (
    !hasAttempt(before.progress) ||
    (after.progress.kind !== "pending" && after.progress.kind !== "synced") ||
    !before.progress.operations.every((op) => op.submission.kind === "verified")
  )
    return false;
  return Object.entries(before.progress.attempt.capturedParts).every(
    ([part, captured]) =>
      after.parts[presentationPartSchema.parse(part)].acknowledged ===
      Math.max(
        before.parts[presentationPartSchema.parse(part)].acknowledged,
        captured,
      ),
  );
}
function isRetryFailure(
  before: MeetingUpdateDelivery,
  after: MeetingUpdateDelivery,
): boolean {
  const retrying = after.progress.kind === "retrying";
  const exhausted =
    after.progress.kind === "blocked" &&
    after.progress.reason === "retry_exhausted";
  if (!retrying && !exhausted) return false;
  const notSubmitted =
    after.progress.kind === "retrying" &&
    after.progress.reason === "not_submitted";
  if (!hasAttempt(before.progress))
    return (
      notSubmitted ||
      (exhausted &&
        (before.progress.kind === "pending" ||
          before.progress.kind === "retrying"))
    );
  const submissions = before.progress.operations.map((op) => op.submission);
  return (
    submissions.every(
      (result) => result.kind === "prepared" || isSettled(result),
    ) &&
    (submissions.some((result) => result.kind === "rejected") ||
      notSubmitted ||
      exhausted)
  );
}
function assertRetryHistory(
  before: MeetingUpdateDelivery,
  after: MeetingUpdateDelivery,
): void {
  const completed = isVerifiedCompletion(before, after);
  if (completed && after.attempts !== 0)
    throw new Error("Verified completion resets retry history");
  if (before.attempts === after.attempts) return;
  const superseded =
    !hasAttempt(before.progress) &&
    presentationPartSchema.options.some(
      (part) => after.parts[part].desired > before.parts[part].desired,
    );
  if (after.attempts === 0 && (completed || superseded)) return;
  if (after.attempts === before.attempts + 1 && isRetryFailure(before, after))
    return;
  throw new Error(
    "Retry history can only advance on failure or reset for settled/new work",
  );
}
function assertLastSuccess(
  before: MeetingUpdateDelivery,
  after: MeetingUpdateDelivery,
): void {
  if (!isVerifiedCompletion(before, after)) {
    if (!isDeepStrictEqual(before.lastSuccess, after.lastSuccess))
      throw new Error("Last success only changes on verified completion");
    return;
  }
  if (!hasAttempt(before.progress)) return;
  const success = after.lastSuccess;
  const verifiedAt = before.progress.operations.flatMap((op) =>
    op.submission.kind === "verified" ? [op.submission.verifiedAt] : [],
  );
  if (
    !success ||
    success.contentRevision !== before.progress.attempt.contentRevision ||
    success.at <
      Math.max(
        0,
        ...verifiedAt,
        ...before.progress.attempt.observations.map(
          (target) => target.observedAt,
        ),
      ) ||
    (before.lastSuccess &&
      (success.at < before.lastSuccess.at ||
        success.contentRevision < before.lastSuccess.contentRevision))
  )
    throw new Error(
      "Last success requires monotonic verified completion evidence",
    );
}

export const meetingUpdateDeliveryTransitionSchema = z.discriminatedUnion(
  "kind",
  [
    z
      .object({
        kind: z.literal("progress"),
        revision: id,
        progress: meetingUpdateProgressSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal("complete"),
        revision: id,
        attemptId: id,
        completedAt: seconds,
      })
      .strict(),
    z
      .object({
        kind: z.literal("policy"),
        revision: id,
        policy: meetingUpdatePolicySchema,
        nextCheckAt: seconds,
      })
      .strict(),
  ],
);
export type MeetingUpdateDeliveryTransition = z.infer<
  typeof meetingUpdateDeliveryTransitionSchema
>;
export const meetingUpdateDeliveryCursorSchema = z
  .object({
    guildId: id,
    channelId_timestamp: id,
    updateDeliveryQueue: z.literal(MEETING_UPDATE_DELIVERY_QUEUE),
    updateDeliveryDueAt: seconds,
  })
  .strict();
export type MeetingUpdateDeliveryCursor = z.infer<
  typeof meetingUpdateDeliveryCursorSchema
>;
export function readMeetingUpdateDeliveryCursor(
  cursor?: string,
): MeetingUpdateDeliveryCursor | undefined {
  if (cursor === undefined) return undefined;
  if (!/^[A-Za-z0-9_-]+$/.test(cursor) || cursor.length > 8192)
    throw new Error("Invalid meeting update cursor");
  return meetingUpdateDeliveryCursorSchema.parse(
    JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")),
  );
}
export function writeMeetingUpdateDeliveryCursor(
  cursor: MeetingUpdateDeliveryCursor,
): string {
  return Buffer.from(
    JSON.stringify(meetingUpdateDeliveryCursorSchema.parse(cursor)),
  ).toString("base64url");
}
