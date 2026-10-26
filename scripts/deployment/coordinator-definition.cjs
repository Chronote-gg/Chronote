"use strict";
const {
  taskContainer,
  runtimeMode,
  candidateDefinition,
} = require("./task-definition.cjs");
const { CoordinatorFailure } = require("./coordinator-aws.cjs");
function configuration(env) {
  const required = (key) => {
    if (!env[key]?.trim())
      throw new CoordinatorFailure("configuration_invalid", `Missing ${key}`);
    return env[key].trim();
  };
  const prefix = required("SECRETS_PREFIX");
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(prefix))
    throw new CoordinatorFailure(
      "configuration_invalid",
      "Invalid SECRETS_PREFIX",
    );
  const tablePrefix = `${prefix}-`;
  if (env.DDB_TABLE_PREFIX && env.DDB_TABLE_PREFIX !== tablePrefix)
    throw new CoordinatorFailure(
      "configuration_invalid",
      "DDB_TABLE_PREFIX mismatch",
    );
  const image = required("CANDIDATE_IMAGE");
  if (!/@sha256:[a-f0-9]{64}$/.test(image))
    throw new CoordinatorFailure(
      "configuration_invalid",
      "Candidate image must pin its digest",
    );
  return {
    cluster: required("ECS_CLUSTER"),
    service: required("ECS_SERVICE"),
    family: required("ECS_TASK_FAMILY"),
    runToken: required("DEPLOYMENT_RUN_TOKEN"),
    candidateId: required("DEPLOYMENT_CANDIDATE_ID"),
    image,
    tablePrefix,
  };
}
module.exports = {
  configuration,
  taskContainer,
  runtimeMode,
  candidateDefinition,
};
