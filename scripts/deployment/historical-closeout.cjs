"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { bindingHash, continuationBinding } = require("./continue-sandbox.cjs");
const { configuration } = require("./coordinator.cjs");
const { createSourceLossInspection } = require("./source-loss-inspection.cjs");
const { createServiceEventProof } = require("./service-event-stop-proof.cjs");
const { receiptSchema } = require("./source-loss-state.cjs");
const {
  createSourceLossPublication,
} = require("./source-loss-publication.cjs");
const { createArtifactHandoff } = require("./artifact-handoff.cjs");
const {
  buildHistoricalCloseout,
  recordSubmission,
  observeHistoricalCloseout,
} = require("./historical-closeout-state.cjs");

async function historicalCloseout(options) {
  const { aws, env, packet, mode } = options;
  const types =
    options.types ?? require("../../dist/types/deploymentControl.js");
  const builders =
    options.builders ??
    require("../../dist/services/deploymentControlTransactions.js");
  const artifactTypes = require("../../dist/types/artifactSafety.js");
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const config = configuration(env),
    table = config.tablePrefix + "DeploymentControlTable";
  const inspector = createSourceLossInspection({
    aws,
    env,
    config,
    types,
    now,
    terminalProof: createServiceEventProof({ packet, now }),
    policy: { billingFlags: packet.billingFlags },
  });
  if (mode === "observe") {
    const submission = JSON.parse(
      fs.readFileSync(packet.closeout.submissionFile, "utf8"),
    );
    return observeHistoricalCloseout({
      read: inspector.read,
      submission,
      packet,
      types,
      bindingSha256: options.bindingSha256,
    });
  }
  assert(
    packet.closeout.approveBefore > now() &&
      packet.closeout.approveBefore <= now() + 3600,
    "Closeout approval expired or unbounded",
  );
  const observed = await inspectHistoricalCloseout({
    inspector,
    packet,
    types,
    artifactTypes,
    options,
    config,
    table,
    now,
  });
  const bindingSha256 = bindingHash(observed.binding);
  if (mode === "inspect")
    return { kind: "inspection", binding: observed.binding, bindingSha256 };
  assert.equal(bindingSha256, options.bindingSha256);
  const claim = buildHistoricalCloseout({
    table,
    observed,
    packet,
    bindingSha256,
    types,
    builders,
    now: now(),
  });
  const submission = {
    packetSha256: bindingHash(packet),
    transactionSha256: bindingHash(claim.transaction),
    transaction: claim.transaction,
    next: claim.next,
    receipt: claim.receipt,
  };
  recordSubmission(packet.closeout.submissionFile, submission);
  assert(
    packet.closeout.approveBefore > now(),
    "Closeout approval expired before submission; retain journal",
  );
  try {
    await aws("dynamodb", "transact-write-items", claim.transaction);
  } catch {
    /* The durable submission remains uncertain until exact readback, never replay. */
  }
  try {
    return await observeHistoricalCloseout({
      read: inspector.read,
      submission,
      packet,
      types,
      bindingSha256,
    });
  } catch {
    throw new Error(
      "Historical closeout outcome held; retain submission and writer exclusion, observe without resubmitting",
    );
  }
}
async function inspectHistoricalCloseout({
  inspector,
  packet,
  types,
  artifactTypes,
  options,
  table,
  now,
}) {
  const { read, control, runtime, proof, native, routing } = inspector;
  const ctl = await control(),
    d = ctl.deployment,
    candidate = d.candidate;
  assert.equal(bindingHash(ctl), packet.closeout.controlSha256);
  assert.deepEqual(continuationBinding(ctl, candidate), packet.operation);
  assert.equal(ctl.runtimeEnvironment, "ecs");
  assert.equal(ctl.coordinatorToken, d.runToken);
  assert.equal(d.phase, "promoted");
  assert.equal(d.routing.state, "candidate");
  assert(ctl.coordinatorExpiresAt <= now());
  assert(!ctl.maintenance);
  const historicalReplacement = inspectHistoricalReplacement(
    ctl,
    packet,
    types,
  );
  assert.equal(ctl.servingGeneration, d.originalGeneration + 1);
  assert.deepEqual(Object.values(ctl.servingMembers), [candidate]);
  assert.deepEqual(d.originalMembers, [d.outgoing]);
  assert.notEqual(candidate.instanceId, d.outgoing.instanceId);
  assert.equal(
    await read("HISTORICALCLOSEOUT#" + packet.closeout.operationId, "RECEIPT"),
    undefined,
    "Closeout already consumed",
  );
  const recovery = receiptSchema(types).parse(
    await read("SOURCELOSS#" + d.runToken, "RECOVERY"),
  );
  assert.equal(recovery.version, 3);
  assert.equal(recovery.runToken, d.runToken);
  assert.equal(recovery.pk, "SOURCELOSS#" + d.runToken);
  assert.equal(recovery.stage, "availability_restored");
  assert.equal(bindingHash(recovery), packet.closeout.recoverySha256);
  assert.deepEqual(recovery.source, d.outgoing);
  assert.deepEqual(recovery.candidate, candidate);
  const sourceRuntime = await runtime(d.outgoing),
    candidateRuntime = await runtime(candidate);
  assert.equal(bindingHash(sourceRuntime), packet.closeout.sourceRuntimeSha256);
  assert.equal(sourceRuntime.role, "serving");
  assert.equal(sourceRuntime.authorizedGeneration, d.originalGeneration);
  assert(sourceRuntime.workCounts);
  assert.equal(candidateRuntime.role, "serving");
  assert.equal(candidateRuntime.authorizedGeneration, ctl.servingGeneration);
  for (const row of [sourceRuntime, candidateRuntime])
    assert(
      !row.retirementRequest &&
        !row.retirementAcknowledgment &&
        !row.retirementContinuation,
    );
  assert(proof.ready(candidateRuntime, ctl, candidate, d.runtimeMode));
  assert(candidateRuntime.heartbeatAt > recovery.admittedAt);
  assert(
    candidateRuntime.workCounts &&
      Object.values(candidateRuntime.workCounts).every((count) => count === 0),
  );
  const artifacts = createArtifactHandoff({
    aws: options.aws,
    tables: { deploymentControl: table },
    now,
    runtime,
    control,
    production: true,
  });
  const sourceArtifact = await artifacts.committed(ctl);
  assert(!sourceArtifact.retirementVerification);
  const artifact = artifactTypes.artifactSafetyRecordSchema.parse(
    await read("ENV", artifactTypes.artifactSafetyKey(candidate).sk),
  );
  assert.deepEqual(artifact.identity, candidate);
  assert.equal(artifact.state, "idle");
  assert.equal(artifact.startup.kind, "active");
  assert(!artifact.attestation && artifact.freshUntil > now() + 5);
  // Recovery reserved its transition before admission moved membership to the candidate.
  const publicationOriginal = {
    ...ctl,
    servingMembers: Object.fromEntries(
      d.originalMembers.map((member) => [member.instanceId, member]),
    ),
  };
  const publication = createSourceLossPublication(
    publicationOriginal,
    options.publicationReleases ??
      require("../operator/recovery-publication-releases.json"),
  ).binding(ctl);
  const terminal = await native(ctl, candidate);
  const nativeProtection = {
    taskArn: candidate.taskArn,
    observedAt: now(),
    expiresAt: terminal.nativeProtectionExpiresAt,
  };
  assert.deepEqual(terminal.terminalProof, recovery.terminalProof);
  assert.equal(terminal.candidateRevision, d.routing.candidateRevision);
  await routing.assertAction(d.routing, true);
  const introduction = await read("ENV", "INTRODUCTION");
  assert(
    !introduction ||
      (introduction.pk === "ENV" &&
        introduction.sk === "INTRODUCTION" &&
        introduction.deployment?.state === "released"),
  );
  assert.deepEqual(await control(), ctl);
  const binding = {
    kind: "production_historical_handoff_closeout",
    packetSha256: bindingHash(packet),
    control: ctl,
    sourceRuntimeSha256: bindingHash(sourceRuntime),
    recoverySha256: bindingHash(recovery),
    sourceArtifactSha256: bindingHash(sourceArtifact),
    selectedArtifact: {
      identity: artifact.identity,
      state: artifact.state,
      startup: artifact.startup,
    },
    publication,
    terminalProof: terminal.terminalProof,
    candidateRevision: terminal.candidateRevision,
    billingFlags: terminal.billingFlags,
    introduction: introduction ?? null,
    ...(historicalReplacement ? { historicalReplacement } : {}),
  };
  return {
    control: ctl,
    nativeProtection,
    sourceRuntime,
    candidateRuntime,
    recovery,
    candidate,
    artifact,
    sourceArtifact,
    introduction,
    binding,
  };
}
function inspectHistoricalReplacement(ctl, packet, types) {
  const marker = ctl.compatibleReplacement;
  const witness = packet.closeout.historicalReplacement;
  if (!marker) {
    assert(!witness, "Historical witness requires a marker");
    return undefined;
  }
  assert(witness, "Historical marker requires an approved capture witness");
  const successor = types.controlRecordSchema.parse(witness.successorControl);
  const prior = successor.deployment;
  const current = ctl.deployment;
  assert.equal(bindingHash(successor), witness.successorControlSha256);
  assert.equal(successor.runtimeEnvironment, "ecs");
  assert(!successor.maintenance && prior?.phase === "promoted");
  assert.equal(prior.routing?.state, "candidate");
  assert.equal(successor.coordinatorToken, prior.runToken);
  assert(successor.coordinatorEpoch < ctl.coordinatorEpoch);
  assert.notEqual(prior.runToken, current.runToken);
  assert.equal(successor.servingGeneration, prior.originalGeneration + 1);
  assert.equal(successor.servingGeneration, current.originalGeneration);
  assert.deepEqual(Object.values(successor.servingMembers), [prior.candidate]);
  assert.deepEqual(prior.originalMembers, [prior.outgoing]);
  assert.deepEqual(
    successor.servingMembers,
    Object.fromEntries(current.originalMembers.map((m) => [m.instanceId, m])),
  );
  assert.deepEqual(prior.candidate, current.outgoing);
  assert.deepEqual(successor.compatibleReplacement, marker);
  assert(marker.servingGeneration < prior.originalGeneration);
  assert.notEqual(marker.runToken, prior.runToken);
  assert.notEqual(marker.runToken, current.runToken);
  const selected = [
    ...Object.values(successor.servingMembers),
    ...Object.values(ctl.servingMembers),
  ];
  assert(Object.keys(marker.servingMembers).length > 0);
  for (const [id, member] of Object.entries(marker.servingMembers)) {
    assert(member.kind === "ecs" && id === member.instanceId);
    assert(
      selected.every(
        (m) => m.instanceId !== id && m.taskArn !== member.taskArn,
      ),
    );
  }
  // The operator accepts capture provenance; digests and the adjacent acknowledgement do not authenticate it.
  return {
    ...witness,
    successorControl: successor,
    treatment: "preserved_non_authoritative_history",
  };
}
module.exports = { historicalCloseout };
