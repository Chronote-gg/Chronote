"use strict";
const assert = require("node:assert/strict");
const { z } = require("zod");
const { manifestHash } = require("./sandbox-manifest.cjs");
const text = z.string().min(1);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().nonnegative();
const version = text.max(1024).refine((v) => v !== "null");
const identity = z.object({ uploadId: text, ownerUserId: text }).strict();
const identitiesSchema = z
  .tuple([identity, identity])
  .refine((rows) => rows[0].uploadId !== rows[1].uploadId);
const referenceSchema = z
  .object({
    storeId: text.max(128),
    namespace: text,
    key: text.max(512),
    sha256: hash,
    size: z.number().int().positive().max(33554432),
    versionId: version,
  })
  .strict();
const pausedDraftsSchema = z
  .object({ identities: identitiesSchema, capture: referenceSchema })
  .strict();
const objectSchema = identity
  .extend({
    key: text,
    size: count.positive(),
    contentType: text,
    checksumSha256: hash.nullable(),
    versionId: version,
    checksumSHA256: z
      .string()
      .regex(/^[A-Za-z0-9+/]{43}=$/)
      .nullable(),
  })
  .strict();
const sourceSchema = z
  .object({
    sourceId: text,
    kind: z.enum(["owner_mic", "system_output"]),
    label: text,
    sourceS3Key: text.optional(),
    contentType: text.optional(),
    fileSize: count.optional(),
    originalFileName: text.optional(),
  })
  .strict();
const parentSchema = identity
  .extend({
    status: z.enum(["pending_upload", "queued"]),
    mediaKind: z.literal("audio"),
    uploadOrigin: z.literal("desktop_recording"),
    sourceS3Key: text,
    sourceManifest: z.array(sourceSchema).min(1),
    contentType: text,
    fileSize: count,
    createdAt: text,
    updatedAt: text,
    attempts: z.literal(0).optional(),
    retryable: z.boolean().optional(),
    queuedAt: text.optional(),
    expiresAt: count.optional(),
    durationSeconds: z.number().nonnegative().optional(),
    segmentCount: count.optional(),
    uploadedSegmentCount: count.optional(),
    processedSegmentCount: z.literal(0).optional(),
  })
  .strict();
const segmentSchema = identity
  .extend({
    segmentKey: text,
    sourceId: text,
    sequence: count,
    kind: z.enum(["owner_mic", "system_output"]),
    label: text,
    sourceS3Key: text,
    contentType: text,
    fileSize: count.positive(),
    checksumSha256: hash,
    durationMillis: count,
    startedAt: text,
    endedAt: text,
    status: z.enum(["pending_upload", "uploaded", "submitted"]),
    createdAt: text,
    updatedAt: text,
    uploadedAt: text.optional(),
    submittedAt: text.optional(),
  })
  .strict();
const markerSchema = identity
  .extend({
    pk: text,
    sk: z.literal("PAUSED_DRAFT"),
    recordType: z.literal("paused_desktop_draft"),
    protocolVersion: z.literal(1),
    operationId: text,
    manifestSha256: hash,
    preservedCaptureSha256: hash,
    createdAt: count,
  })
  .strict()
  .refine((row) => row.pk === `UPLOAD#${row.uploadId}`);
// Include forbidden processing metadata in reads so its presence fails the strict draft schemas.
const parentFields = [
  ...Object.keys(parentSchema.shape),
  "processingClaimId",
  "processingOwnerInstanceId",
  "claimExpiresAt",
  "processingStartedAt",
  "artifactAttempts",
  "meetingGuildId",
  "meetingId",
  "channelId_timestamp",
  "completedAt",
];
const segmentFields = [
  ...Object.keys(segmentSchema.shape),
  "processedAt",
  "transcriptS3Key",
];
function preparationIdentity(m) {
  return {
    kind: `${m.kind}-preparation`,
    operationId: m.binding.operationId,
    sourceSha: m.binding.sourceSha,
    evidenceStoreId: m.evidenceStoreId,
    validUntil: m.validUntil,
  };
}
function captureBinding(m) {
  return {
    environment: m.environment,
    accountId: m.binding.accountId,
    region: m.binding.region,
    operationId: m.binding.operationId,
    sourceSha: m.binding.sourceSha,
    evidenceStoreId: m.evidenceStoreId,
    controlTableArn: m.controlTableArn,
    uploadTableArn: m.binding.tableArns.uploads,
    segmentTableArn: m.binding.tableArns.segments,
    bucket: m.bucket,
  };
}
function validatePausedBinding(m) {
  if (!m.pausedDrafts) return;
  const { capture } = pausedDraftsSchema.parse(m.pausedDrafts);
  const p = preparationIdentity(m);
  assert.equal(capture.storeId, m.evidenceStoreId);
  assert.equal(capture.namespace, `${p.kind}/${p.operationId}/${p.sourceSha}`);
  assert.equal(capture.key, `${capture.namespace}/${capture.sha256}`);
}
function rowDigest(row) {
  return manifestHash(
    Object.fromEntries(
      Object.keys(row)
        .sort()
        .map((key) => [key, row[key]]),
    ),
  );
}
module.exports = {
  pausedDraftsSchema,
  identitiesSchema,
  parentSchema,
  segmentSchema,
  markerSchema,
  parentFields,
  segmentFields,
  preparationIdentity,
  captureBinding,
  validatePausedBinding,
  rowDigest,
  objectSchema,
};
