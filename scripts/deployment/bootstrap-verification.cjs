"use strict";
const assert = require("node:assert/strict");
const s3 = require("@aws-sdk/client-s3");
const { z } = require("zod");
const { digest } = require("./collector-payload.cjs");
const {
  storageBinding,
  createVerificationCapture,
} = require("./private-capture.cjs");
const payload = Object.freeze({
  kind: "chronote-bootstrap-verification-v1",
  synthetic: true,
});
const controls = [
  "s3:GetBucketLocation",
  "s3:GetBucketVersioning",
  "s3:GetBucketOwnershipControls",
  "s3:GetBucketPublicAccessBlock",
  "s3:GetBucketPolicyStatus",
  "s3:GetBucketPolicy",
  "s3:GetEncryptionConfiguration",
  "s3:GetLifecycleConfiguration",
];
const namespace = (i) =>
  `terraform/production/verification/${i.runId}/1/${i.sourceSha}`;
function verificationConfiguration(text) {
  return z
    .object({
      environmentId: z.number().int().positive(),
      binding: storageBinding,
    })
    .strict()
    .parse(JSON.parse(text));
}
function verificationIdentity(env, binding, now) {
  const b = storageBinding.parse(binding);
  assert.equal(env.GITHUB_REPOSITORY, "Chronote-gg/Chronote");
  assert.equal(env.GITHUB_REF, "refs/heads/master");
  assert.equal(env.GITHUB_RUN_ATTEMPT, "1");
  assert.match(env.GITHUB_RUN_ID, /^[1-9]\d{0,15}$/);
  assert.match(env.GITHUB_SHA, /^[a-f0-9]{40}$/);
  assert.equal(env.GITHUB_SHA, env.VERIFICATION_SOURCE_SHA);
  assert.equal(
    new Date(env.VERIFICATION_DEADLINE).toISOString(),
    env.VERIFICATION_DEADLINE,
  );
  assert.equal(b.bucket, `meeting-notes-prod-private-evidence-${b.accountId}`);
  assert.equal(b.region, "us-east-1");
  const deadline = Date.parse(env.VERIFICATION_DEADLINE) / 1000;
  assert.ok(
    Number.isFinite(deadline) && deadline > now && deadline <= now + 3600,
  );
  assert.ok(b.retentionUntil >= now + 21600);
  return { runId: env.GITHUB_RUN_ID, sourceSha: env.GITHUB_SHA };
}
function verificationPolicy(b, identity) {
  const bucket = `arn:aws:s3:::${b.bucket}`,
    prefix = `${bucket}/${namespace(identity)}`;
  const policy = JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      { Effect: "Allow", Action: controls, Resource: bucket },
      {
        Effect: "Allow",
        Action: ["s3:PutObject", "s3:GetObjectVersion"],
        Resource: [
          `${prefix}/payload/${digest(JSON.stringify(payload))}`,
          `${prefix}/negative/missing-condition`,
          `${prefix}/negative/wrong-encryption`,
          `${prefix}/report/*`,
        ],
      },
      {
        Effect: "Allow",
        Action: ["kms:GenerateDataKey", "kms:Decrypt"],
        Resource: b.kmsKeyArn,
        Condition: {
          StringEquals: {
            "kms:ViaService": `s3.${b.region}.amazonaws.com`,
            "kms:CallerAccount": b.accountId,
          },
          StringLike: { "kms:EncryptionContext:aws:s3:arn": `${prefix}/*` },
        },
      },
    ],
  });
  assert.ok(
    Buffer.byteLength(policy) <= 2048,
    "session policy exceeds STS limit",
  );
  return policy;
}
async function expectDenied(client, command, status, name, signal) {
  let failure;
  try {
    const response = await client.send(command, { abortSignal: signal });
    response.Body?.destroy();
  } catch (error) {
    failure = error;
  }
  assert.equal(failure?.name, name, "unexpected probe result");
  assert.equal(
    failure.$metadata?.httpStatusCode,
    status,
    "unexpected probe status",
  );
  return { status, name, requestId: failure.$metadata.requestId ?? null };
}
async function runStorageVerification({
  binding,
  identity,
  client,
  now = () => Math.floor(Date.now() / 1000),
  authority = async () => ({}),
  signal = AbortSignal.timeout(900000),
  caller = null,
  receipts = [],
}) {
  signal.throwIfAborted();
  assert.equal(await client.config.maxAttempts(), 1);
  assert.equal(await client.config.region(), binding.region);
  const options = { binding, identity, client, now };
  const store = createVerificationCapture({ ...options, purpose: "payload" });
  await store.checkReady();
  const before = await authority();
  signal.throwIfAborted();
  const reference = await store.capture(payload);
  const bytes = Buffer.from(JSON.stringify(payload));
  const request = {
    Bucket: binding.bucket,
    ExpectedBucketOwner: binding.accountId,
    Key: reference.key,
    Body: bytes,
    ContentLength: bytes.length,
    ContentType: "application/json",
    IfNoneMatch: "*",
    ServerSideEncryption: "aws:kms",
    SSEKMSKeyId: binding.kmsKeyArn,
    BucketKeyEnabled: false,
    ChecksumSHA256: Buffer.from(reference.sha256, "hex").toString("base64"),
  };
  const malformed = [
    [new s3.PutObjectCommand(request), 412, "PreconditionFailed"],
    [
      new s3.PutObjectCommand({
        ...request,
        Key: `${namespace(identity)}/negative/missing-condition`,
        IfNoneMatch: undefined,
      }),
      403,
      "AccessDenied",
    ],
    [
      new s3.PutObjectCommand({
        ...request,
        Key: `${namespace(identity)}/negative/wrong-encryption`,
        ServerSideEncryption: "AES256",
        SSEKMSKeyId: undefined,
      }),
      403,
      "AccessDenied",
    ],
    [
      new s3.GetObjectCommand({
        Bucket: binding.bucket,
        ExpectedBucketOwner: binding.accountId,
        Key: reference.key,
      }),
      403,
      "AccessDenied",
    ],
  ];
  const probes = [];
  for (const [command, status, name] of malformed) {
    signal.throwIfAborted();
    probes.push(await expectDenied(client, command, status, name, signal));
  }
  const after = await authority();
  assert.deepEqual(after, before, "native authority changed");
  signal.throwIfAborted();
  const report = {
    kind: "chronote-bootstrap-verification-report-v1",
    identity,
    reference,
    probes,
    authority: before,
    caller,
    receipts: structuredClone(receipts),
    receiptsSha256: digest(JSON.stringify(receipts)),
    storageBindingSha256: digest(JSON.stringify(binding)),
    sessionPolicySha256: digest(verificationPolicy(binding, identity)),
  };
  assert.ok(Buffer.byteLength(JSON.stringify(report)) <= 65536);
  const reportStore = createVerificationCapture({
    ...options,
    purpose: "report",
  });
  const reportReference = await reportStore.capture(report);
  signal.throwIfAborted();
  assert.deepEqual(
    await authority(),
    before,
    "native authority changed after report",
  );
  return {
    outcome: "storage-probes-passed-reviewer-readback-pending",
    reference,
    reportReference,
    probes,
  };
}
module.exports = {
  payload,
  namespace,
  verificationIdentity,
  verificationConfiguration,
  verificationPolicy,
  runStorageVerification,
};
