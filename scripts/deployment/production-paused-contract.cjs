"use strict";
const assert = require("node:assert/strict");
const { z } = require("zod");
const legacy = require("./paused-draft-contract.cjs");
const { canonicalHash } = require("./production-manifest.cjs");
const text = z.string().min(1).max(1024),
  hash = z.string().regex(/^[a-f0-9]{64}$/),
  sha = z.string().regex(/^[a-f0-9]{40}$/),
  integer = z.number().int().nonnegative().safe(),
  numericId = z.string().regex(/^[1-9][0-9]*$/),
  version = text.refine((v) => v !== "null");
const predicate = "preserve-two-desktop-drafts-v1";
const workflow = ".github/workflows/prepare-production-paused-drafts.yml";
const jobName = "Prepare production paused drafts";
const scopeSchema = z
  .object({
    operationId: z.string().uuid(),
    sourceCommit: sha,
    accountId: z.string().regex(/^\d{12}$/),
    region: z.string().regex(/^[a-z]{2}(?:-[a-z]+)+-\d$/),
    deploymentControlTable: text,
    personalJobTable: text,
    personalSegmentTable: text,
    bucket: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/),
  })
  .strict();
const identity = z
  .object({
    uploadId: text,
    ownerUserId: text,
    sourceCount: z.number().int().min(1).max(4),
  })
  .strict();
const cohortSchema = z
  .tuple([identity, identity])
  .refine((ids) => ids[0].uploadId !== ids[1].uploadId);
const sourceSchema = z
  .object({
    sourceId: text,
    kind: z.enum(["owner_mic", "system_output"]),
    sourceS3Key: text.optional(),
    contentType: text.optional(),
    fileSize: integer.optional(),
  })
  .strict();
const parentSchema = legacy.parentSchema
  .omit({ sourceManifest: true })
  .extend({ sourceManifest: z.array(sourceSchema).min(1).max(4) })
  .strict();
const segmentSchema = legacy.segmentSchema.omit({ label: true }).strict();
const checksumField = z.enum([
  "ChecksumSHA256",
  "ChecksumSHA1",
  "ChecksumCRC32",
  "ChecksumCRC32C",
  "ChecksumCRC64NVME",
]);
const requiredChecksumsSchema = z.partialRecord(
  checksumField,
  z.object({ value: text, source: text }).strict(),
);
const objectSchema = z
  .object({
    uploadId: text,
    ownerUserId: text,
    key: text,
    size: integer.positive(),
    contentType: text,
    versionId: version,
    checksums: z.partialRecord(checksumField, text),
    checksumType: z.enum(["FULL_OBJECT", "COMPOSITE", "unavailable"]),
    encryption: z
      .object({
        serverSideEncryption: z.enum(["AES256", "aws:kms"]),
        sseKmsKeyId: text.optional(),
        bucketKeyEnabled: z.literal(false).optional(),
      })
      .strict()
      .optional(),
    requiredChecksums: requiredChecksumsSchema.optional(),
  })
  .strict()
  .refine((v) =>
    Object.entries(v.requiredChecksums ?? {}).every(
      ([field, expected]) =>
        !v.checksums[field] || v.checksums[field] === expected.value,
    ),
  );
const storeBindingSchema =
  require("./private-capture.cjs").storageBinding.extend({
    retentionUntil: integer.positive(),
  });
const captureReferenceSchema = z
  .object({
    storeId: text.max(128),
    namespace: text,
    key: text.max(512),
    sha256: hash,
    size: integer.positive().max(262144),
    versionId: version,
  })
  .strict();
const ttl = z
  .object({
    TimeToLiveDescription: z
      .object({
        TimeToLiveStatus: z.literal("DISABLED"),
        AttributeName: text.optional(),
      })
      .strict(),
  })
  .strict();
const lifecycleRule = z
  .object({
    ID: text.optional(),
    Status: z.enum(["Enabled", "Disabled"]),
    Prefix: z.string().optional(),
    Filter: z.object({ Prefix: z.string() }).strict().optional(),
    AbortIncompleteMultipartUpload: z
      .object({ DaysAfterInitiation: integer.positive() })
      .strict()
      .optional(),
  })
  .strict()
  .refine((v) => v.Status === "Disabled" || !!v.AbortIncompleteMultipartUpload);
const storageSchema = z
  .object({
    observedAt: integer,
    personalJobTtl: ttl,
    personalSegmentTtl: ttl,
    personalJobKmsKeyArn: text,
    personalSegmentKmsKeyArn: text,
    bucketVersioning: z
      .object({
        Status: z.literal("Enabled"),
        MFADelete: z.enum(["Enabled", "Disabled"]).optional(),
      })
      .strict(),
    bucketLifecycle: z.object({ Rules: z.array(lifecycleRule) }).strict(),
  })
  .strict();
const preparationSchema = z
  .object({
    repository: z.literal("Chronote-gg/Chronote"),
    repositoryId: numericId,
    repositoryOwnerId: numericId,
    workflow: z.literal(workflow),
    jobName: z.literal(jobName),
    runId: numericId,
    runAttempt: z.literal("1"),
    sourceCommit: sha,
    actorId: numericId,
    accountId: z.string().regex(/^\d{12}$/),
    sessionArn: text,
    roleArn: text,
    validFrom: integer,
    validUntil: integer,
  })
  .strict();
const artifactPreparationSchema = preparationSchema.omit({
  accountId: true,
  sessionArn: true,
  roleArn: true,
});
const artifactSchema = z
  .object({
    schemaVersion: z.literal(1),
    requestSha256: hash,
    captureSha256: hash,
    captureSize: integer.positive().max(262144),
    captureVersionIdSha256: hash,
    preparation: artifactPreparationSchema,
  })
  .strict();
const captureSchema = z
  .object({
    schemaVersion: z.literal(1),
    predicate: z.literal(predicate),
    requestSha256: hash,
    scope: scopeSchema,
    cohort: cohortSchema,
    parents: z.array(parentSchema).length(2),
    segments: z.array(segmentSchema),
    objects: z.array(objectSchema).min(2),
    storageObservations: storageSchema,
    preparation: preparationSchema,
  })
  .strict();
const requestSchema = z
  .object({
    schemaVersion: z.literal(1),
    predicate: z.literal(predicate),
    scope: scopeSchema,
    cohort: cohortSchema,
    resourceArns: z
      .object({
        personalJob: text,
        personalSegment: text,
        deploymentControl: text,
        bucket: text,
        personalJobKmsKeyArn: text,
        personalSegmentKmsKeyArn: text,
      })
      .strict(),
    sourceObjects: z
      .array(
        z
          .object({
            key: text,
            versionId: version.optional(),
            requiredChecksums: requiredChecksumsSchema.optional(),
            encryption: objectSchema.shape.encryption,
          })
          .strict(),
      )
      .min(2)
      .max(90),
    storeBinding: storeBindingSchema,
    preparationRoleArn: text,
    validFrom: integer,
    validUntil: integer,
    maxPages: integer.positive().max(100),
    maxRows: integer.positive().max(90),
  })
  .strict();
const declarationSchema = z
  .object({
    predicate: z.literal(predicate),
    scope: scopeSchema,
    cohort: cohortSchema,
    request: z.object({ commit: sha, sha256: hash }).strict(),
    capture: captureReferenceSchema,
    storeBinding: storeBindingSchema,
    preparation: artifactPreparationSchema
      .extend({ artifactId: numericId })
      .strict(),
  })
  .strict();
function scopeFor(m) {
  return {
    operationId: m.operationId,
    sourceCommit: m.identity.sourceCommit,
    accountId: m.identity.accountId,
    region: m.identity.region,
    deploymentControlTable: m.resources.tables.deploymentControl,
    personalJobTable: m.resources.tables.personalJob,
    personalSegmentTable: m.resources.tables.personalSegment,
    bucket: m.resources.bucket,
  };
}
function parseRequest(value) {
  const r = requestSchema.parse(value),
    s = r.scope;
  assert.ok(r.validFrom < r.validUntil && r.validUntil - r.validFrom <= 86400);
  assert.equal(r.storeBinding.accountId, s.accountId);
  assert.equal(r.storeBinding.region, s.region);
  assert.ok(r.storeBinding.retentionUntil >= r.validUntil);
  for (const [key, table] of [
    ["personalJob", s.personalJobTable],
    ["personalSegment", s.personalSegmentTable],
    ["deploymentControl", s.deploymentControlTable],
  ])
    assert.equal(
      r.resourceArns[key],
      `arn:aws:dynamodb:${s.region}:${s.accountId}:table/${table}`,
    );
  assert.equal(r.resourceArns.bucket, `arn:aws:s3:::${s.bucket}`);
  for (const field of ["personalJobKmsKeyArn", "personalSegmentKmsKeyArn"])
    assert.ok(
      new RegExp(
        `^arn:aws:kms:${s.region}:${s.accountId}:key/[a-f0-9-]{36}$`,
      ).test(r.resourceArns[field]),
    );
  assert.ok(
    new RegExp(`^arn:aws:iam::${s.accountId}:role/[A-Za-z0-9_+=,.@/-]+$`).test(
      r.preparationRoleArn,
    ),
  );
  assert.equal(
    new Set(r.sourceObjects.map((o) => o.key)).size,
    r.sourceObjects.length,
  );
  for (const object of r.sourceObjects) {
    if (object.encryption?.sseKmsKeyId)
      assert.ok(
        new RegExp(
          `^arn:aws:kms:${s.region}:${s.accountId}:key/[a-f0-9-]{36}$`,
        ).test(object.encryption.sseKmsKeyId),
      );
    if (object.encryption?.serverSideEncryption === "AES256")
      assert.equal(object.encryption.sseKmsKeyId, undefined);
    assert.ok(
      r.cohort.some((id) =>
        object.key.startsWith(
          `personal-media-uploads/${id.ownerUserId}/${id.uploadId}/`,
        ),
      ),
    );
  }
  return r;
}
function preparationIdentity(r) {
  return {
    kind: "production-introduction-preparation",
    operationId: r.scope.operationId,
    sourceSha: r.scope.sourceCommit,
    evidenceStoreId: r.storeBinding.storeId,
    validUntil: r.validUntil,
  };
}
function assertCapture(value, r) {
  const c = captureSchema.parse(value);
  assert.equal(c.requestSha256, canonicalHash(r));
  assert.deepEqual(c.scope, r.scope);
  assert.deepEqual(c.cohort, r.cohort);
  assert.equal(c.preparation.validFrom, r.validFrom);
  assert.equal(c.preparation.validUntil, r.validUntil);
  assert.equal(c.preparation.sourceCommit, r.scope.sourceCommit);
  assert.equal(c.preparation.accountId, r.scope.accountId);
  assert.equal(c.preparation.roleArn, r.preparationRoleArn);
  for (const field of ["personalJobKmsKeyArn", "personalSegmentKmsKeyArn"])
    assert.equal(c.storageObservations[field], r.resourceArns[field]);
  assert.ok(
    c.storageObservations.observedAt >= r.validFrom &&
      c.storageObservations.observedAt < r.validUntil,
  );
  assert.equal(new Set(c.objects.map((o) => o.key)).size, c.objects.length);
  assert.deepEqual(
    c.objects.map((o) => o.key).sort(),
    r.sourceObjects.map((o) => o.key).sort(),
  );
  for (const o of c.objects) {
    const selected = r.sourceObjects.find((x) => x.key === o.key);
    if (selected.versionId) assert.equal(o.versionId, selected.versionId);
    assert.deepEqual(o.requiredChecksums, selected.requiredChecksums);
    for (const [field, value] of Object.entries(selected.encryption ?? {}))
      assert.equal(o.encryption?.[field], value);
  }
  return c;
}
module.exports = {
  scopeSchema,
  cohortSchema,
  parentSchema,
  segmentSchema,
  objectSchema,
  captureSchema,
  declarationSchema,
  requestSchema,
  storageSchema,
  storeBindingSchema,
  artifactSchema,
  preparationSchema,
  artifactPreparationSchema,
  captureReferenceSchema,
  preparationIdentity,
  scopeFor,
  parseRequest,
  assertCapture,
  workflow,
  jobName,
};
