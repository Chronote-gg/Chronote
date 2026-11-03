import { z } from "zod";
import {
  checkpointObjectSchema,
  recordingCaptureProvenanceSchema,
  recordingCheckpointSchema,
} from "./recordingCheckpoint";
import { localArtifactSchema, localArtifactsSchema } from "./localArtifact";
import { storedArtifactSchema } from "./storedArtifact";

export const artifactOwnerSchema = recordingCaptureProvenanceSchema.pick({
  guildId: true,
  meetingId: true,
  ownerInstanceId: true,
  executionVersion: true,
});
export type ArtifactOwner = z.infer<typeof artifactOwnerSchema>;
export const recoveryArtifactBindingSchema = z
  .object({
    owner: artifactOwnerSchema,
    historyKey: z.string().min(1).max(4096),
    checkpoint: recordingCheckpointSchema,
  })
  .strict();
export type RecoveryArtifactBinding = z.infer<
  typeof recoveryArtifactBindingSchema
>;
const contentIdentity = checkpointObjectSchema.omit({ key: true });
export const artifactProvenanceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("captured_audio"),
      producer: z.enum([
        "speaker_track",
        "live_encode",
        "mixed_encode",
        "transcription_scratch",
      ]),
    })
    .strict(),
  contentIdentity
    .extend({
      kind: z.literal("content"),
      contentKind: z.enum(["audio", "context", "transcription"]),
      sourceId: z.string().min(1),
      sequence: z.number().int().nonnegative(),
    })
    .strict(),
  z.object({ kind: z.literal("stored_input") }).strict(),
  z
    .object({
      kind: z.literal("stored_derivative"),
      inputs: z.array(checkpointObjectSchema).min(1).max(10_000),
    })
    .strict(),
  contentIdentity.extend({ kind: z.literal("metadata") }).strict(),
]);
export type ArtifactProvenance = z.infer<typeof artifactProvenanceSchema>;
export type RegisteredArtifact = {
  path: string;
  state: "known" | "uncertain";
  provenance: ArtifactProvenance;
};

export const artifactCleanupReceiptSchema = z
  .object({
    version: z.literal(1),
    owner: artifactOwnerSchema,
    historyKey: z.string().min(1).max(4096),
    createdAt: z.iso.datetime({ offset: true }),
    files: localArtifactsSchema,
    producers: z
      .array(
        z
          .object({
            path: localArtifactSchema.shape.path,
            state: z.enum(["known", "uncertain"]),
            provenance: artifactProvenanceSchema,
          })
          .strict(),
      )
      .max(10_000),
    storedArtifacts: z.array(storedArtifactSchema).max(10_000),
    checkpoint: recordingCheckpointSchema.nullable(),
    decision: z.enum(["complete", "cancel", "scratch"]),
  })
  .strict();
export type ArtifactCleanupReceipt = z.infer<
  typeof artifactCleanupReceiptSchema
>;
