import { z } from "zod";

export const PROCESSING_RETRY_QUEUE = "processing-retry:v1";
export const PROCESSING_RETRY_DUE_INDEX = "ProcessingRetryDueIndex";
export const PROCESSING_RETRY_USER_ATTEMPT_CAP = 3;

const id = z.string().min(1).max(512);
const timestamp = z.string().datetime();

export const processingRetryStageSchema = z.enum([
  "transcription",
  "notes",
  "summary",
]);
export type ProcessingRetryStage = z.infer<typeof processingRetryStageSchema>;

export const processingRetryFailureReasonSchema = z.enum([
  "stage_failed",
  "source_missing",
  "notes_changed",
  "invalid_snapshot",
  "nothing_to_retry",
  "unknown",
]);
export type ProcessingRetryFailureReason = z.infer<
  typeof processingRetryFailureReasonSchema
>;

export const processingRetryJobSchema = z
  .object({
    jobId: id,
    status: z.enum(["queued", "running", "succeeded", "failed"]),
    stages: z.array(processingRetryStageSchema).min(1),
    requestedBy: id,
    requestedAt: timestamp,
    expectedNotesVersion: z.number().int().positive(),
    replaceNotes: z.boolean(),
    countedAttempts: z.number().int().nonnegative(),
    settingsSource: z.enum(["snapshot", "current"]),
    transcriptSource: z.enum(["checkpoint", "mixed", "existing"]),
    failureReason: processingRetryFailureReasonSchema.optional(),
    claim: z
      .object({
        ownerInstanceId: id,
        claimId: id,
        leaseExpiresAt: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
    updatedAt: timestamp,
  })
  .strict();
export type ProcessingRetryJob = z.infer<typeof processingRetryJobSchema>;

export type ProcessingRetryIneligibleReason =
  | "unavailable"
  | "not_permitted"
  | "personal_meeting"
  | "processing_in_progress"
  | "no_processing_record"
  | "job_active"
  | "nothing_failed"
  | "capture_incomplete"
  | "source_missing"
  | "attempts_exhausted"
  | "notes_edited";

/** Ineligible reasons the portal explains to the user; every other reason renders nothing. */
export const PROCESSING_RETRY_EXPLAINED_REASONS = [
  "attempts_exhausted",
  "notes_edited",
  "source_missing",
  "capture_incomplete",
] as const satisfies readonly ProcessingRetryIneligibleReason[];
export type ProcessingRetryExplainedReason =
  (typeof PROCESSING_RETRY_EXPLAINED_REASONS)[number];

export type ProcessingRetryEligibility =
  | {
      eligible: true;
      stages: ProcessingRetryStage[];
      requiresReplaceConfirm: boolean;
      transcriptSource: ProcessingRetryJob["transcriptSource"];
    }
  | { eligible: false; reason: ProcessingRetryIneligibleReason };

export type ProcessingRetryView = {
  eligible: boolean;
  reason?: ProcessingRetryIneligibleReason;
  requiresReplaceConfirm: boolean;
  status?: ProcessingRetryJob["status"];
  failureReason?: ProcessingRetryFailureReason;
  settingsSource?: ProcessingRetryJob["settingsSource"];
  attemptsRemaining: number;
};
