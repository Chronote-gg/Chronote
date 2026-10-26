"use strict";
const assert = require("node:assert/strict");
const { bindingHash } = require("./binding-hash.cjs");
const { CoordinatorFailure } = require("./coordinator-aws.cjs");
function taskContainer(definition, tablePrefix) {
  const matches = definition.containerDefinitions.filter((container) =>
    container.environment?.some((entry) => entry.name === "DDB_TABLE_PREFIX"),
  );
  if (matches.length !== 1)
    throw new CoordinatorFailure(
      "configuration_invalid",
      "Expected one protocol container with an explicit table route",
    );
  const container = matches[0];
  const route = container.environment.filter(
    (entry) => entry.name === "DDB_TABLE_PREFIX",
  );
  if (route.length !== 1 || route[0].value !== tablePrefix)
    throw new CoordinatorFailure(
      "configuration_invalid",
      "Task table route mismatch",
    );
  return container;
}
function runtimeMode(container) {
  const command = JSON.stringify(container.command ?? ["npx", "yarn", "serve"]);
  const modes = {
    all: [
      ["npx", "yarn", "serve"],
      ["node", "dist/index.js"],
    ],
    bot: [
      ["npx", "yarn", "serve:bot"],
      ["node", "dist/apps/bot/main.js"],
    ],
    api: [
      ["npx", "yarn", "serve:api"],
      ["node", "dist/apps/api/main.js"],
    ],
  };
  if (container.entryPoint?.length)
    throw new CoordinatorFailure(
      "configuration_invalid",
      "Unreviewed task entry point",
    );
  for (const [mode, commands] of Object.entries(modes))
    if (commands.some((value) => JSON.stringify(value) === command))
      return mode;
  throw new CoordinatorFailure(
    "configuration_invalid",
    "Unreviewed task runtime command",
  );
}
function taskDefinitionInput(definition) {
  const next = structuredClone(definition);
  for (const field of [
    "taskDefinitionArn",
    "revision",
    "status",
    "requiresAttributes",
    "compatibilities",
    "registeredAt",
    "registeredBy",
    "deregisteredAt",
  ])
    delete next[field];
  return next;
}
function candidateDefinition(definition, config) {
  const next = taskDefinitionInput(definition);
  const container = taskContainer(next, config.tablePrefix);
  container.image = config.image;
  container.stopTimeout = 120;
  container.environment = container.environment.filter(
    (entry) => entry.name !== "DEPLOYMENT_CANDIDATE_ID",
  );
  container.environment.push({
    name: "DEPLOYMENT_CANDIDATE_ID",
    value: config.candidateId,
  });
  return next;
}
function assertPreparedTaskDefinition(actual, prepared, rawSha256) {
  assert.equal(bindingHash(prepared), rawSha256);
  function environmentOrderOnly(definition) {
    const next = structuredClone(definition);
    for (const container of next.containerDefinitions) {
      if (!container.environment) continue;
      const names = container.environment.map((entry) => entry.name);
      assert.ok(names.every((name) => typeof name === "string" && name.length));
      assert.equal(
        new Set(names).size,
        names.length,
        "Duplicate environment names",
      );
      container.environment.sort((a, b) => a.name.localeCompare(b.name));
    }
    return next;
  }
  assert.deepEqual(
    environmentOrderOnly(actual),
    environmentOrderOnly(prepared),
  );
}
module.exports = {
  taskContainer,
  runtimeMode,
  taskDefinitionInput,
  candidateDefinition,
  assertPreparedTaskDefinition,
};
