"use strict";
const assert = require("node:assert/strict");
const { verifyEnvironmentApproval } = require("./terraform-native.cjs");
async function verifyAuthority(get, identity, environmentId) {
  assert.ok(Number.isSafeInteger(environmentId) && environmentId > 0);
  const path = "/repos/Chronote-gg/Chronote";
  const run = await get(`${path}/actions/runs/${identity.runId}`);
  assert.equal(String(run.id), identity.runId);
  assert.equal(run.repository.full_name, "Chronote-gg/Chronote");
  assert.equal(run.repository.id, 849540249);
  assert.equal(run.repository.owner.id, 251985640);
  assert.equal(run.head_repository.id, run.repository.id);
  assert.equal(run.head_sha, identity.sourceSha);
  assert.equal(run.head_branch, "master");
  assert.equal(
    run.path.split("@")[0],
    ".github/workflows/verify-production-bootstrap.yml",
  );
  assert.equal(run.event, "workflow_dispatch");
  assert.equal(run.run_attempt, 1);
  assert.equal(run.status, "in_progress");
  assert.equal(run.conclusion, null);
  assert.ok(Number.isFinite(Date.parse(run.created_at)));
  const proof = await verifyEnvironmentApproval(
    get,
    {
      repository: "Chronote-gg/Chronote",
      runId: identity.runId,
      environment: "production",
    },
    run,
  );
  assert.equal(proof.environment.id, environmentId);
  assert.equal(proof.review.user.id, 2165323);
  return proof;
}
module.exports = { verifyAuthority };
