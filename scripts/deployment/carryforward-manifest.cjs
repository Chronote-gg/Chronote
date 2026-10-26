"use strict";
const assert = require("node:assert/strict");
const { z } = require("zod");
const { bindingHash } = require("./continue-sandbox.cjs");
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const commit = z.string().regex(/^[a-f0-9]{40}$/);
const carryforwardManifestSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("sandbox_historical_carryforward"),
    operationId: z.string().uuid(),
    policy: z.literal("normal_protected_deployments_with_unresolved_history"),
    operatorExclusion: z.literal("exclusive_approved_writer_window"),
    accountId: z.string().regex(/^\d{12}$/),
    region: z.string().regex(/^[a-z]{2}-[a-z]+-\d$/),
    sourceCommit: commit,
    imageSourceCommit: commit,
    image: z.string().regex(/@sha256:[a-f0-9]{64}$/),
    templateArn: z.string().min(1),
    preparedDefinitionSha256: hash,
    controlSha256: hash,
    recoverySha256: hash,
    originalRunToken: z.string().regex(/^\d+-[1-9]\d*$/),
    approveBefore: z.number().int().positive(),
  })
  .strict();
function readCarryforwardManifest(env, now) {
  hash.parse(env.CARRYFORWARD_MANIFEST_SHA256);
  const manifest = carryforwardManifestSchema.parse(
    JSON.parse(env.CARRYFORWARD_MANIFEST_JSON),
  );
  assert.equal(bindingHash(manifest), env.CARRYFORWARD_MANIFEST_SHA256);
  assert.equal(manifest.accountId, env.EXPECTED_ACCOUNT_ID);
  assert.equal(manifest.region, env.AWS_REGION);
  assert.equal(manifest.sourceCommit, env.GITHUB_SHA);
  assert.equal(env.GITHUB_REPOSITORY, "Chronote-gg/Chronote");
  assert.equal(env.GITHUB_RUN_ATTEMPT, "1");
  assert.match(env.GITHUB_RUN_ID, /^\d+$/);
  assert.ok(
    manifest.approveBefore > now() && manifest.approveBefore <= now() + 86400,
  );
  return {
    manifest,
    hash: env.CARRYFORWARD_MANIFEST_SHA256,
    runToken: env.GITHUB_RUN_ID + "-1",
  };
}
module.exports = { carryforwardManifestSchema, readCarryforwardManifest };
