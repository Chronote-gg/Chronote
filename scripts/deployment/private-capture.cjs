"use strict";
const assert = require("node:assert/strict");
const { z } = require("zod");
const s3 = require("@aws-sdk/client-s3");
const { digest } = require("./collector-payload.cjs");
const { bindingHash } = require("./binding-hash.cjs");
const { boundedBody } = require("./collector-principal.cjs");
const { captureNamespace } = require("./collector-command.cjs");
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const storageBinding = z
  .object({
    kind: z.literal("versioned-private-s3-v1"),
    storeId: z.string().min(1).max(128),
    bucket: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/),
    accountId: z.string().regex(/^\d{12}$/),
    region: z.string().regex(/^[a-z]{2}(?:-[a-z]+)+-\d$/),
    kmsKeyArn: z
      .string()
      .regex(/^arn:aws:kms:[a-z0-9-]+:\d{12}:key\/[a-f0-9-]{36}$/),
    canonicalPolicySha256: hash,
    lifecycleSha256: hash,
    retentionUntil: z.number().int().positive(),
    administratorTrustSha256: hash,
  })
  .strict();
async function checkStore(send, b, now) {
  assert.ok(now() < b.retentionUntil, "retention binding expired");
  const location = await send("GetBucketLocation");
  assert.equal(
    location.LocationConstraint ?? "us-east-1",
    b.region,
    "UNKNOWN: bucket region",
  );
  assert.equal(
    (await send("GetBucketVersioning")).Status,
    "Enabled",
    "UNKNOWN: versioning",
  );
  assert.deepEqual(
    (await send("GetBucketOwnershipControls")).OwnershipControls?.Rules,
    [{ ObjectOwnership: "BucketOwnerEnforced" }],
    "UNKNOWN: ownership",
  );
  assert.deepEqual(
    (await send("GetPublicAccessBlock")).PublicAccessBlockConfiguration,
    {
      BlockPublicAcls: true,
      IgnorePublicAcls: true,
      BlockPublicPolicy: true,
      RestrictPublicBuckets: true,
    },
    "UNKNOWN: privacy",
  );
  assert.equal(
    (await send("GetBucketPolicyStatus")).PolicyStatus?.IsPublic,
    false,
    "UNKNOWN: privacy",
  );
  const policy = (await send("GetBucketPolicy")).Policy;
  assert.equal(
    bindingHash(JSON.parse(policy)),
    b.canonicalPolicySha256,
    "UNKNOWN: policy binding",
  );
  const encryption = await send("GetBucketEncryption");
  const rules = encryption.ServerSideEncryptionConfiguration?.Rules,
    expectedRule = {
      ApplyServerSideEncryptionByDefault: {
        SSEAlgorithm: "aws:kms",
        KMSMasterKeyID: b.kmsKeyArn,
      },
      BucketKeyEnabled: false,
    };
  if (Object.hasOwn(rules?.[0] ?? {}, "BlockedEncryptionTypes"))
    expectedRule.BlockedEncryptionTypes =
      rules[0].BlockedEncryptionTypes === undefined
        ? undefined
        : { EncryptionType: ["SSE-C"] };
  assert.deepEqual(rules, [expectedRule], "UNKNOWN: encryption");
  let lifecycle;
  try {
    lifecycle = (await send("GetBucketLifecycleConfiguration")).Rules;
  } catch (error) {
    if (error.name !== "NoSuchLifecycleConfiguration") throw error;
    lifecycle = null;
  }
  assert.equal(
    digest(JSON.stringify(lifecycle)),
    b.lifecycleSha256,
    "UNKNOWN: lifecycle binding",
  );
  assert.ok(
    lifecycle === null || lifecycle.every((rule) => rule.Status === "Disabled"),
    "UNKNOWN: enabled lifecycle unsupported during retention",
  );
  assert.ok(now() < b.retentionUntil, "retention binding expired");
}
function createPrivateCapture({ m, manifestSha256, ...options }) {
  return createStore({
    ...options,
    storeId: m.evidenceStoreId,
    validUntil: m.validUntil,
    namespace: captureNamespace(m, manifestSha256),
  });
}
const preparationSchema = z
  .object({
    kind: z.enum([
      "production-introduction-preparation",
      "rehearsal-introduction-preparation",
    ]),
    operationId: z.string().uuid(),
    sourceSha: z.string().regex(/^[a-f0-9]{40}$/),
    evidenceStoreId: z.string().min(1).max(128),
    validUntil: z.number().int().positive(),
  })
  .strict();
function createPreparationCapture({ preparation, binding, client, now }) {
  const identity = preparationSchema.parse(preparation);
  return createStore({
    binding,
    client,
    now,
    storeId: identity.evidenceStoreId,
    validUntil: identity.validUntil,
    namespace: `${identity.kind}/${identity.operationId}/${identity.sourceSha}`,
  });
}
function createTerraformCapture({
  invocation,
  binding,
  client,
  now = () => Math.floor(Date.now() / 1000),
}) {
  const { parseInvocation } = require("./terraform-bundle.cjs");
  const i = parseInvocation(invocation);
  return createStore({
    binding,
    client,
    now,
    storeId: binding?.storeId,
    validUntil: now() + 21600,
    namespace: `terraform/${i.environment}/${i.runId}/1/${digest(JSON.stringify(i))}`,
  });
}
function createStore({
  binding,
  client,
  storeId,
  validUntil,
  namespace,
  now = () => Math.floor(Date.now() / 1000),
}) {
  const b = storageBinding.parse(binding);
  assert.equal(b.storeId, storeId);
  assert.ok(
    b.retentionUntil >= validUntil,
    "retention binding does not cover operation",
  );
  assert.ok(
    b.kmsKeyArn.startsWith(`arn:aws:kms:${b.region}:${b.accountId}:key/`),
  );
  const sdk =
    client ??
    new s3.S3Client({
      region: b.region,
      maxAttempts: 1,
      endpoint: `https://s3.${b.region}.amazonaws.com`,
    });
  const uncertain = new Set();
  async function send(name, input = {}) {
    assert.equal(await sdk.config.maxAttempts(), 1, "UNKNOWN: storage retries");
    assert.equal(await sdk.config.region(), b.region);
    return sdk.send(
      new s3[name + "Command"]({
        Bucket: b.bucket,
        ExpectedBucketOwner: b.accountId,
        ...input,
      }),
      { abortSignal: AbortSignal.timeout(30000) },
    );
  }
  function referenceCheck(ref) {
    assert.deepEqual(Object.keys(ref).sort(), [
      "key",
      "namespace",
      "sha256",
      "size",
      "storeId",
      "versionId",
    ]);
    assert.equal(ref.storeId, b.storeId);
    assert.equal(ref.namespace, namespace);
    hash.parse(ref.sha256);
    assert.equal(ref.key, namespace + "/" + ref.sha256);
    assert.ok(
      ref.key.length <= 512 && Buffer.byteLength(JSON.stringify(ref)) <= 2048,
    );
    assert.ok(
      typeof ref.versionId === "string" &&
        ref.versionId !== "null" &&
        ref.versionId.length > 0 &&
        ref.versionId.length <= 1024,
      "UNKNOWN: object version",
    );
    assert.ok(
      Number.isSafeInteger(ref.size) && ref.size > 0 && ref.size <= 33554432,
      "UNKNOWN: capture bytes",
    );
  }
  async function readCapture(ref) {
    try {
      referenceCheck(ref);
      await checkStore(send, b, now);
      const response = await send("GetObject", {
        Key: ref.key,
        VersionId: ref.versionId,
      });
      assert.equal(
        response.VersionId,
        ref.versionId,
        "UNKNOWN: object version",
      );
      assert.equal(response.ServerSideEncryption, "aws:kms");
      assert.equal(response.SSEKMSKeyId, b.kmsKeyArn);
      assert.equal(response.BucketKeyEnabled, false);
      assert.equal(response.ContentLength, ref.size, "UNKNOWN: capture bytes");
      const bytes = await boundedBody(
        response.Body,
        ref.size,
        AbortSignal.timeout(30000),
      );
      assert.equal(
        Buffer.byteLength(bytes),
        ref.size,
        "UNKNOWN: capture bytes",
      );
      assert.equal(digest(bytes), ref.sha256, "UNKNOWN: capture bytes");
      assert.ok(now() < b.retentionUntil);
      return JSON.parse(bytes);
    } catch {
      throw new Error("UNKNOWN: private exact-version capture unavailable");
    }
  }
  async function capture(value) {
    const bytes = Buffer.from(JSON.stringify(value));
    assert.ok(
      bytes.length > 0 && bytes.length <= 33554432,
      "UNKNOWN: capture bytes",
    );
    const sha256 = digest(bytes),
      key = namespace + "/" + sha256;
    assert.ok(
      !uncertain.has(key),
      "UNKNOWN: capture acknowledgment; read-only reconciliation required",
    );
    try {
      await checkStore(send, b, now);
      // The content-derived intended key is recoverable without replaying a lost write acknowledgment.
      uncertain.add(key);
      const response = await send("PutObject", {
        Key: key,
        Body: bytes,
        ContentLength: bytes.length,
        ContentType: "application/json",
        IfNoneMatch: "*",
        ServerSideEncryption: "aws:kms",
        SSEKMSKeyId: b.kmsKeyArn,
        BucketKeyEnabled: false,
        ChecksumSHA256: Buffer.from(sha256, "hex").toString("base64"),
      });
      const reference = {
        storeId: b.storeId,
        namespace,
        key,
        sha256,
        size: bytes.length,
        versionId: response.VersionId,
      };
      await readCapture(reference);
      return reference;
    } catch {
      throw new Error(
        "UNKNOWN: private capture acknowledgment; read-only reconciliation required; do not retry",
      );
    }
  }
  return { capture, readCapture, checkReady: () => checkStore(send, b, now) };
}
module.exports = {
  storageBinding,
  createPrivateCapture,
  createPreparationCapture,
  createTerraformCapture,
};
