"use strict";
const {
  coordinatorRenewals,
  introductionRenewals,
} = require("./production-capacity.cjs");
const { assertBoundExecution } = require("./production-manifest.cjs");
function refuse() {
  throw Error("failure_path_prerequisite");
}
function assertCoordinatorCapacity(m, slot, authorize) {
  const path = slot === "bootstrap" ? "normal" : "replacement",
    prior = slot === "bootstrap" ? 1 : 2,
    epoch = prior + 1;
  const actions = m.actions.filter(
    (a) => a.kind === "coordinator_write" && (a.path ?? "normal") === path,
  );
  if (actions.some((a) => a.predecessor !== authorize.actionId)) refuse();
  const mandatory = [
    ["acquire", "none", "preparing", prior, 1],
    ["phase", "preparing", "preparing", epoch, 1],
    ["phase", "preparing", "warming", epoch, 1],
    ["launch", "warming", "warming", epoch, 1],
    ["phase", "warming", "promoting", epoch, 1],
    ["promote", "promoting", "promoting", epoch, 1],
    ["phase", "promoting", "promoting", epoch, 2],
    ["route", "promoting", "promoting", epoch, 2],
    ["phase", "promoting", "promoting", epoch, 2],
    ["phase", "promoting", "promoted", epoch, 2],
    ["phase", "promoted", "retiring", epoch, 2],
    ["retirement", "retiring", "retiring", epoch, 2],
    ["phase", "retiring", "complete", epoch, 2],
  ];
  const recipe = (a) => [
    a.purpose,
    a.fromPhase,
    a.toPhase,
    a.epoch,
    a.generation,
  ];
  if (
    JSON.stringify(actions.filter((a) => a.purpose !== "renew").map(recipe)) !==
    JSON.stringify(mandatory)
  )
    refuse();
  let current = ["none", prior, 1];
  for (const a of actions) {
    if (
      a.purpose === "renew" &&
      (a.fromPhase !== a.toPhase ||
        JSON.stringify([a.fromPhase, a.epoch, a.generation]) !==
          JSON.stringify(current))
    )
      refuse();
    current = [
      a.toPhase,
      a.epoch + (a.purpose === "acquire" ? 1 : 0),
      a.generation + (a.purpose === "promote" ? 1 : 0),
    ];
  }
  const required = [
    ["acquire", "none", "preparing", prior, 1, 1],
    ["phase", "preparing", "preparing", epoch, 1, 1],
    ["phase", "preparing", "warming", epoch, 1, 1],
    ["launch", "warming", "warming", epoch, 1, 1],
    ["renew", "warming", "warming", epoch, 1, coordinatorRenewals.warming],
    ["phase", "warming", "promoting", epoch, 1, 1],
    ["promote", "promoting", "promoting", epoch, 1, 1],
    ["phase", "promoting", "promoting", epoch, 2, 2],
    ["route", "promoting", "promoting", epoch, 2, 1],
    ["phase", "promoting", "promoted", epoch, 2, 1],
    ["renew", "promoted", "promoted", epoch, 2, 1],
    ["phase", "promoted", "retiring", epoch, 2, 1],
    ["retirement", "retiring", "retiring", epoch, 2, 1],
    ["renew", "retiring", "retiring", epoch, 2, coordinatorRenewals.retiring],
    ["phase", "retiring", "complete", epoch, 2, 1],
  ];
  for (const [
    purpose,
    fromPhase,
    toPhase,
    expectedEpoch,
    generation,
    count,
  ] of required)
    if (
      actions.filter(
        (a) =>
          a.purpose === purpose &&
          a.fromPhase === fromPhase &&
          a.toPhase === toPhase &&
          a.epoch === expectedEpoch &&
          a.generation === generation,
      ).length < count
    )
      refuse();
}
function assertIntroductionPredecessors(m, one) {
  const intro = (purpose, slot) =>
    one("introduction_write", (a) => a.purpose === purpose && a.slot === slot);
  const expect = (action, predecessor) => {
    if (action.predecessor !== (predecessor?.actionId ?? null)) refuse();
  };
  const stop = one("stop_service"),
    maintenance = one("route_maintenance"),
    initial = intro("initialize", "bootstrap"),
    repair = intro("replace_control", "replacement"),
    retirement = intro("retire_failed", "replacement"),
    failedStop = one("stop_failed");
  expect(stop, null);
  expect(maintenance, stop);
  expect(initial, maintenance);
  expect(
    repair,
    one("launch_candidate", (a) => a.slot === "bootstrap"),
  );
  expect(retirement, repair);
  expect(failedStop, retirement);
  for (const slot of ["bootstrap", "replacement"]) {
    const launch = one("launch_candidate", (a) => a.slot === slot),
      promotion = intro("promote", slot),
      route = one(
        "route_candidate",
        (a) => a.launchActionId === launch.actionId,
      ),
      authorize = intro("authorize_fixture", slot),
      complete = one(
        "coordinator_write",
        (a) =>
          (a.path ?? "normal") ===
            (slot === "bootstrap" ? "normal" : "replacement") &&
          a.toPhase === "complete",
      );
    expect(launch, slot === "bootstrap" ? initial : failedStop);
    expect(promotion, launch);
    expect(route, promotion);
    expect(authorize, route);
    for (const action of m.actions.filter(
      (a) => a.kind === "introduction_write" && a.slot === slot,
    )) {
      if (action.purpose === "renew") expect(action, launch);
      if (action.purpose === "enqueue_fixture")
        expect(action, action.grantIndex === 0 ? authorize : complete);
    }
  }
}
function assertProductionPreflight(binding, now = binding.manifest.validFrom) {
  if (!binding.manifest.acceptance) refuse();
  const m = assertBoundExecution(binding, now);
  require("./production-content-policy.cjs").contentPreflight(m);
  const one = (kind, predicate = () => true) => {
    const entries = m.actions.filter((a) => a.kind === kind && predicate(a));
    if (entries.length !== 1) refuse();
    return entries[0];
  };
  if (
    !m.failedUnserved ||
    m.actions.some((a) =>
      ["hold_launcher", "restore_launcher"].includes(a.kind),
    )
  )
    refuse();
  one("stop_service");
  one("route_maintenance", (a) => a.targetGroup === "b");
  one("stop_failed");
  for (const purpose of ["initialize", "replace_control", "retire_failed"])
    one("introduction_write", (a) => a.purpose === purpose);
  for (const grant of m.handoff.grants)
    if (
      grant.grantId !== grant.commandId ||
      !/^fixture:[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
        grant.grantId,
      )
    )
      refuse();
  for (const slot of ["bootstrap", "replacement"]) {
    const launch = one("launch_candidate", (a) => a.slot === slot);
    one(
      "route_candidate",
      (a) => a.launchActionId === launch.actionId && a.targetGroup === "a",
    );
    one(
      "introduction_write",
      (a) => a.purpose === "promote" && a.slot === slot,
    );
    const authorize = one(
      "introduction_write",
      (a) => a.purpose === "authorize_fixture" && a.slot === slot,
    );
    for (const index of [0, 1])
      one(
        "introduction_write",
        (a) =>
          a.purpose === "enqueue_fixture" &&
          a.slot === slot &&
          a.grantIndex === index,
      );
    if (
      m.actions.filter(
        (a) =>
          a.kind === "introduction_write" &&
          a.purpose === "renew" &&
          a.slot === slot,
      ).length < introductionRenewals[slot]
    )
      refuse();
    assertCoordinatorCapacity(m, slot, authorize);
  }
  assertIntroductionPredecessors(m, one);
  return m;
}
module.exports = { assertProductionPreflight };
