"use strict";
const assert = require("node:assert/strict");
const { z } = require("zod");
const { bindingHash } = require("./binding-hash.cjs");
const { carryforwardManifestSchema } = require("./carryforward-manifest.cjs");
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const preparingProofSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("sandbox_preparing_recovery"),
    operationId: z.string().uuid(),
    sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
    originalManifestSha256: hash,
    controlSha256: hash,
    archiveSha256: hash,
    recoverySha256: hash,
    logicalRunToken: z.string().regex(/^\d+-1$/),
    definitionArn: z.string().min(1),
    definitionSha256: hash,
    approveBefore: z.number().int().positive(),
  })
  .strict();
function readPreparingProof(env, now) {
  const proof = preparingProofSchema.parse(
    JSON.parse(env.PREPARING_RECOVERY_PROOF_JSON),
  );
  const manifest = carryforwardManifestSchema.parse(
    JSON.parse(env.CARRYFORWARD_MANIFEST_JSON),
  );
  hash.parse(env.PREPARING_RECOVERY_PROOF_SHA256);
  assert.equal(bindingHash(proof), env.PREPARING_RECOVERY_PROOF_SHA256);
  assert.equal(bindingHash(manifest), env.CARRYFORWARD_MANIFEST_SHA256);
  assert.equal(proof.originalManifestSha256, env.CARRYFORWARD_MANIFEST_SHA256);
  assert.equal(proof.operationId, manifest.operationId);
  assert.equal(manifest.accountId, env.EXPECTED_ACCOUNT_ID);
  assert.equal(manifest.region, env.AWS_REGION);
  assert.equal(proof.sourceCommit, env.GITHUB_SHA);
  assert.equal(env.GITHUB_REPOSITORY, "Chronote-gg/Chronote");
  assert.equal(env.GITHUB_RUN_ATTEMPT, "1");
  assert.match(env.GITHUB_RUN_ID, /^\d+$/);
  assert.notEqual(env.GITHUB_RUN_ID + "-1", proof.logicalRunToken);
  assert.ok(
    proof.approveBefore > now() && proof.approveBefore <= now() + 86400,
  );
  return { proof, manifest, executionRunToken: env.GITHUB_RUN_ID + "-1" };
}
module.exports = { preparingProofSchema, readPreparingProof };
