"use strict";
const { isDeepStrictEqual } = require("node:util");
const { CoordinatorFailure } = require("./coordinator-aws.cjs");
const sortedMembers = (members) =>
  [...members].sort((a, b) => a.instanceId.localeCompare(b.instanceId));
function assertOriginalMembership(ctl, d) {
  if (
    d.phase !== "warming" ||
    d.routing?.state !== "source" ||
    d.candidate ||
    ctl.servingGeneration !== d.originalGeneration ||
    !isDeepStrictEqual(
      sortedMembers(Object.values(ctl.servingMembers)),
      sortedMembers(d.originalMembers),
    )
  )
    throw new CoordinatorFailure(
      "continuation_refused",
      "Original warming/source membership required",
    );
}
function assertCandidateService(svc, d) {
  if (
    svc.pendingCount !== 0 ||
    svc.runningCount !== 2 ||
    svc.taskDefinition !== d.taskDefinition ||
    !isDeepStrictEqual(svc.deploymentConfiguration?.earlySuccessCriteria, {
      enable: true,
      healthyPercent: 100,
      sourceServiceRevisionCleanup: "DEFERRED",
    })
  )
    throw new CoordinatorFailure(
      "continuation_refused",
      "Exact settled candidate service required",
    );
}
async function inspectContinuation({
  control,
  own,
  service,
  candidate,
  runtime,
  ready,
  protectedTask,
  routing,
}) {
  const ctl = await control();
  const d = own(ctl);
  assertOriginalMembership(ctl, d);
  const svc = await service();
  assertCandidateService(svc, d);
  const warm = await candidate(ctl);
  const old = await runtime(d.outgoing);
  if (
    !warm ||
    warm.retirementAcknowledgment ||
    old.role !== "serving" ||
    old.retirementRequest ||
    old.retirementAcknowledgment ||
    old.authorizedGeneration !== d.originalGeneration ||
    !ready(old, ctl, d.outgoing, d.runtimeMode)
  )
    throw new CoordinatorFailure(
      "continuation_refused",
      "Fresh original runtimes required",
    );
  if (
    !warm.workCounts ||
    Object.values(warm.workCounts).some((count) => count !== 0)
  )
    throw new CoordinatorFailure(
      "continuation_refused",
      "Candidate work accounting must be empty",
    );
  await protectedTask(d.outgoing);
  await protectedTask(warm.identity);
  await routing.validate(ctl, svc, warm.identity);
  await routing.assertAction(d.routing, false);
  return { control: ctl, candidateIdentity: warm.identity };
}
module.exports = { inspectContinuation };
