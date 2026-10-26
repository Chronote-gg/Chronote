"use strict";
const assert = require("node:assert/strict");
const { awsCli, createCoordinator } = require("./coordinator.cjs");
const { assertSandboxIdentity } = require("./assert-sandbox-identity.cjs");
const { createWriterInventory } = require("./carryforward-writers.cjs");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function assertNoEndpointOverride(env) {
  assert.ok(
    !Object.keys(env).some(
      (key) => key.startsWith("AWS_ENDPOINT_URL") && env[key],
    ),
  );
}
async function authenticateOperation(options, env, token) {
  assertNoEndpointOverride(env);
  assert.equal(env.EXPECTED_SESSION_NAME, "chronote-sandbox-" + token);
  const aws = options.aws ?? awsCli,
    actor = await aws("sts", "get-caller-identity", {});
  assertSandboxIdentity(actor, env);
  const types =
    options.types ?? require("../../dist/types/deploymentControl.js");
  const inventory = options.writerInventory ?? createWriterInventory({ env });
  await inventory.assertExclusive();
  return { aws, actor, types, inventory };
}
function guardedCoordinator(base, beforeMutation) {
  return createCoordinator({
    ...base,
    aws: async (service, operation, input) => {
      if (
        [
          "update-item",
          "transact-write-items",
          "register-task-definition",
          "update-service",
          "modify-listener",
        ].includes(operation)
      )
        await beforeMutation(operation, input);
      return base.aws(service, operation, input);
    },
  });
}
function operationOptions(
  options,
  { env, manifest, runToken, aws, types, now },
) {
  return {
    ...options,
    aws,
    types,
    now,
    env: {
      ...env,
      DEPLOYMENT_RUN_TOKEN: runToken,
      DEPLOYMENT_CANDIDATE_ID: manifest.operationId,
      CANDIDATE_IMAGE: manifest.image,
    },
    taskTemplate: {
      arn: manifest.templateArn,
      preparedSha256: manifest.preparedDefinitionSha256,
    },
  };
}
async function awaitSourceRefresh(deployment, source, epoch, pause = sleep) {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const serving = await deployment.inspectServing();
      assert.deepEqual(serving.source, source);
      assert.equal(serving.control.coordinatorEpoch, epoch);
      return;
    } catch {
      await pause(1000);
    }
  }
  throw new Error(
    "Source did not refresh own readiness at the claimed epoch; preserve receipts",
  );
}
async function assertPreservedHistory(inspector, claim) {
  for (const row of [claim.archive, claim.recovery])
    assert.deepEqual(await inspector.read(row.pk, row.sk), row);
}
module.exports = {
  authenticateOperation,
  guardedCoordinator,
  assertNoEndpointOverride,
  operationOptions,
  awaitSourceRefresh,
  assertPreservedHistory,
};
