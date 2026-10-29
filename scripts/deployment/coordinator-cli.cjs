"use strict";
const { CoordinatorFailure } = require("./coordinator-aws.cjs");
const CLI_PHASES = {
  prepare: "prepare",
  promote: "promote",
  retire: "retire",
  reconcile: "reconcile",
  "continue-stopped-outgoing": "continueStoppedOutgoing",
};
async function runCli(requestedPhase, options = {}, output = console) {
  const diagnostic = {
    requestedPhase: Object.hasOwn(CLI_PHASES, requestedPhase)
      ? requestedPhase
      : "invalid",
    knownPhase: "unknown",
    operation: "configuration",
    nativeProtection: "not_checked",
  };
  try {
    if (!Object.hasOwn(CLI_PHASES, requestedPhase))
      throw new CoordinatorFailure(
        "invalid_phase",
        "Expected a coordinator phase",
        "arguments",
      );
    const coordinator = require("./coordinator.cjs").createCoordinator({
      warn: (message) => output.log(message),
      ...options,
      diagnostic,
    });
    const result = await coordinator[CLI_PHASES[requestedPhase]]();
    output.log(JSON.stringify(result));
    return result.kind === "recovery_required" || result.recoveryRequired
      ? 1
      : 0;
  } catch (error) {
    output.error(
      JSON.stringify({
        kind: "deployment_failed",
        ...diagnostic,
        operation:
          error instanceof CoordinatorFailure
            ? (error.operation ?? diagnostic.operation)
            : diagnostic.operation,
        category:
          error instanceof CoordinatorFailure
            ? error.category
            : "state_validation_failed",
        taskAction: "no_stop_or_unprotect_requested",
      }),
    );
    return 1;
  }
}
module.exports = { runCli };
