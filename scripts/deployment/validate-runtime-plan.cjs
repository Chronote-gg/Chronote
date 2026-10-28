"use strict";
const assert = require("node:assert/strict");
const {
  validateScopedPlan,
  runCli,
} = require("./validate-prerequisite-plan.cjs");
const { hasUnknown } = require("./terraform-meeting-update.cjs");

const guildTable = "aws_dynamodb_table.guild_subscription_table";
const apiTargetGroup = "aws_lb_target_group.api_tg[0]";
const createOrUpdate = ["create", "update"];
const runtimeTargets = new Map([
  ["aws_iam_role.production_deploy[0]", createOrUpdate],
  ["aws_iam_role_policy.production_deploy[0]", createOrUpdate],
  ["aws_iam_role_policy_attachment.production_deploy_routing[0]", ["create"]],
  ["aws_iam_policy.site_publishing[0]", createOrUpdate],
  ["aws_iam_role_policy_attachment.site_publishing[0]", ["create"]],
  ["aws_iam_role_policy.production_exec_channels[0]", createOrUpdate],
  ["aws_iam_policy.dynamodb_access_policy", ["update"]],
  [guildTable, ["update"]],
  [apiTargetGroup, ["update"]],
  ['aws_iam_role.production_introduction["prompt-guard"]', createOrUpdate],
  ["aws_iam_role_policy.production_prompt_guard[0]", createOrUpdate],
]);
const renewalIndex = {
  name: "RenewalRecoveryDueIndex",
  hash_key: "recoveryQueue",
  range_key: "recoveryDueAt",
  projection_type: "KEYS_ONLY",
};
const renewalAttributes = ["recoveryDueAt:N", "recoveryQueue:S"];

const sorted = (values) => [...values].sort();
const attributes = (table) =>
  sorted(table.attribute.map(({ name, type }) => `${name}:${type}`));
const indexes = (table) =>
  sorted(
    (table.global_secondary_index ?? []).map((index) =>
      JSON.stringify(
        Object.keys(renewalIndex).map((key) => [key, index[key] ?? null]),
      ),
    ),
  );

function assertOtherwiseUnchanged(before, after, unknown, changed) {
  const keys = [before, after, unknown].flatMap(Object.keys);
  for (const key of new Set(keys)) {
    if (changed.includes(key)) continue;
    assert.ok(!hasUnknown(unknown[key] ?? false));
    assert.deepEqual(after[key], before[key]);
  }
}

// The live target group may change only its drain delay, to 30 seconds.
function checkApiTargetGroup({ before, after, after_unknown: unknown = {} }) {
  assert.ok(before && after);
  assert.equal(String(after.deregistration_delay), "30");
  assertOtherwiseUnchanged(before, after, unknown, ["deregistration_delay"]);
}

// The live table may change only by gaining the renewal index and its keys.
function checkGuildTable({ before, after, after_unknown: unknown = {} }) {
  assert.ok(before && after);
  const index = JSON.stringify(Object.entries(renewalIndex));
  assert.deepEqual(indexes(after), sorted([...indexes(before), index]));
  assert.ok(!indexes(before).includes(index));
  assert.deepEqual(
    attributes(after),
    sorted([...attributes(before), ...renewalAttributes]),
  );
  assertOtherwiseUnchanged(before, after, unknown, [
    "attribute",
    "global_secondary_index",
  ]);
}

function validateRuntimePlan(plan) {
  return validateScopedPlan(plan, {
    targets: runtimeTargets,
    requiredNoOp: ["aws_kms_key.app_general", "aws_lb_listener.api_https[0]"],
    check: (resource) => {
      if (resource.address === guildTable) checkGuildTable(resource.change);
      if (resource.address === apiTargetGroup)
        checkApiTargetGroup(resource.change);
    },
  });
}
module.exports = { validateRuntimePlan, runtimeTargets };
if (require.main === module)
  runCli(
    validateRuntimePlan,
    "Deployment runtime plan rejected: invalid action evidence or changes outside the runtime scope.\n",
  );
