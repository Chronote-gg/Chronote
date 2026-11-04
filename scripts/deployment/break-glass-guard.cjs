#!/usr/bin/env node
"use strict";
const { CoordinatorFailure } = require("./coordinator-aws.cjs");
/** The only GitHub login allowed to dispatch or trigger a break-glass deploy. */
const BREAK_GLASS_DISPATCHER = "BASIC-BIT";
const MAX_REASON_LENGTH = 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const RUN_NUMBER = /^[1-9][0-9]*$/;
function refuse(message) {
  throw new CoordinatorFailure("break_glass_refused", message);
}
/** Set only by deploy.yml after the break-glass gate job succeeded. */
const breakGlassRequested = (env) => env.BREAK_GLASS === "1";
function assertDispatcher(env) {
  if (env.GITHUB_EVENT_NAME !== "workflow_dispatch")
    refuse("Break-glass requires a workflow_dispatch run");
  if (env.GITHUB_REF !== "refs/heads/master")
    refuse("Break-glass deploys only master");
  if (
    env.GITHUB_ACTOR !== BREAK_GLASS_DISPATCHER ||
    env.GITHUB_TRIGGERING_ACTOR !== BREAK_GLASS_DISPATCHER
  )
    refuse(`Only ${BREAK_GLASS_DISPATCHER} may dispatch a break-glass deploy`);
  if (!RUN_NUMBER.test(env.GITHUB_RUN_ID ?? ""))
    refuse("Break-glass requires the GitHub run id");
  if (!RUN_NUMBER.test(env.GITHUB_RUN_ATTEMPT ?? ""))
    refuse("Break-glass requires the GitHub run attempt");
}
/**
 * Refuses unless the run is a break-glass dispatch by the one permitted
 * operator with a reason and a well-formed backup manifest hash.
 */
function assertBreakGlassDispatch(env) {
  assertDispatcher(env);
  const reason = env.BREAK_GLASS_REASON?.trim() ?? "";
  if (!reason || reason.length > MAX_REASON_LENGTH)
    refuse(`break_glass_reason needs 1 to ${MAX_REASON_LENGTH} characters`);
  const manifestSha256 = env.BREAK_GLASS_MANIFEST_SHA256 ?? "";
  if (!SHA256.test(manifestSha256))
    refuse("backup_manifest_sha256 must be 64 lowercase hex characters");
  return {
    actor: env.GITHUB_ACTOR,
    triggeringActor: env.GITHUB_TRIGGERING_ACTOR,
    runId: env.GITHUB_RUN_ID,
    runAttempt: env.GITHUB_RUN_ATTEMPT,
    commitSha: env.GITHUB_SHA,
    reason,
    manifestSha256,
  };
}
async function runGate(env = process.env, output = console, request = fetch) {
  try {
    const dispatch = assertBreakGlassDispatch(env);
    const checks = await require("./break-glass-checks.cjs").verifyMergedChecks(
      env,
      request,
    );
    output.log(
      JSON.stringify({ kind: "break_glass_admitted", ...checks, ...dispatch }),
    );
    return 0;
  } catch (error) {
    output.error(
      `::error title=Break-glass refused::${error instanceof CoordinatorFailure ? error.message : "Break-glass gate failed"}`,
    );
    return 1;
  }
}
module.exports = {
  BREAK_GLASS_DISPATCHER,
  assertBreakGlassDispatch,
  breakGlassRequested,
  runGate,
};
if (require.main === module)
  runGate().then((code) => {
    process.exitCode = code;
  });
