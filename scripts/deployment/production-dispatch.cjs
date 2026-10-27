"use strict";
const { isDeepStrictEqual } = require("node:util");
const { assertBoundExecution } = require("./production-manifest.cjs");
const { createIntroductionHold } = require("./introduction-hold.cjs");
const { LEASE_SECONDS } = require("./production-capacity.cjs");
function refuse() {
  throw Error("dispatch_authority_expired_or_changed");
}
function leaseSlot(a) {
  if (a.kind === "launch_candidate") return a.slot;
  if (a.kind === "stop_failed") return "replacement";
  if (
    a.kind === "introduction_write" &&
    ["renew", "retire_failed", "promote"].includes(a.purpose)
  )
    return a.slot;
}
function assertUnservedLease(m, slot, ctl) {
  const expected =
    slot === "bootstrap"
      ? { token: m.handoff.priorRunToken, epoch: 1 }
      : { token: m.failedUnserved.runToken, epoch: m.failedUnserved.epoch };
  if (
    !ctl ||
    ctl.coordinatorToken !== expected.token ||
    ctl.coordinatorEpoch !== expected.epoch ||
    ctl.servingGeneration !== 0 ||
    Object.keys(ctl.servingMembers).length ||
    ctl.deployment
  )
    refuse();
}
function nextDeadline(action, context) {
  return (
    context?.next?.coordinatorExpiresAt ??
    (action.purpose === "initialize"
      ? context.control.coordinatorExpiresAt
      : ["replace_control", "renew", "enqueue_fixture"].includes(action.purpose)
        ? context.now + LEASE_SECONDS
        : undefined)
  );
}
// Read current authority after submitted persistence. Return only a synchronous final
// clock check so no awaited work occurs between that check and provider invocation.
async function prepareDispatch(options, action, context) {
  const { binding, read, now } = options;
  const m = binding.manifest;
  const state = await createIntroductionHold(options).readState(binding);
  if (!isDeepStrictEqual(state.authority, options.authority)) refuse();
  const slot = leaseSlot(action);
  const needsControl =
    action.kind === "coordinator_write" ||
    action.kind === "introduction_write" ||
    slot;
  const ctl = needsControl
    ? await read({ pk: "ENV", sk: "CONTROL" })
    : undefined;
  if (
    context?.control &&
    action.purpose !== "initialize" &&
    !isDeepStrictEqual(ctl, context.control)
  )
    refuse();
  if (action.purpose === "initialize" && ctl) refuse();
  if (slot) assertUnservedLease(m, slot, ctl);
  const leased =
    slot ||
    (action.kind === "coordinator_write" && action.purpose !== "acquire");
  const nextExpiry = nextDeadline(action, context);
  return () => {
    const at = now();
    assertBoundExecution(binding, at);
    if (action.purpose === "initialize" && context?.paused) {
      const expected =
        require("./production-paused-drafts.cjs").pausedInitializationGuards(
          context.pausedInitializationToken,
          context.paused.markers[0].createdAt,
        );
      if (!isDeepStrictEqual(expected, context.paused)) refuse();
    }
    if (
      (leased && (!ctl || ctl.coordinatorExpiresAt <= at)) ||
      (nextExpiry !== undefined && nextExpiry <= at)
    )
      refuse();
  };
}
module.exports = { prepareDispatch };
