"use strict";
const { CoordinatorFailure } = require("./coordinator-aws.cjs");
const { HANDOFF_QUIET_SECONDS } = require("./production-capacity.cjs");
const { createStoppedOutgoingContinuation } = require("./stopped-outgoing.cjs");
const HANDOFF_BLOCKING_WORK = ["recording", "finalization", "voice_operation"];
/**
 * Decides whether a new deployment may take the environment. Once the
 * candidate holds native protection, ECS refuses the outgoing task's renewals
 * (protected tasks would exceed desired count 1), so the outgoing runtime
 * shuts itself down within about eight minutes. Launch therefore waits for a
 * serving runtime with no recording, finalization or voice work. The
 * production introduction keeps its own reviewed action sequence.
 */
function createHandoffGate(deps) {
  const { now, sleep, control, original, production, assertWriter } = deps;
  const stopped = createStoppedOutgoingContinuation(deps);
  function assertUnowned(ctl) {
    if (
      ctl.coordinatorExpiresAt > now() ||
      (ctl.deployment && ctl.deployment.phase !== "complete")
    )
      throw new CoordinatorFailure(
        "coordinator_authority_changed",
        "Another coordinator or unresolved deployment owns this environment",
      );
  }
  const quiet = (counts) =>
    counts && HANDOFF_BLOCKING_WORK.every((kind) => (counts[kind] ?? 0) === 0);
  /** Returns the current Control and the quiet serving runtime, or throws before any write. */
  async function acquirable(ctl, svc) {
    if (!production && ctl.deployment?.phase === "retiring")
      ctl = (await stopped.continueStoppedOutgoing(ctl)).control;
    const deadline = now() + HANDOFF_QUIET_SECONDS;
    for (;;) {
      assertUnowned(ctl);
      const previous = await original(ctl, svc);
      if (production || quiet(previous.old.workCounts))
        return { ctl, previous };
      if (now() >= deadline)
        throw new CoordinatorFailure(
          "outgoing_busy",
          "Serving runtime still holds recording, finalization or voice work; retry the deployment once it is quiet",
        );
      await sleep(10000);
      ctl = await control();
    }
  }
  return {
    acquirable,
    async continueStoppedOutgoing() {
      await assertWriter();
      return (await stopped.continueStoppedOutgoing(await control())).result;
    },
  };
}
module.exports = { createHandoffGate };
