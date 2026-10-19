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
    const coordinator = createCoordinator({ ...options, env, production });
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
  return { run };
}
module.exports = { createProductionHandoff };
