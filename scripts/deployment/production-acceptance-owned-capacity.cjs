"use strict";
const { authorityFor } = require("./introduction-hold.cjs");
const { candidateSlot } = require("./production-candidate.cjs");
const { isDeepStrictEqual: same } = require("node:util");
const { z } = require("zod");
const futureText = "\u0000".repeat(1024);
function helpers() {
  return require("../../dist/services/productionAcceptanceConditions.js");
}
function refuse() {
  throw Error("acceptance_capacity_refused");
}
function capacityBound(binding, row) {
  const bound = {
    table: binding.manifest.resources.tables.deploymentControl,
    key: { pk: row.pk, sk: row.sk },
    maximumItemBytes: helpers().completeItemSizeBound(row),
  };
  helpers().assertCapacityBounds([bound]);
  return bound;
}
function futureIdentity(binding, slotName) {
  const slot = candidateSlot(binding.manifest, slotName);
  return {
    kind: "ecs",
    protocolVersion: 1,
    instanceId: `ffffffff-ffff-4fff-8fff-${String(["bootstrap", "replacement", "handoff"].indexOf(slotName) + 1).padStart(12, "0")}`,
    taskArn: futureText,
    imageDigest: slot.digest,
    candidateId: slot.candidateId,
  };
}
function longestCoordinator(binding) {
  const m = binding.manifest;
  return [
    m.handoff.priorRunToken,
    m.handoff.runToken,
    m.failedUnserved?.runToken,
  ]
    .filter(Boolean)
    .reduce(
      (longest, value) =>
        Buffer.byteLength(JSON.stringify(value)) >
        Buffer.byteLength(JSON.stringify(longest))
          ? value
          : longest,
      "",
    );
}
function futureRuntime(binding, slotName, role) {
  if (!["serving", "retired"].includes(role)) refuse();
  const types = require("../../dist/types/deploymentControl.js"),
    identity = futureIdentity(binding, slotName),
    maximum = Number.MAX_SAFE_INTEGER;
  const row = {
    pk: "ENV",
    sk: `RUNTIME#${identity.instanceId}`,
    recordType: "runtime",
    identity,
    role,
    authorizedGeneration: maximum,
    heartbeatAt: maximum,
    canonicalContentWriter: 1,
    readiness: {
      identity,
      runtimeMode: binding.manifest.runtime.mode,
      observedEpoch: maximum,
      observedGeneration: maximum,
      gatewayReady: false,
      cacheReady: false,
      dependenciesReady: false,
      provenAt: maximum,
      expiresAt: maximum,
    },
    protection: { identity, provenAt: maximum, expiresAt: maximum },
    workCounts: Object.fromEntries(
      types.RUNTIME_WORK_KINDS.map((kind) => [kind, 0]),
    ),
  };
  if (role === "retired") {
    row.retirementRequest = {
      identity,
      authorizedGeneration: maximum,
      coordinatorToken: longestCoordinator(binding),
      coordinatorEpoch: maximum,
    };
    row.retirementAcknowledgment = {
      request: row.retirementRequest,
      retiredAt: maximum,
    };
  }
  return types.runtimeRecordSchema.parse(row);
}
function runtimeCapacityEnvelope(binding, slotName, role) {
  return capacityBound(binding, futureRuntime(binding, slotName, role));
}
function futureFixtureAuthority(binding, path, priorMember) {
  if (!["normal", "replacement"].includes(path)) refuse();
  const builders = require("../../dist/services/productionIntroductionTransactions.js"),
    authority = authorityFor(binding),
    m = binding.manifest,
    epoch = path === "normal" ? m.handoff.priorEpoch : m.failedUnserved?.epoch,
    handoff = builders.effectiveHandoff(authority, epoch);
  return builders.fixtureCoordinatorAuthoritySchema.parse({
    pk: `INTRODUCTION#${m.introductionId}`,
    sk: "FIXTURE_COORDINATOR",
    recordType: "fixture_coordinator_authority",
    holdId: m.holdId,
    introductionId: m.introductionId,
    manifestHash: binding.manifestHash,
    revision: 1,
    ...Object.fromEntries(
      Object.entries(handoff).filter(
        ([key]) => !["priorCandidateId", "priorDigest"].includes(key),
      ),
    ),
    priorMember:
      priorMember ??
      futureIdentity(binding, path === "normal" ? "bootstrap" : "replacement"),
  });
}
function fixtureCoordinatorCapacityEnvelope(binding, path) {
  return capacityBound(binding, futureFixtureAuthority(binding, path));
}
function assertSafeNumbers(value) {
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0))
    refuse();
  if (value && typeof value === "object")
    Object.values(value).forEach(assertSafeNumbers);
}
function assertIdentity(binding, identity, slotName) {
  const slot = candidateSlot(binding.manifest, slotName);
  if (
    identity.kind !== "ecs" ||
    !z.uuid().safeParse(identity.instanceId).success ||
    Buffer.byteLength(identity.taskArn, "utf8") > 1024 ||
    identity.candidateId !== slot.candidateId ||
    identity.imageDigest !== slot.digest
  )
    refuse();
}
function assertSupportedRuntimeSize(binding, row, slotName, role = row.role) {
  require("../../dist/types/deploymentControl.js").runtimeRecordSchema.parse(
    row,
  );
  const m = binding.manifest;
  slotName ??= [
    "bootstrap",
    ...(m.failedUnserved ? ["replacement"] : []),
    "handoff",
  ].find(
    (name) => candidateSlot(m, name).candidateId === row.identity.candidateId,
  );
  if (!slotName || row.role !== role || row.expiresAt !== undefined) refuse();
  assertIdentity(binding, row.identity, slotName);
  assertSafeNumbers(row);
  if (
    helpers().completeItemSizeBound(row) >
    runtimeCapacityEnvelope(binding, slotName, role).maximumItemBytes
  )
    refuse();
}
function assertSupportedFixtureAuthoritySize(binding, row, path) {
  const m = binding.manifest;
  path ??= row.priorEpoch === m.handoff.priorEpoch ? "normal" : "replacement";
  assertIdentity(
    binding,
    row.priorMember,
    path === "normal" ? "bootstrap" : "replacement",
  );
  assertSafeNumbers(row);
  if (
    !same(row, futureFixtureAuthority(binding, path, row.priorMember)) ||
    helpers().completeItemSizeBound(row) >
      fixtureCoordinatorCapacityEnvelope(binding, path).maximumItemBytes
  )
    refuse();
}
module.exports = {
  runtimeCapacityEnvelope,
  fixtureCoordinatorCapacityEnvelope,
  assertSupportedRuntimeSize,
  assertSupportedFixtureAuthoritySize,
};
