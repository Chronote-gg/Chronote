import { z } from "zod";

const id = z.string().min(1).max(1024);
const ordinal = z.number().int().nonnegative();
const timestamp = z.iso.datetime({ offset: true });
const intervalSchema = z
  .object({
    sourceId: id,
    startOffsetMs: z.number().nonnegative(),
    durationMs: z.number().positive(),
  })
  .strict();
export const recordingCoverageSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("unknown") }).strict(),
  z
    .object({ kind: z.literal("known"), intervals: z.array(intervalSchema) })
    .strict(),
]);
export const captureCoverageSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("verified"),
      intervals: z.array(intervalSchema).min(1),
      savedDurationMs: z.number().positive(),
      lastConfirmedCaptureAt: timestamp,
      stoppedAt: timestamp.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("unknown"),
      detectedAt: timestamp,
      reason: z.enum([
        "capture_start_unknown",
        "no_verified_audio",
        "source_intervals_unknown",
        "verification_failed",
      ]),
      stoppedAt: timestamp.optional(),
    })
    .strict(),
]);
export const recordingCaptureStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("unknown") }).strict(),
  z.object({ kind: z.literal("not_started") }).strict(),
  z.object({ kind: z.literal("capturing"), startedAt: timestamp }).strict(),
  z
    .object({
      kind: z.literal("complete"),
      startedAt: timestamp,
      endedAt: timestamp,
    })
    .strict(),
  z
    .object({
      kind: z.literal("interrupted"),
      startedAt: timestamp.nullable(),
      detectedAt: timestamp,
      endedAt: timestamp.nullable(),
    })
    .strict(),
]);
const recoveryBase = z.object({
  attempt: ordinal,
  executionVersion: z.number().int().positive(),
  stage: z.enum([
    "verification",
    "transcription",
    "notes",
    "delivery",
    "export",
  ]),
  retry: z
    .object({
      maxAttempts: z.number().int().positive(),
      nextAttemptAt: timestamp.nullable(),
    })
    .strict(),
});
export const recoveryDispositionSchema = z
  .discriminatedUnion("disposition", [
    recoveryBase.extend({ disposition: z.literal("pending") }).strict(),
    recoveryBase.extend({ disposition: z.literal("claimed") }).strict(),
    recoveryBase
      .extend({
        disposition: z.literal("done"),
        outcome: z.enum([
          "completed",
          "disabled",
          "no_usable_speech",
          "no_verified_checkpoint",
        ]),
      })
      .strict(),
    recoveryBase.extend({ disposition: z.literal("failed") }).strict(),
    recoveryBase
      .extend({
        disposition: z.literal("needs_reconciliation"),
        reason: z.enum([
          "ownership_uncertain",
          "delivery_uncertain",
          "export_uncertain",
          "invalid_checkpoint",
          "invalid_payload",
          "transcript_overlap_unknown",
          "retry_exhausted",
          "policy_unknown",
        ]),
      })
      .strict(),
  ])
  .refine(
    (state) => state.attempt <= state.retry.maxAttempts,
    "Recovery attempt exceeds retry bound",
  );
export const recordingCaptureProvenanceSchema = z
  .object({
    guildId: id,
    channelId: id,
    channelId_timestamp: id,
    meetingId: id,
    ownerInstanceId: id,
    executionVersion: z.number().int().positive(),
    reservedAt: timestamp,
    // Actual receiver subscription, never reservation time or interruption detection.
    captureStartedAt: timestamp.nullable(),
    requested: z
      .object({ transcribeMeeting: z.boolean(), generateNotes: z.boolean() })
      .strict(),
  })
  .strict();
export const checkpointObjectSchema = z
  .object({
    key: id,
    checksumSha256: z.string().regex(/^[a-f0-9]{64}$/),
    byteLength: ordinal,
  })
  .strict();
export const checkpointPcmFormatSchema = z
  .object({
    encoding: z.literal("pcm_s16le"),
    sampleRate: z.number().int().positive(),
    channels: z.number().int().positive(),
  })
  .strict();
const checkpointAudioTimingSchema = z
  .object({
    basis: z.literal("sample_cursor_with_observed_gaps"),
    observedFirstOffsetMs: z.number(),
    observedLastOffsetMs: z.number(),
    maxCursorAdjustmentMs: z.number().nonnegative(),
  })
  .strict();
const artifactBase = z.object({
  sourceId: id,
  sequence: ordinal,
  contentType: id,
  coverage: recordingCoverageSchema,
  object: checkpointObjectSchema,
});
export const checkpointArtifactSchema = z
  .discriminatedUnion("kind", [
    artifactBase
      .extend({
        kind: z.literal("audio"),
        format: checkpointPcmFormatSchema,
        timing: checkpointAudioTimingSchema.optional(),
      })
      .strict(),
    artifactBase.extend({ kind: z.literal("transcription") }).strict(),
    artifactBase.extend({ kind: z.literal("context") }).strict(),
  ])
  .refine(
    (artifact) =>
      artifact.kind !== "audio" ||
      artifact.coverage.kind === "unknown" ||
      artifact.coverage.intervals.every(
        (interval) => interval.sourceId === artifact.sourceId,
      ),
    "Audio coverage must bind its source",
  );
export const recordingManifestSchema = z
  .object({
    artifactFolder: id,
    schemaVersion: z.literal(1),
    revision: z.number().int().positive(),
    capture: recordingCaptureProvenanceSchema,
    captureState: recordingCaptureStateSchema,
    coverage: captureCoverageSchema,
    artifacts: z.array(checkpointArtifactSchema),
  })
  .strict();
export const recordingCheckpointSchema = z
  .object({
    artifactFolder: id,
    schemaVersion: z.literal(1),
    revision: z.number().int().positive(),
    capture: recordingCaptureProvenanceSchema,
    manifest: checkpointObjectSchema,
  })
  .strict();
export type RecordingCaptureProvenance = z.infer<
  typeof recordingCaptureProvenanceSchema
>;
export type RecordingCoverage = z.infer<typeof recordingCoverageSchema>;
export type CaptureCoverage = z.infer<typeof captureCoverageSchema>;
export const captureCoverageSummarySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("unknown") }).strict(),
  z
    .object({
      kind: z.literal("verified"),
      savedDurationMs: z.number().positive().finite(),
      lastConfirmedCaptureAt: timestamp,
      stoppedAt: timestamp.optional(),
    })
    .strict(),
]);
export type CaptureCoverageSummary = z.infer<
  typeof captureCoverageSummarySchema
>;
export type RecordingCaptureState = z.infer<typeof recordingCaptureStateSchema>;
export type RecoveryDisposition = z.infer<typeof recoveryDispositionSchema>;
export type CheckpointObject = z.infer<typeof checkpointObjectSchema>;
export type CheckpointArtifact = z.infer<typeof checkpointArtifactSchema>;
export type CheckpointSegment = Extract<CheckpointArtifact, { kind: "audio" }>;
export type RecordingCheckpointManifest = z.infer<
  typeof recordingManifestSchema
>;
export type RecordingManifest = RecordingCheckpointManifest;
export type RecordingCheckpoint = z.infer<typeof recordingCheckpointSchema>;
type ArtifactBytes = { bytes: Uint8Array; checksumSha256: string };
export type CheckpointArtifactInput = (
  | Omit<CheckpointSegment, "object">
  | Omit<Extract<CheckpointArtifact, { kind: "transcription" }>, "object">
  | Omit<Extract<CheckpointArtifact, { kind: "context" }>, "object">
) &
  ArtifactBytes;
export type CheckpointSegmentInput = {
  sourceId: string;
  sequence: number;
  startOffsetMs: number | null;
  durationMs: number;
  format: z.infer<typeof checkpointPcmFormatSchema>;
  bytes: Uint8Array;
  checksumSha256: string;
};
export type CheckpointAppendResult =
  | {
      kind: "committed";
      checkpoint: RecordingCheckpoint;
      coverage: CaptureCoverage;
    }
  | { kind: "stale_owner"; coverage: CaptureCoverage }
  | { kind: "preservation_failed"; coverage: CaptureCoverage };

export const recoveryExportSchema = z
  .object({
    checkpointRevision: z.number().int().positive(),
    intentExecutionVersion: z.number().int().positive(),
    state: z.enum(["pending", "submitted", "acknowledged", "skipped"]),
  })
  .strict();
export type RecoveryExport = z.infer<typeof recoveryExportSchema>;
