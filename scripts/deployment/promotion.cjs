"use strict";
const { isDeepStrictEqual } = require("node:util");
const { bindingHash } = require("./binding-hash.cjs");
const { CoordinatorFailure } = require("./coordinator-aws.cjs");
const { WARMUP_SECONDS } = require("./production-capacity.cjs");

function createPromotion(options) {
  const {
    config,
    now,
    sleep,
    control,
    renew,
    service,
    candidate,
    completePromotion,
    promotionObserved,
    protectedTask,
    routing,
    phase,
    artifacts,
    transactPromotion,
    assertWriter,
    assertAcknowledged,
    same,
  } = options;
  async function prepareCandidate(ctl, svc, warm) {
    const d = ctl.deployment;
    assertExpectedCandidate(warm);
    if (d.candidate && !same(d.candidate, warm.identity))
      throw new CoordinatorFailure(
        "coordinator_authority_changed",
        "Recorded promotion candidate changed",
      );
    await protectedTask(d.outgoing);
    await protectedTask(warm.identity);
    const revision = await routing.validate(ctl, svc, warm.identity);
    if (d.routing) await routing.assertAction(d.routing, false);
    return phase(ctl, "promoting", {
      candidate: warm.identity,
      ...(d.routing
        ? { routing: { ...d.routing, candidateRevision: revision } }
        : {}),
    });
  }
  function assertExpectedCandidate(warm) {
    if (
      options.expectedCandidate &&
      !same(warm.identity, options.expectedCandidate)
    )
      throw new CoordinatorFailure(
        "continuation_refused",
        "Reviewed candidate changed",
      );
  }
  const admissionAuthority = (ctl) =>
    bindingHash({
      epoch: ctl.coordinatorEpoch,
      generation: ctl.servingGeneration,
      members: ctl.servingMembers,
      candidate: ctl.deployment.candidate ?? null,
    });
  async function promote() {
    await assertWriter();
    await assertAcknowledged("launch");
    const deadline = now() + WARMUP_SECONDS;
    let retryAuthority;
    let ctl;
    async function attempt() {
      const d = ctl.deployment;
      if (["promoted", "retiring", "complete"].includes(d.phase))
        return { kind: d.phase };
      if (!["warming", "promoting"].includes(d.phase))
        throw new CoordinatorFailure(
          "invalid_phase",
          "Prepare must precede promotion",
        );
      const svc = await service();
      if (
        svc.taskDefinition !== d.taskDefinition ||
        !isDeepStrictEqual(svc.deploymentConfiguration?.earlySuccessCriteria, {
          enable: true,
          healthyPercent: 100,
          sourceServiceRevisionCleanup: "DEFERRED",
        })
      )
        throw new CoordinatorFailure(
          "configuration_invalid",
          "Candidate service configuration is not confirmed",
        );
      const retained = d.originalMembers.filter(
        (member) => member.instanceId !== d.outgoing.instanceId,
      );
      if (
        d.candidate &&
        promotionObserved(ctl, d.candidate, d.originalGeneration + 1, retained)
      ) {
        await completePromotion(ctl, d.candidate);
        return { kind: "promoted", recovered: true };
      }
      const warm = await candidate(ctl);
      if (warm) {
        ctl = await prepareCandidate(ctl, svc, warm);
        const promotion = {
          coordinatorToken: config.runToken,
          coordinatorEpoch: ctl.coordinatorEpoch,
          expectedServingGeneration: d.originalGeneration,
          expectedServingMembers: d.originalMembers,
          candidate: warm.identity,
          candidateRuntimeMode: d.runtimeMode,
          retainedMembers: retained,
          proposedGeneration: d.originalGeneration + 1,
          now: now(),
        };
        ctl = await artifacts.promote(
          ctl,
          promotion,
          retained,
          transactPromotion,
        );
        await completePromotion(ctl, warm.identity);
        return { kind: "promoted" };
      }
    }
    while (now() <= deadline) {
      try {
        const current = await control();
        if (retryAuthority && retryAuthority !== admissionAuthority(current))
          throw new CoordinatorFailure(
            "coordinator_authority_changed",
            "Admission authority changed while waiting to retry promotion",
          );
        ctl = await renew(current);
        const result = await attempt();
        if (result) return result;
      } catch (error) {
        if (
          !(error instanceof CoordinatorFailure) ||
          ![
            "candidate_preservation_pending",
            "control_store_condition_failed",
          ].includes(error.category)
        )
          throw error;
        await artifacts.committed(ctl);
        await protectedTask(ctl.deployment.outgoing);
        retryAuthority = admissionAuthority(ctl);
      }
      await sleep(10000);
    }
    throw new CoordinatorFailure(
      "application_not_ready",
      "Candidate readiness timeout; old admission retained, protected tasks preserved (check DEPLOYMENT_BLOCKED)",
    );
  }
  return promote;
}
module.exports = { createPromotion };
