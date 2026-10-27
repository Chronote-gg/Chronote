"use strict";
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { unzipSync } = require("fflate");
const {
  canonicalHash,
  assertBoundExecution,
} = require("./production-manifest.cjs");
const { createPreparationCapture } = require("./private-capture.cjs");
const c = require("./production-paused-contract.cjs");
const exec = promisify(execFile),
  preparations = new WeakMap();
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
function refuse() {
  throw Error("paused_preparation_prerequisite");
}
function readDraftBinding(binding) {
  const now = Math.floor(Date.now() / 1000);
  try {
    const manifest = assertBoundExecution(binding, now);
    return {
      manifest,
      manifestHash: canonicalHash(manifest),
      actor: binding.actor,
      purpose: "introduction",
    };
  } catch {
    const value =
      require("./production-private-package.cjs").readCollectionBinding(
        binding,
      );
    return { ...value, purpose: "collector" };
  }
}
function readAuthenticatedPausedPreparation(token) {
  const value = preparations.get(token),
    now = Math.floor(Date.now() / 1000);
  if (!value || now < value.request.validFrom || now >= value.validUntil)
    refuse();
  const binding = readDraftBinding(value.binding);
  if (
    binding.manifestHash !== value.manifestHash ||
    binding.purpose !== value.purpose ||
    binding.actor !== value.sessionActor
  )
    refuse();
  const view = { ...value };
  delete view.binding;
  return structuredClone(view);
}
async function artifactArchive(p, metadata, token) {
  assert.equal(metadata.id, Number(p.artifactId));
  assert.equal(metadata.name, "paused-draft-preparation");
  assert.equal(metadata.expired, false);
  assert.equal(metadata.workflow_run?.id, Number(p.runId));
  assert.equal(metadata.workflow_run?.head_sha, p.sourceCommit);
  assert.ok(
    Number.isSafeInteger(metadata.size_in_bytes) &&
      metadata.size_in_bytes > 0 &&
      metadata.size_in_bytes <= 262144,
  );
  const response = await exec(
    "gh",
    ["api", `repos/${p.repository}/actions/artifacts/${p.artifactId}/zip`],
    {
      env: { ...process.env, GH_TOKEN: token },
      encoding: "buffer",
      maxBuffer: 262144,
      timeout: 30000,
    },
  );
  const archive = Buffer.from(response.stdout);
  assert.equal(archive.length, metadata.size_in_bytes);
  assert.equal(metadata.digest, `sha256:${digest(archive)}`);
  const files = unzipSync(archive, {
    filter: (file) => {
      assert.equal(file.name, "preparation.json");
      assert.ok(file.originalSize > 0 && file.originalSize <= 262144);
      return true;
    },
  });
  assert.deepEqual(Object.keys(files), ["preparation.json"]);
  return c.artifactSchema.parse(
    JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        files["preparation.json"],
      ),
    ),
  );
}
async function authenticateOriginalPausedPreparation(
  binding,
  evidence,
  githubToken,
  operationsToken = process.env.INTRODUCTION_OPS_READ_TOKEN,
) {
  try {
    const view = readDraftBinding(binding),
      m = view.manifest,
      now = Math.floor(Date.now() / 1000);
    assert.equal(
      canonicalHash(evidence.retainedDisposition),
      m.prerequisites.retainedDisposition,
    );
    const d = c.declarationSchema.parse(
        evidence.retainedDisposition.pausedDesktopDrafts,
      ),
      p = d.preparation;
    assert.deepEqual(d.scope, c.scopeFor(m));
    assert.equal(p.sourceCommit, m.identity.sourceCommit);
    assert.equal(p.repository, m.identity.repository);
    assert.ok(
      p.validFrom <= m.validFrom &&
        p.validUntil >= m.validUntil &&
        now >= p.validFrom &&
        now < p.validUntil,
    );
    const producer = require("./production-paused-preparation.cjs");
    const request = await producer.loadPreparationRequest(
      m.operationId,
      d.request.commit,
      d.request.sha256,
      operationsToken,
    );
    assert.deepEqual(request.scope, d.scope);
    assert.deepEqual(request.cohort, d.cohort);
    assert.deepEqual(request.storeBinding, d.storeBinding);
    assert.equal(request.validFrom, p.validFrom);
    assert.equal(request.validUntil, p.validUntil);
    assert.ok(d.storeBinding.retentionUntil >= m.validUntil);
    const namespace = `production-introduction-preparation/${m.operationId}/${p.sourceCommit}`;
    assert.equal(d.capture.storeId, request.storeBinding.storeId);
    assert.equal(d.capture.namespace, namespace);
    assert.equal(d.capture.key, namespace + "/" + d.capture.sha256);
    const github = require("./production-private-package.cjs").githubJson,
      base = `repos/${p.repository}/actions`;
    const run = await github(
      `${base}/runs/${p.runId}`,
      "{id,status,head_sha,head_branch,conclusion,run_attempt,repository:.repository.full_name,repositoryId:(.repository.id|tostring),repositoryOwnerId:(.repository.owner.id|tostring),path,event,actorId:(.actor.id|tostring)}",
      githubToken,
    );
    assert.equal(String(run.id), p.runId);
    assert.equal(run.status, "completed");
    assert.equal(run.head_sha, p.sourceCommit);
    assert.equal(run.head_branch, "master");
    assert.equal(run.conclusion, "success");
    assert.equal(String(run.run_attempt), p.runAttempt);
    assert.equal(run.repository, p.repository);
    assert.equal(run.repositoryId, p.repositoryId);
    assert.equal(run.repositoryOwnerId, p.repositoryOwnerId);
    assert.equal(run.path, p.workflow);
    assert.equal(run.event, "workflow_dispatch");
    assert.equal(run.actorId, p.actorId);
    const jobs = await github(
      `${base}/runs/${p.runId}/attempts/${p.runAttempt}/jobs?per_page=100`,
      "{total_count,jobs:[.jobs[]|{name,status,conclusion,head_sha}]}",
      githubToken,
    );
    assert.equal(jobs.total_count, jobs.jobs.length);
    assert.equal(jobs.jobs.length, 1);
    assert.deepEqual(jobs.jobs[0], {
      name: p.jobName,
      status: "completed",
      head_sha: p.sourceCommit,
      conclusion: "success",
    });
    const artifact = await artifactArchive(
      p,
      await github(`${base}/artifacts/${p.artifactId}`, ".", githubToken),
      githubToken,
    );
    const capture = c.assertCapture(
      await createPreparationCapture({
        preparation: c.preparationIdentity(request),
        binding: d.storeBinding,
      }).readCapture(d.capture),
      request,
    );
    assert.deepEqual(
      producer.sanitizedPreparation(capture.preparation),
      producer.sanitizedPreparation(p),
    );
    assert.equal(
      capture.preparation.sessionArn,
      `arn:aws:sts::${m.identity.accountId}:assumed-role/${request.preparationRoleArn.split(":role/")[1]}/paused-preparation-${p.runId}-1`,
    );
    assert.deepEqual(
      artifact,
      producer.receiptFor(request, d.capture, capture.preparation),
    );
    assert.deepEqual(readDraftBinding(binding), view);
    const token = Object.freeze({});
    preparations.set(token, {
      binding,
      declaration: d,
      request,
      capture,
      manifestHash: view.manifestHash,
      purpose: view.purpose,
      sessionActor: view.actor,
      actor: p.actorId,
      validUntil: Math.min(m.validUntil, p.validUntil),
    });
    return token;
  } catch {
    return refuse();
  }
}
module.exports = {
  pausedDesktopDraftsSchema: c.declarationSchema,
  authenticateOriginalPausedPreparation,
  readAuthenticatedPausedPreparation,
  readDraftBinding,
};
