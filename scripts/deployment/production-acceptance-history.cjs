"use strict";
const { isDeepStrictEqual: same } = require("node:util");
const { authorityFor } = require("./introduction-hold.cjs");
const { createRuntimeProof } = require("./runtime-proof.cjs");
function refuse() {
  throw Error("acceptance_history_prerequisite");
}
function selectedAction(action, path, manifest) {
  if (action.kind === "route_candidate") {
    const launch = manifest.actions.find(
      (entry) => entry.actionId === action.launchActionId,
    );
    if (!launch || launch.kind !== "launch_candidate") refuse();
    return launch.slot === (path === "normal" ? "bootstrap" : "replacement");
  }
  if (action.kind === "acceptance_write") return false;
  if (action.kind === "coordinator_write")
    return (action.path ?? "normal") === path;
  if (action.slot === "replacement" || action.kind === "stop_failed")
    return path === "replacement";
  if (path === "replacement" && action.slot === "bootstrap")
    return (
      ["launch_candidate"].includes(action.kind) ||
      action.purpose === "renew" ||
      action.purpose === "initialize"
    );
  return true;
}
function validateAction(row, action, authority, now) {
  const builders = require("../../dist/services/productionIntroductionTransactions.js");
  builders.introductionActionSchema.parse(row);
  for (const key of [
    "holdId",
    "introductionId",
    "manifestHash",
    "operationId",
    "revision",
    "actor",
    "runToken",
  ])
    if (!same(row[key], authority[key])) refuse();
  if (
    row.actionId !== action.actionId ||
    row.kind !== action.kind ||
    row.intentHash !== authority.actions[action.actionId].intentHash ||
    row.phase !== "observed" ||
    row.submittedAt >= authority.validUntil
  )
    refuse();
  const times = [
    row.reservedAt,
    row.submittedAt,
    row.acknowledgedAt,
    row.observedAt,
  ];
  if (
    times.some(
      (value, index) =>
        value < authority.validFrom ||
        value > now ||
        (index > 0 && value < times[index - 1]),
    )
  )
    refuse();
  if (
    !Number.isSafeInteger(row.acknowledgedAtMilliseconds) ||
    Math.floor(row.acknowledgedAtMilliseconds / 1000) !== row.acknowledgedAt
  )
    refuse();
}
function promotionFacts(row, expected, mode) {
  const facts = row.acknowledgment.facts;
  const types = require("../../dist/types/deploymentControl.js");
  if (facts?.kind !== "promotion" || !same(facts.candidate.identity, expected))
    refuse();
  const proof = createRuntimeProof({
    types,
    now: () => row.acknowledgedAt,
    diagnostic: {},
  });
  if (!proof.ready(facts.candidate, facts.control, expected, mode)) refuse();
  if (
    facts.nativeProtection.some(
      (entry) =>
        !(Date.parse(entry.expirationDate) / 1000 > row.acknowledgedAt + 120),
    )
  )
    refuse();
  return facts;
}
function exactOne(entries, predicate) {
  const found = entries.filter(({ action }) => predicate(action));
  if (found.length !== 1) refuse();
  return found[0].row;
}
function historicalRetirement(complete, fixtureAuthority, promotion) {
  const retirement = complete.observation.facts;
  if (
    retirement?.kind !== "retirement_complete" ||
    !same(retirement.runtime.identity, fixtureAuthority.priorMember) ||
    retirement.runtime.role !== "retired" ||
    !same(
      retirement.runtime.retirementAcknowledgment?.request,
      retirement.runtime.retirementRequest,
    ) ||
    !retirement.runtime.retirementAcknowledgment ||
    !retirement.runtime.workCounts ||
    Object.values(retirement.runtime.workCounts).some((count) => count !== 0)
  )
    refuse();
  const retiredAt = retirement.runtime.retirementAcknowledgment.retiredAt;
  if (retiredAt < promotion.acknowledgedAt || retiredAt > complete.observedAt)
    refuse();
  return retiredAt;
}
function historicalHandoff(entries, f) {
  const { binding, fixtureAuthority, control } = f,
    m = binding.manifest;
  const promotion = exactOne(
    entries,
    (a) => a.kind === "coordinator_write" && a.purpose === "promote",
  );
  const facts = promotionFacts(
    promotion,
    control.deployment.candidate,
    m.runtime.mode,
  );
  if (
    !same(facts.control.servingMembers, {
      [fixtureAuthority.priorMember.instanceId]: fixtureAuthority.priorMember,
    }) ||
    facts.nativeProtection.length !== 2 ||
    ![
      fixtureAuthority.priorMember.taskArn,
      facts.candidate.identity.taskArn,
    ].every((taskArn) =>
      facts.nativeProtection.some((entry) => entry.taskArn === taskArn),
    )
  )
    refuse();
  const complete = exactOne(
    entries,
    (a) => a.kind === "coordinator_write" && a.toPhase === "complete",
  );
  const retiredAt = historicalRetirement(complete, fixtureAuthority, promotion);
  const route = exactOne(
    entries,
    (a) => a.kind === "coordinator_write" && a.purpose === "route",
  );
  if (
    route.acknowledgment.facts?.kind !== "route" ||
    route.acknowledgment.facts.listenerArn !== m.resources.listenerArn ||
    route.acknowledgment.facts.targetGroupArn !== m.resources.targetGroupB ||
    route.acknowledgedAt < promotion.acknowledgedAt ||
    route.acknowledgedAt > retiredAt
  )
    refuse();
  return {
    handoffAt: new Date(promotion.acknowledgedAtMilliseconds).toISOString(),
    retiredAt,
    complete,
    promotion,
    route,
  };
}
function assertLineage(entries) {
  for (const { action, row } of entries) {
    if (action.predecessor) {
      const previous = entries.find(
        (entry) => entry.action.actionId === action.predecessor,
      )?.row;
      if (
        !previous ||
        row.predecessor?.receiptHash !== previous.observation.evidenceHash ||
        row.reservedAt < previous.observedAt
      )
        refuse();
    }
    if (
      [
        "stop_legacy",
        "stop_service",
        "stop_failed",
        "route_maintenance",
        "route_candidate",
        "launch_candidate",
      ].includes(action.kind) &&
      (!row.acknowledgment.facts || !row.observation.facts)
    )
      refuse();
  }
}
function assertInitialHistory(
  entries,
  binding,
  fixtureAuthority,
  pausedDigests,
) {
  const m = binding.manifest;
  const initialized = exactOne(entries, (a) => a.purpose === "initialize");
  const cold = initialized.acknowledgment.facts;
  if (
    cold?.kind !== "cold_exclusion" ||
    cold.scopeHash !== binding.manifestHash ||
    !same(cold.paused, pausedDigests) ||
    !same(initialized.observation.facts?.paused, pausedDigests) ||
    cold.observedAt > initialized.submittedAt ||
    cold.services[0].serviceArn !== m.runtime.serviceArn ||
    !m.runtime.legacyTaskArns.every((arn) =>
      cold.tasks.some((task) => task.taskArn === arn),
    )
  )
    refuse();
  const bootstrap = exactOne(
    entries,
    (a) => a.kind === "introduction_write" && a.purpose === "promote",
  );
  const initialPromotion = promotionFacts(
    bootstrap,
    fixtureAuthority.priorMember,
    m.runtime.mode,
  );
  if (
    initialPromotion.nativeProtection.length !== 1 ||
    initialPromotion.nativeProtection[0].taskArn !==
      fixtureAuthority.priorMember.taskArn
  )
    refuse();
}
async function readSelectedActions(m, path, authority, readers, now) {
  const entries = [];
  for (const action of m.actions) {
    const row = await readers.read({
      pk: authority.pk,
      sk: `ACTION#${action.actionId}`,
    });
    if (action.kind === "acceptance_write") continue;
    const selected = selectedAction(action, path, m);
    if (!row) {
      if (selected && action.purpose !== "renew") refuse();
      continue;
    }
    validateAction(row, action, authority, now);
    if (!selected) refuse();
    entries.push({ action, row });
  }
  return entries;
}
async function readIntroductionHistory(f, readers, now) {
  const { binding, fixtureAuthority } = f,
    m = binding.manifest;
  const originalActor = `arn:aws:sts::${m.identity.accountId}:assumed-role/${m.identity.roleArn.split(":role/")[1]}/${m.identity.sessionName}`;
  const authority = authorityFor(
    { ...binding, actor: originalActor },
    f.pausedDigests,
  );
  const actual = await readers.read({ pk: authority.pk, sk: authority.sk });
  if (!same(actual, authority)) refuse();
  const path =
    fixtureAuthority.priorEpoch === m.handoff.priorEpoch
      ? "normal"
      : "replacement";
  const entries = await readSelectedActions(m, path, authority, readers, now);
  assertLineage(entries);
  assertInitialHistory(entries, binding, fixtureAuthority, f.pausedDigests);
  const handoff = historicalHandoff(entries, f);
  return { authority, entries, ...handoff };
}
function assertFailedStop(stopped, failed, m) {
  if (
    stopped.observation.facts?.kind !== "failed_stopped" ||
    stopped.observation.facts.taskArn !== failed.runtime.identity.taskArn ||
    stopped.observation.facts.taskDefinition !==
      m.runtime.candidateDefinition ||
    failed.runtime.retirementAcknowledgment.retiredAt > stopped.submittedAt
  )
    refuse();
}
function failedRetirement(history, m) {
  const failed = exactOne(history.entries, (a) => a.purpose === "retire_failed")
    .observation.facts;
  const stopped = exactOne(history.entries, (a) => a.kind === "stop_failed");
  if (
    failed?.kind !== "runtime" ||
    failed.runtime.identity.candidateId !== m.runtime.candidateId ||
    failed.runtime.identity.imageDigest !== m.runtime.candidateDigest ||
    failed.runtime.authorizedGeneration !== 0 ||
    failed.runtime.role !== "retired" ||
    failed.runtime.retirementRequest?.coordinatorToken !==
      m.failedUnserved.runToken ||
    failed.runtime.retirementRequest?.coordinatorEpoch !==
      m.failedUnserved.epoch ||
    !same(
      failed.runtime.retirementAcknowledgment?.request,
      failed.runtime.retirementRequest,
    ) ||
    !failed.runtime.workCounts ||
    Object.values(failed.runtime.workCounts).some((n) => n !== 0)
  )
    refuse();
  assertFailedStop(stopped, failed, m);
  return failed;
}
function assertHistoricalRuntimes(history, state) {
  const { m, runtimes, fixtureAuthority } = state;
  const original = history.complete.observation.facts.runtime;
  const retired = runtimes.find((r) => same(r.identity, original.identity));
  if (
    !retired ||
    !same(retired.retirementRequest, original.retirementRequest) ||
    !same(retired.retirementAcknowledgment, original.retirementAcknowledgment)
  )
    refuse();
  if (fixtureAuthority.priorEpoch === m.handoff.priorEpoch) return;
  const failed = failedRetirement(history, m);
  const current = runtimes.find((r) =>
    same(r.identity, failed.runtime.identity),
  );
  if (
    !current ||
    !same(current.retirementRequest, failed.runtime.retirementRequest) ||
    !same(
      current.retirementAcknowledgment,
      failed.runtime.retirementAcknowledgment,
    )
  )
    refuse();
}
function verifyHistoricalCapture(f, history) {
  const capture = require("../../dist/services/productionFixtureCapture.js");
  for (const [index, fixture] of f.fixtures.entries()) {
    capture.inspectFixtureCapture({
      metadata: fixture.metadata,
      manifest: fixture.contents.manifest,
      audio: fixture.contents.audio,
      acrossHandoff: index === 0,
      handoffAt: history.handoffAt,
    });
  }
  const first = f.fixtures[0].metadata.history,
    second = f.fixtures[1].metadata.history;
  if (
    Date.parse(first.notesDeliveryTiming.completeAcknowledgedAt) >
      history.retiredAt * 1000 ||
    Date.parse(second.capture.startedAt) <= history.retiredAt * 1000 ||
    Date.parse(second.checkpoint.capture.reservedAt) <
      history.complete.observedAt * 1000 ||
    Date.parse(f.supplement.reviewedAt) <
      Date.parse(second.notesDeliveryTiming.completeAcknowledgedAt)
  )
    refuse();
}
module.exports = {
  readIntroductionHistory,
  verifyHistoricalCapture,
  assertHistoricalRuntimes,
  selectedAction,
};
