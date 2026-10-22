import { fixture } from "./productionManifest.js";
import {
  acceptanceDeclaration,
  closingActions,
} from "./productionAcceptance.js";
import {
  coordinatorRenewals,
  introductionRenewals,
} from "../../scripts/deployment/production-capacity.cjs";
export function completeManifest() {
  const m = fixture();
  m.validUntil = 15000;
  m.acceptance = acceptanceDeclaration();
  m.failedUnserved = {
    candidateId: "repair",
    taskDefinition: m.runtime.candidateDefinition.replace(":2", ":4"),
    imageDigest: m.runtime.candidateDigest,
    runToken: "repair-run",
    expectedEpoch: 1,
    epoch: 2,
  };
  for (const [index, grant] of m.handoff.grants.entries())
    grant.grantId =
      grant.commandId = `fixture:00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
  const actions = [];
  const add = (actionId, kind, predecessor, rest = {}) =>
    actions.push({ actionId, kind, predecessor, ...rest });
  const intro = (id, purpose, slot, predecessor, rest = {}) =>
    add(id, "introduction_write", predecessor, { purpose, slot, ...rest });
  add("stop-service", "stop_service", null);
  add("maintenance", "route_maintenance", "stop-service", { targetGroup: "b" });
  intro("initialize", "initialize", "bootstrap", "maintenance");
  function branch(slot, predecessor, priorEpoch) {
    add(`${slot}-launch`, "launch_candidate", predecessor, { slot });
    for (let i = 0; i < introductionRenewals[slot]; i++)
      intro(
        `${slot}-renew${i ? `-${i}` : ""}`,
        "renew",
        slot,
        `${slot}-launch`,
      );
    intro(`${slot}-promote`, "promote", slot, `${slot}-launch`);
    add(`${slot}-route`, "route_candidate", `${slot}-promote`, {
      launchActionId: `${slot}-launch`,
      targetGroup: "a",
    });
    const authorize = `${slot}-authorize`;
    intro(authorize, "authorize_fixture", slot, `${slot}-route`);
    intro(`${slot}-fixture-0`, "enqueue_fixture", slot, authorize, {
      grantIndex: 0,
    });
    const epoch = priorEpoch + 1;
    const steps = [
      ["acquire", "none", "preparing", priorEpoch, 1],
      ["renew", "preparing", "preparing", epoch, 1],
      ["phase", "preparing", "preparing", epoch, 1],
      ["phase", "preparing", "warming", epoch, 1],
      ["launch", "warming", "warming", epoch, 1],
      ["renew", "warming", "warming", epoch, 1],
      ["phase", "warming", "promoting", epoch, 1],
      ["promote", "promoting", "promoting", epoch, 1],
      ["phase", "promoting", "promoting", epoch, 2],
      ["route", "promoting", "promoting", epoch, 2],
      ["phase", "promoting", "promoting", epoch, 2],
      ["phase", "promoting", "promoted", epoch, 2],
      ["renew", "promoted", "promoted", epoch, 2],
      ["phase", "promoted", "retiring", epoch, 2],
      ["retirement", "retiring", "retiring", epoch, 2],
      ["renew", "retiring", "retiring", epoch, 2],
      ["phase", "retiring", "retiring", epoch, 2],
      ["phase", "retiring", "complete", epoch, 2],
    ];
    let sequence = 0;
    steps.forEach(([purpose, fromPhase, toPhase, at, generation], index) => {
      if (index === 1 || index === 16) return; // Closing actions use the two optional preparing renewal slots.
      const capacity =
        purpose === "renew" ? (coordinatorRenewals[fromPhase] ?? 1) : 1;
      for (let i = 0; i < capacity; i++)
        add(
          `${slot}-c${index}${i ? `-${i}` : ""}`,
          "coordinator_write",
          authorize,
          {
            sequence: sequence++,
            path: slot === "bootstrap" ? "normal" : "replacement",
            purpose,
            fromPhase,
            toPhase,
            epoch: at,
            generation,
          },
        );
    });
    intro(
      `${slot}-fixture-1`,
      "enqueue_fixture",
      slot,
      `${slot}-c${steps.length - 1}`,
      { grantIndex: 1 },
    );
  }
  branch("bootstrap", "initialize", 1);
  intro(
    "replace-control",
    "replace_control",
    "replacement",
    "bootstrap-launch",
  );
  intro("retire-failed", "retire_failed", "replacement", "replace-control");
  add("stop-failed", "stop_failed", "retire-failed", {
    launchActionId: "bootstrap-launch",
  });
  branch("replacement", "stop-failed", 2);
  m.actions = [...actions, ...closingActions()];
  return m;
}
