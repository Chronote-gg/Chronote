import { unmarshall } from "@aws-sdk/util-dynamodb";
import { createIntroductionHold } from "../../../scripts/deployment/introduction-hold.cjs";
import {
  createCoordinatorJournal,
  createProductionIntroductionJournal,
} from "../../../scripts/deployment/introduction-transitions.cjs";
import { canonicalHash } from "../../../scripts/deployment/production-manifest.cjs";
function renewalSelection(m, trigger) {
  const initial = trigger.kind === "launch_candidate";
  const phase =
    trigger.kind === "coordinator_write" &&
    (trigger.purpose === "launch" ||
      trigger.purpose === "retirement" ||
      trigger.toPhase === "promoted")
      ? trigger.toPhase
      : undefined;
  const actions =
    !initial && !phase
      ? []
      : m.actions.filter(
          (a) =>
            a.purpose === "renew" &&
            (initial
              ? a.kind === "introduction_write" && a.slot === trigger.slot
              : a.kind === "coordinator_write" &&
                a.path === trigger.path &&
                a.fromPhase === phase),
        );
  return { initial, phase, actions };
}
async function consumeRenewal(f, action, initial, phase) {
  const options = f.options;
  await options.sleep(phase === "retiring" ? 8000 : 3000);
  const current = await createIntroductionHold({
    ...options,
    table: f.m.resources.tables.deploymentControl,
  }).readState(f.binding);
  const journal = (
    initial ? createProductionIntroductionJournal : createCoordinatorJournal
  )({
    ...options,
    ...current,
    table: f.m.resources.tables.deploymentControl,
  });
  const control = await f.read({ pk: "ENV", sk: "CONTROL" });
  const context = initial
    ? { control, now: f.state.time }
    : {
        control,
        next: { ...control, coordinatorExpiresAt: f.state.time + 180 },
      };
  await journal.reserveAction(action.actionId, context);
  await journal.submitOnce(action.actionId, context);
  const next = await f.read({ pk: "ENV", sk: "CONTROL" });
  await journal.observe(
    action.actionId,
    initial
      ? {
          purpose: "renew",
          stateHash: canonicalHash(next),
          facts: { kind: "control", control: next },
        }
      : {
          epoch: next.coordinatorEpoch,
          generation: next.servingGeneration,
          phase: next.deployment.phase,
          facts: { kind: "control", control: next },
        },
  );
}
export function consumeMaximumRenewals(f) {
  const options = f.options,
    write = options.write;
  let consuming = false;
  options.write = async (input) => {
    const result = await write(input);
    const row = input.TransactItems.find(
      (i) => i.Put?.Item.phase?.S === "observed",
    )?.Put?.Item;
    if (!row || consuming) return result;
    const observed = unmarshall(row),
      trigger = f.m.actions.find((a) => a.actionId === observed.actionId);
    const { initial, phase, actions } = renewalSelection(f.m, trigger);
    if (!actions.length) return result;
    consuming = true;
    try {
      for (const action of actions) {
        if (
          await f.read({
            pk: `INTRODUCTION#${f.m.introductionId}`,
            sk: `ACTION#${action.actionId}`,
          })
        )
          continue;
        await consumeRenewal(f, action, initial, phase);
      }
    } finally {
      consuming = false;
    }
    return result;
  };
}
