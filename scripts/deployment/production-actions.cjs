"use strict";
const {
  createIntroductionJournal,
  createProductionIntroductionJournal,
} = require("./introduction-transitions.cjs");
const { createIntroductionHold } = require("./introduction-hold.cjs");
const {
  canonicalHash,
  assertBoundExecution,
} = require("./production-manifest.cjs");
function createProductionActions(options) {
  const { binding, read, now } = options,
    m = binding.manifest,
    holdApi = createIntroductionHold(options);
  const key = (id) => ({
    pk: `INTRODUCTION#${m.introductionId}`,
    sk: `ACTION#${id}`,
  });
  async function state() {
    return holdApi.readState(binding);
  }
  async function unsettled(except) {
    const j = createIntroductionJournal({ ...options, ...(await state()) });
    for (const a of m.actions) {
      const raw = await read(key(a.actionId));
      const row = raw ? await j.readAction(a.actionId) : undefined;
      if (row && row.phase !== "observed" && a.actionId !== except)
        throw Error("introduction_recovery_required");
    }
  }
  async function journal(a) {
    const current = await state();
    return (
      a.kind === "introduction_write"
        ? createProductionIntroductionJournal
        : createIntroductionJournal
    )({ ...options, ...current });
  }
  async function run(action, context, observe) {
    if (!action) throw Error("finite_action_capacity_exhausted");
    assertBoundExecution(binding, now());
    const j = await journal(action);
    let row = await read(key(action.actionId));
    if (row) {
      row = await j.readAction(action.actionId);
      if (row.phase === "submitted")
        throw Error("introduction_recovery_required");
    }
    if (row?.phase === "observed") {
      await observe();
      return row;
    }
    if (row?.phase !== "acknowledged") {
      await unsettled(action.actionId);
      await state();
      if (!row) await j.reserveAction(action.actionId, context);
      await j.submitOnce(action.actionId, context);
    }
    const value = await observe();
    return j.observe(
      action.actionId,
      action.kind === "introduction_write"
        ? {
            purpose: action.purpose,
            stateHash: canonicalHash(value),
            ...(["initialize", "promote", "replace_control", "renew"].includes(
              action.purpose,
            )
              ? { facts: { kind: "control", control: value } }
              : action.purpose === "retire_failed"
                ? { facts: { kind: "runtime", runtime: value } }
                : {}),
          }
        : value,
    );
  }
  async function consume(kind, predicate, context, observe) {
    for (const a of m.actions.filter((a) => a.kind === kind && predicate(a))) {
      const row = await read(key(a.actionId));
      if (!row || row.phase !== "observed") return run(a, context, observe);
    }
    throw Error("finite_action_capacity_exhausted");
  }
  return {
    run,
    consume,
    state,
    unsettled,
    readAction: async (a) => (await journal(a)).readAction(a.actionId),
  };
}
module.exports = { createProductionActions };
