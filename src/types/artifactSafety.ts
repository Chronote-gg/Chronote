import { z } from "zod";
import { artifactAuthoritySchema } from "./artifactCleanup";
import {
  runtimeIdentitySchema,
  retirementRequestSchema,
  sameRuntimeIdentity,
  type RuntimeIdentity,
} from "./deploymentControl";

export const MAX_ARTIFACT_AUTHORITIES = 90;
export const ARTIFACT_PROOF_SECONDS = 60;
export const ARTIFACT_PREPARATION_SECONDS = 300;
export const LEGACY_ATTESTATION_SECONDS = 6 * 60 * 60;
const epoch = z.number().int().nonnegative();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const operatorText = z.string().trim().min(1).max(1024);
export const artifactStorageSnapshotSchema = z
  .object({
    inventoryDigest: digest,
    fileCount: z.number().int().nonnegative().max(20_000),
    byteLength: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    pendingDirectories: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_ARTIFACT_AUTHORITIES),
    authorities: z.array(artifactAuthoritySchema).max(MAX_ARTIFACT_AUTHORITIES),
  })
  .strict();
export type ArtifactStorageSnapshot = z.infer<
  typeof artifactStorageSnapshotSchema
>;

export const artifactStorageProofSchema = z
  .object({
    snapshot: artifactStorageSnapshotSchema,
    provenAt: epoch,
    expiresAt: epoch,
  })
  .strict()
  .refine(
    (proof) =>
      proof.expiresAt > proof.provenAt &&
      proof.expiresAt <= proof.provenAt + ARTIFACT_PROOF_SECONDS,
    "Artifact proof lifetime is not bounded",
  );
export type ArtifactStorageProof = z.infer<typeof artifactStorageProofSchema>;
export const artifactSafetyRequestSchema = z
  .object({
    source: runtimeIdentitySchema,
    coordinatorToken: z.string().min(1).max(1024),
    coordinatorEpoch: epoch,
    servingGeneration: epoch,
    requestedAt: epoch,
    expiresAt: epoch,
  })
  .strict()
  .refine(
    (request) =>
      request.expiresAt > request.requestedAt &&
      request.expiresAt <= request.requestedAt + ARTIFACT_PREPARATION_SECONDS,
    "Artifact preparation lifetime is not bounded",
  );
export type ArtifactSafetyRequest = z.infer<typeof artifactSafetyRequestSchema>;

const startupSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pending") }).strict(),
  z
    .object({ kind: z.literal("sealed"), proof: artifactStorageProofSchema })
    .strict(),
  z.object({ kind: z.literal("active"), activatedAt: epoch }).strict(),
]);
/**
 * Operator evidence for a source runtime built before this protocol. Such a
 * runtime never writes its own row, so the coordinator stands in for it and
 * every row carrying this field is coordinator-owned.
 */
export const legacyAttestationSchema = z
  .object({
    kind: z.literal("operator_attested_legacy"),
    operator: operatorText,
    reason: operatorText,
    manifestUri: z
      .string()
      .regex(/^s3:\/\/[^/]+\/.+$/)
      .max(1024),
    manifestSha256: digest,
    taskId: operatorText,
    pendingAdmission: epoch,
    capturedAt: epoch,
    fileCount: z.number().int().nonnegative().max(20_000),
    byteLength: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    verifiedAt: epoch,
    expiresAt: epoch,
  })
  .strict()
  .refine(
    (value) =>
      value.capturedAt <= value.verifiedAt &&
      value.expiresAt > value.verifiedAt &&
      value.expiresAt <= value.verifiedAt + LEGACY_ATTESTATION_SECONDS,
    "Legacy attestation lifetime is not bounded",
  );
export type LegacyAttestation = z.infer<typeof legacyAttestationSchema>;
const base = z.object({
  pk: z.literal("ENV"),
  sk: z.string().min(1).max(1024),
  recordType: z.literal("artifact_safety"),
  schemaVersion: z.literal(1),
  identity: runtimeIdentitySchema,
  revision: epoch,
  heartbeatAt: epoch,
  freshUntil: epoch,
  startup: startupSchema,
  attestation: legacyAttestationSchema.optional(),
});
export const artifactSafetyBaseSchema = base;
const retirementVerificationSchema = z
  .object({
    request: retirementRequestSchema,
    proof: artifactStorageProofSchema,
  })
  .strict();
export const artifactSafetyRecordSchema = z
  .discriminatedUnion("state", [
    base.extend({ state: z.literal("idle") }).strict(),
    base
      .extend({
        state: z.literal("attested_legacy"),
        attestation: legacyAttestationSchema,
      })
      .strict(),
    base
      .extend({
        state: z.literal("requested"),
        request: artifactSafetyRequestSchema,
      })
      .strict(),
    base
      .extend({
        state: z.literal("draining"),
        request: artifactSafetyRequestSchema,
        activeProducers: epoch,
      })
      .strict(),
    base
      .extend({
        state: z.literal("sealed"),
        request: artifactSafetyRequestSchema,
        proof: artifactStorageProofSchema,
      })
      .strict(),
    base
      .extend({
        state: z.literal("blocked"),
        request: artifactSafetyRequestSchema,
        reason: z.enum([
          "work_remaining",
          "preservation_incomplete",
          "deadline_expired",
        ]),
      })
      .strict(),
    base
      .extend({
        state: z.literal("consumed"),
        request: artifactSafetyRequestSchema,
        proof: artifactStorageProofSchema,
        consumedAt: epoch,
        retirementVerification: retirementVerificationSchema.optional(),
      })
      .strict(),
    base
      .extend({
        state: z.literal("cancel_requested"),
        request: artifactSafetyRequestSchema,
      })
      .strict(),
    base
      .extend({
        state: z.literal("cancelled"),
        request: artifactSafetyRequestSchema,
        cancelledAt: epoch,
      })
      .strict(),
    base
      .extend({
        state: z.literal("retirement_safe"),
        retirementVerification: retirementVerificationSchema,
      })
      .strict(),
  ])
  .refine(
    (row) => row.sk === artifactSafetyKey(row.identity).sk,
    "Artifact row identity differs from its key",
  )
  .refine(
    (row) =>
      row.freshUntil > row.heartbeatAt &&
      row.freshUntil <= row.heartbeatAt + ARTIFACT_PROOF_SECONDS,
    "Artifact capability lifetime is not bounded",
  )
  .refine(
    (row) =>
      !("request" in row) ||
      sameRuntimeIdentity(row.request.source, row.identity),
    "Artifact request source differs",
  )
  .refine(
    (row) =>
      !("retirementVerification" in row) ||
      !row.retirementVerification ||
      sameRuntimeIdentity(
        row.retirementVerification.request.identity,
        row.identity,
      ),
    "Artifact retirement source differs",
  )
  .refine(
    (row) => !("proof" in row) || row.proof.expiresAt <= row.request.expiresAt,
    "Preparation proof exceeds request lifetime",
  );
export type ArtifactSafetyRecord = z.infer<typeof artifactSafetyRecordSchema>;
export function artifactSafetyKey(identity: RuntimeIdentity) {
  return { pk: "ENV", sk: `ARTIFACTS#${identity.instanceId}/STATE` };
}
