"use strict";
const assert = require("node:assert/strict");
const {
  renderCollector,
  verifyCollectorRequest,
  captureNamespace,
} = require("./collector-command.cjs");
const { randomUUID } = require("node:crypto");
const { buildProbeRequests } = require("./maintenance-probe.cjs");
const {
  scanProductionWork,
  assertProductionDrain,
  metadataDigest,
  classifyProductionWork,
} = require("./production-work.cjs");
function normalize(value) {
  if (Array.isArray(value))
    return value
      .map(normalize)
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, normalize(value[k])]),
    );
  return value;
}
function stateDigest(value) {
  return metadataDigest(normalize(value));
}
function assertDigest(value) {
  assert.match(value, /^[a-f0-9]{64}$/);
}
function assertFresh(proof, now, maxAge) {
  assert.ok(
    Number.isFinite(proof.observedAt) && Number.isFinite(proof.validUntil),
  );
  assert.ok(
    proof.observedAt <= now &&
      now - proof.observedAt <= maxAge &&
      proof.validUntil > now,
    "Stale observation",
  );
}
function assertInventory(m, proof, context) {
  for (const key of [
    "tasks",
    "owners",
    "policies",
    "controllers",
    "knownWriters",
  ])
    assert.equal(
      proof.complete[key],
      true,
      "Incomplete producer/owner inventory",
    );
  assert.equal(
    proof.policies.unrelatedSha256,
    m.originalPolicySha256,
    "Original policy changed",
  );
  assert.equal(
    proof.policies.ownedSha256,
    context.owned ? m.ownedPolicySha256 : null,
    "Owned policy changed",
  );
  assert.deepEqual(proof.controllers, [], "Unsupported controller");
  assert.equal(
    proof.controllerSha256,
    context.taskDefinition === m.legacyTaskDefinition
      ? m.originalControllerSha256
      : m.targetControllerSha256,
  );
  assert.equal(proof.knownWriterSha256, m.knownWriterSha256);
  assertDigest(proof.freezeEvidenceSha256);
  assertDigest(proof.effectsEvidenceSha256);
  assert.ok(
    Array.isArray(proof.owners) &&
      new Set(proof.owners).size === proof.owners.length,
  );
  const tasks = proof.tasks.filter((t) => t.lastStatus !== "STOPPED");
  if (context.stopped || context.failedCandidate) {
    assert.equal(tasks.length, 0, "Replacement task remains");
    const legacy = proof.tasks.filter((t) => t.taskArn === context.taskArn);
    assert.equal(legacy.length, 1);
    assert.deepEqual(legacy[0], {
      taskArn: context.taskArn,
      taskDefinitionArn: context.taskDefinition,
      sourceSha: context.sourceSha,
      lastStatus: "STOPPED",
    });
    assert.deepEqual(proof.owners, []);
    return;
  }
  assert.equal(tasks.length, 1, "Unexpected task inventory");
  assert.deepEqual(tasks[0], {
    taskArn: context.taskArn,
    taskDefinitionArn: context.taskDefinition,
    sourceSha: context.sourceSha,
    lastStatus: "RUNNING",
  });
}
function assertProbes(proof, owned) {
  for (const key of ["meetingAcquire", "uploadClaim"])
    assert.equal(
      proof.probes[key],
      owned ? "iam_denied" : "condition_refused",
      "Principal refusal/authorization unproved",
    );
  for (const key of [
    "uploadRenew",
    "uploadProgress",
    "meetingRelease",
    "meetingRenew",
  ])
    assert.equal(
      proof.probes[key],
      "condition_refused",
      "Preserved operation authorization unproved",
    );
}
function createEvidenceCollector({ m, aws, probe, now, manifestSha256 }) {
  const used = new Set();
  async function retain(value) {
    assert.ok(
      probe.capture && probe.readCapture,
      "Trusted durable capture unavailable",
    );
    const serialized = JSON.stringify(value),
      expected = metadataDigest(value);
    const reference = await probe.capture(JSON.parse(serialized));
    assertFresh(value.proof, now(), m.observationMaxAgeSeconds);
    assert.equal(reference.storeId, m.evidenceStoreId);
    assert.equal(reference.namespace, captureNamespace(m, manifestSha256));
    assert.equal(reference.sha256, expected);
    assert.equal(reference.size, Buffer.byteLength(serialized));
    assert.ok(
      typeof reference.key === "string" &&
        reference.key.length > 0 &&
        reference.key.length <= 512,
    );
    assert.ok(
      Buffer.byteLength(JSON.stringify(reference)) <= 2048,
      "Oversized capture reference",
    );
    const captured = await probe.readCapture(reference);
    assertFresh(value.proof, now(), m.observationMaxAgeSeconds);
    assert.equal(
      metadataDigest(captured),
      expected,
      "Capture read-back changed",
    );
    return reference;
  }
  async function readRetained(reference) {
    assert.ok(reference);
    assert.equal(reference.storeId, m.evidenceStoreId);
    assert.equal(reference.namespace, captureNamespace(m, manifestSha256));
    const value = await probe.readCapture(reference);
    assert.equal(metadataDigest(value), reference.sha256);
    assert.equal(Buffer.byteLength(JSON.stringify(value)), reference.size);
    return value;
  }
  async function priorProof(reference) {
    assert.ok(reference, "Missing pre-shutdown proof");
    assert.equal(reference.storeId, m.evidenceStoreId);
    assert.equal(reference.namespace, captureNamespace(m, manifestSha256));
    const previous = await probe.readCapture(reference);
    assert.equal(metadataDigest(previous), reference.sha256);
    assert.equal(Buffer.byteLength(JSON.stringify(previous)), reference.size);
    const request = previous.proof.request;
    verifyCollectorRequest(m, request);
    assert.equal(request.operationId, m.binding.operationId);
    assert.equal(request.manifestSha256, manifestSha256);
    assert.equal(request.taskArn, m.legacyTaskArn);
    assert.equal(request.taskDefinition, m.legacyTaskDefinition);
    assert.equal(request.sourceSha, m.binding.legacySha);
    assert.equal(request.roleArn, m.binding.taskRoleArn);
    assert.equal(
      request.commandTemplateSha256,
      m.collectorCommandTemplateSha256,
    );
    assert.equal(
      request.probeRequestsSha256,
      metadataDigest(buildProbeRequests(m.binding)),
    );
    assertFresh(previous.proof, now(), m.observationMaxAgeSeconds);
    assertProbes(previous.proof, true);
    assertInventory(m, previous.proof, {
      owned: true,
      taskArn: m.legacyTaskArn,
      taskDefinition: m.legacyTaskDefinition,
      sourceSha: m.binding.legacySha,
    });
    return previous;
  }
  async function round(context) {
    assert.ok(
      probe && probe.capture && probe.readCapture,
      "Trusted evidence collector unavailable",
    );
    const snapshot = await scanProductionWork(aws, {
      binding: m.binding,
      observedAt: now(),
      owners: [],
      maxPages: m.maxPages,
      maxRows: m.maxRows,
      pageSize: m.pageSize,
    });
    const base = {
      ...(context.phase ? { phase: context.phase } : {}),
      compatibilityTarget: context.compatibilityTarget ?? {
        taskDefinition: m.taskDefinition,
        sourceSha: m.binding.sourceSha,
        digest: m.binding.candidateDigest,
      },
      validUntil: Math.min(context.validUntil ?? m.validUntil, m.validUntil),
      operationId: m.binding.operationId,
      manifestSha256,
      taskArn: context.taskArn,
      taskDefinition: context.taskDefinition,
      sourceSha: context.sourceSha,
      roleArn: m.binding.taskRoleArn,
      probeRequestsSha256: metadataDigest(buildProbeRequests(m.binding)),
      predecessorSha256: context.predecessorSha256,
      nonce: randomUUID(),
      snapshotSha256: metadataDigest(snapshot),
    };
    const request = renderCollector(m, base).request;
    const proof = await probe(
      JSON.parse(JSON.stringify(request)),
      JSON.parse(JSON.stringify(snapshot)),
    );
    assert.deepEqual(proof.request, request, "Foreign or reused observation");
    assert.ok(!used.has(proof.request.nonce), "Reused observation");
    used.add(proof.request.nonce);
    assertFresh(proof, now(), m.observationMaxAgeSeconds);
    assert.ok(
      proof.validUntil <= request.validUntil,
      "Observation exceeds native validity",
    );
    assert.ok(
      proof.observedAt >= snapshot.observedAt,
      "Observation predates snapshot",
    );
    assert.deepEqual(
      proof.compatibilityTarget,
      request.compatibilityTarget,
      "Unproved target compatibility",
    );
    assertInventory(m, proof, context);
    if (context.stopped || context.failedCandidate) {
      const previous = await priorProof(context.priorCapture);
      assert.ok(
        proof.validUntil <=
          Math.min(
            previous.proof.validUntil,
            previous.proof.observedAt + m.observationMaxAgeSeconds,
          ),
        "Observation exceeds legacy handoff validity",
      );
      assert.equal(proof.probes, null);
      assert.deepEqual(proof.policies, previous.proof.policies);
    } else assertProbes(proof, context.owned);
    snapshot.owners = proof.owners;
    snapshot.settlements = proof.settlements;
    classifyProductionWork(snapshot, proof.compatibility);
    const result = {
      snapshot,
      handoffCapture: context.priorCapture ?? null,
      proof,
      stateSha256: stateDigest({
        binding: m.binding,
        tables: snapshot.tables,
        owners: proof.owners,
        tasks: proof.tasks,
        policies: proof.policies,
        controllers: proof.controllers,
        controllerSha256: proof.controllerSha256,
        knownWriterSha256: proof.knownWriterSha256,
        freezeEvidenceSha256: proof.freezeEvidenceSha256,
        effectsEvidenceSha256: proof.effectsEvidenceSha256,
        settlements: proof.settlements,
        compatibility: proof.compatibility,
      }),
    };
    return { ...result, capture: await retain(result) };
  }
  async function drain(context) {
    const before = await round(context),
      after = await round(context);
    assert.equal(
      before.stateSha256,
      after.stateSha256,
      "Observation state changed",
    );
    const barrier = {
      binding: m.binding,
      evidenceId: metadataDigest([before, after]),
      admission: "closed",
      effects: "settled",
      owners: after.proof.owners,
      fencedAt: before.snapshot.observedAt,
      checkedAt: after.proof.observedAt,
      validUntil: Math.min(before.proof.validUntil, after.proof.validUntil),
      revisionBefore: before.stateSha256,
      revisionAfter: after.stateSha256,
    };
    assertProductionDrain(
      {
        snapshot: after.snapshot,
        compatibility: after.proof.compatibility,
        barrier,
        now: now(),
      },
      m.binding,
    );
    return { rounds: [before, after], ...barrier };
  }
  return { round, drain, readRetained };
}
module.exports = { createEvidenceCollector, stateDigest };
