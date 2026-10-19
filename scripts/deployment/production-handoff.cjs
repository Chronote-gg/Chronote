"use strict";
const { isDeepStrictEqual } = require("node:util");
const { createCoordinator } = require("./coordinator.cjs");
const { createProductionCoordinator } = require("./production-coordinator.cjs");
const { createRouting } = require("./routing.cjs");
const { CoordinatorFailure } = require("./coordinator-aws.cjs");
function createProductionHandoff(options, bootstrap) {
  const { binding, read, aws, now, candidate, inventory } = options,
    m = binding.manifest;
  const { find, actions, control, wait } = bootstrap;
  async function enqueue(slot, index) {
    const action = find(
        "introduction_write",
        (a) =>
          a.purpose === "enqueue_fixture" &&
          a.slot === slot &&
          a.grantIndex === index,
      ),
      { hold } = await actions.state();
    const grant = m.handoff.grants[index];
    await actions.run(action, { currentHold: hold, now: now() }, async () => {
      const row = await read({
        pk: `FIXTURE#${grant.grantId}`,
        sk: "AUTHORITY",
      });
      if (
        !row ||
        !Object.entries(grant).every(([k, v]) => row[k] === v) ||
        row.holdId !== m.holdId ||
        row.introductionId !== m.introductionId
      )
        throw Error("fixture_enqueue_unconfirmed");
      return row;
    });
    return wait(async () => {
      const row = await read({
        pk: `FIXTURE#${grant.grantId}`,
        sk: "AUTHORITY",
      });
      if (row?.state !== "consumed") return;
      require("../../dist/types/productionIntroduction.js").fixtureGrantSchema.parse(
        row,
      );
      if (
        row.commandId !== grant.commandId ||
        row.meetingId !== grant.meetingId ||
        row.holdId !== m.holdId
      )
        throw Error("fixture_identity_refused");
      return row;
    }, 900);
  }
  async function run(slot) {
    const prior = await control();
    await actions.run(
      find(
        "introduction_write",
        (a) => a.purpose === "authorize_fixture" && a.slot === slot,
      ),
      { control: prior },
      async () => {
        const row = await read({
          pk: `INTRODUCTION#${m.introductionId}`,
          sk: "FIXTURE_COORDINATOR",
        });
        if (
          !row ||
          row.priorEpoch !== prior.coordinatorEpoch ||
          row.priorRunToken !== prior.coordinatorToken ||
          !isDeepStrictEqual(
            row.priorMember,
            Object.values(prior.servingMembers)[0],
          )
        )
          throw Error("fixture_authority_unconfirmed");
        return row;
      },
    );
    await enqueue(slot, 0);
    const configured = await coordinatorOptions();
    const coordinator = createCoordinator(configured);
    await coordinator.prepare();
    await coordinator.promote();
    await coordinator.retire();
    await enqueue(slot, 1);
    return {
      status: "fixture_handoff_complete",
      admission: "held",
      deployment: "held",
      acceptance: "pending",
    };
  }
  async function coordinatorOptions() {
    const definition = await inventory.definition(
        m.runtime.continuationDefinition,
      ),
      image = definition.containerDefinitions.find(
        (c) => c.name === m.runtime.container,
      ).image;
    const suffix = "DeploymentControlTable",
      prefix = m.resources.tables.deploymentControl.slice(0, -suffix.length);
    if (
      !m.resources.tables.deploymentControl.endsWith(suffix) ||
      !prefix.endsWith("-")
    )
      throw Error("table_configuration_refused");
    const env = {
      SECRETS_PREFIX: prefix.slice(0, -1),
      DDB_TABLE_PREFIX: prefix,
      ECS_CLUSTER: m.runtime.clusterArn,
      ECS_SERVICE: m.runtime.serviceArn,
      ECS_TASK_FAMILY: m.runtime.family,
      DEPLOYMENT_RUN_TOKEN: m.handoff.runToken,
      DEPLOYMENT_CANDIDATE_ID: m.handoff.candidateId,
      CANDIDATE_IMAGE: image,
      DEPLOYMENT_LISTENER_ARN: m.resources.listenerArn,
      DEPLOYMENT_TARGET_GROUP_A: m.resources.targetGroupA,
      DEPLOYMENT_TARGET_GROUP_B: m.resources.targetGroupB,
    };
    const routing = createRouting({
      aws,
      config: { cluster: m.runtime.clusterArn },
      env,
      failure: (code, message) => new CoordinatorFailure(code, message),
    });
    const production = createProductionCoordinator({
      ...options,
      table: m.resources.tables.deploymentControl,
      readService: candidate.service,
      assertCandidateRoute: (r) => routing.assertAction(r, true),
    });
    return { ...options, env, production };
  }
  async function warmingAuthority() {
    const ctl = await control();
    const fixture =
      require("../../dist/services/productionIntroductionTransactions.js").fixtureCoordinatorAuthoritySchema.parse(
        await read({
          pk: `INTRODUCTION#${m.introductionId}`,
          sk: "FIXTURE_COORDINATOR",
        }),
      );
    const slot =
      fixture.priorEpoch === m.handoff.priorEpoch ? "bootstrap" : "replacement";
    const selected = require("./production-candidate.cjs").candidateSlot(
      m,
      slot,
    );
    if (
      fixture.priorEpoch !== selected.epoch ||
      fixture.priorRunToken !== selected.token ||
      fixture.priorMember.candidateId !== selected.candidateId ||
      fixture.priorMember.imageDigest !== selected.digest ||
      ctl.coordinatorToken !== fixture.runToken ||
      ctl.coordinatorEpoch !== fixture.priorEpoch + 1 ||
      ctl.coordinatorExpiresAt <= now() ||
      ctl.servingGeneration !== 1 ||
      !isDeepStrictEqual(Object.values(ctl.servingMembers), [
        fixture.priorMember,
      ])
    )
      throw Error("warming_continuation_refused");
    return { slot, fixture };
  }
  async function assertWarmingReceipts(slot, fixture) {
    for (const action of [
      find("launch_candidate", (a) => a.slot === slot),
      find(
        "introduction_write",
        (a) =>
          a.purpose === "enqueue_fixture" &&
          a.slot === slot &&
          a.grantIndex === 0,
      ),
    ]) {
      const row = await actions.readAction(action);
      if (
        row.phase !== "observed" ||
        (action.kind === "launch_candidate" &&
          !row.observation.resourceIds.includes(fixture.priorMember.taskArn))
      )
        throw Error("warming_continuation_refused");
    }
  }
  async function assertFirstFixture(fixture) {
    const grant =
      require("../../dist/types/productionIntroduction.js").fixtureGrantSchema.parse(
        await read({
          pk: `FIXTURE#${m.handoff.grants[0].grantId}`,
          sk: "AUTHORITY",
        }),
      );
    if (
      grant.state !== "consumed" ||
      grant.ownership.ownerInstanceId !== fixture.priorMember.instanceId ||
      grant.holdId !== m.holdId ||
      grant.introductionId !== m.introductionId ||
      !Object.entries(m.handoff.grants[0]).every(
        ([key, value]) => grant[key] === value,
      )
    )
      throw Error("warming_continuation_refused");
  }
  async function resume() {
    await actions.unsettled();
    const { slot, fixture } = await warmingAuthority();
    await assertWarmingReceipts(slot, fixture);
    await assertFirstFixture(fixture);
    const configured = await coordinatorOptions();
    const inspected = await createCoordinator(configured).inspectContinuation();
    const coordinator = createCoordinator({
      ...configured,
      expectedCandidate: inspected.candidateIdentity,
    });
    await coordinator.promote();
    await coordinator.retire();
    await enqueue(slot, 1);
    return {
      status: "fixture_handoff_complete",
      admission: "held",
      deployment: "held",
      acceptance: "pending",
    };
  }
  return { run, resume };
}
module.exports = { createProductionHandoff };
