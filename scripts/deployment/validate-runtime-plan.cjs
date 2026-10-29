"use strict";
const assert = require("node:assert/strict");
const {
  validateScopedPlan,
  assertOtherwiseUnchanged,
  runCli,
} = require("./validate-prerequisite-plan.cjs");

const guildTable = "aws_dynamodb_table.guild_subscription_table";
const apiTargetGroups = [
  "aws_lb_target_group.api_tg[0]",
  "aws_lb_target_group.api_spare_tg[0]",
];
const oidcRoles = [
  "aws_iam_role.production_deploy[0]",
  'aws_iam_role.production_introduction["prompt-guard"]',
];
const policyDocuments = [
  "aws_iam_role_policy.production_deploy[0]",
  "aws_iam_policy.site_publishing[0]",
  "aws_iam_role_policy.production_exec_channels[0]",
  "aws_iam_policy.dynamodb_access_policy",
  "aws_iam_role_policy.production_prompt_guard[0]",
];
const createOrUpdate = ["create", "update"];
const runtimeTargets = new Map([
  [oidcRoles[0], createOrUpdate],
  [policyDocuments[0], createOrUpdate],
  ["aws_iam_role_policy_attachment.production_deploy_routing[0]", ["create"]],
  [policyDocuments[1], createOrUpdate],
  ["aws_iam_role_policy_attachment.site_publishing[0]", ["create"]],
  [policyDocuments[2], createOrUpdate],
  [policyDocuments[3], ["update"]],
  [guildTable, ["update"]],
  ...apiTargetGroups.map((address) => [address, ["update"]]),
  [oidcRoles[1], createOrUpdate],
  [policyDocuments[4], createOrUpdate],
]);
const renewalIndex = {
  name: "RenewalRecoveryDueIndex",
  hash_key: "recoveryQueue",
  range_key: "recoveryDueAt",
  projection_type: "KEYS_ONLY",
};
const renewalAttributes = ["recoveryDueAt:N", "recoveryQueue:S"];
// AWS 6.69+ recomputes these read-only fields on any in-place table update.
const streamOutputs = ["stream_arn", "stream_label"];
// Actions that cannot name a resource. Everything else on "*" is refused.
const resourceFreeActions = new Set([
  "ecr:GetAuthorizationToken",
  "ssmmessages:CreateControlChannel",
  "ssmmessages:CreateDataChannel",
  "ssmmessages:OpenControlChannel",
  "ssmmessages:OpenDataChannel",
]);

const sorted = (values) => [...values].sort();
const list = (value) => [value].flat();
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

// A live API target group may change only its drain delay, to 5 seconds.
function checkApiTargetGroup({ before, after, after_unknown: unknown = {} }) {
  assert.ok(before && after);
  assert.equal(String(after.deregistration_delay), "5");
  assertOtherwiseUnchanged({ before, after, unknown }, [
    "deregistration_delay",
  ]);
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
  for (const key of streamOutputs)
    if (unknown[key] !== true) assert.equal(after[key], before[key]);
  assertOtherwiseUnchanged({ before, after, unknown }, [
    "attribute",
    "global_secondary_index",
    ...streamOutputs,
  ]);
}

function statements(document) {
  assert.equal(typeof document, "string");
  const parsed = JSON.parse(document);
  assert.ok(Array.isArray(parsed.Statement) && parsed.Statement.length > 0);
  return parsed.Statement;
}

// Only GitHub production on this repository may assume the new roles.
function checkOidcTrust({ after }, accountId) {
  const provider = `arn:aws:iam::${accountId}:oidc-provider/token.actions.githubusercontent.com`;
  for (const statement of statements(after.assume_role_policy)) {
    assert.equal(statement.Effect, "Allow");
    assert.deepEqual(statement.Principal, { Federated: provider });
    assert.equal(statement.Action, "sts:AssumeRoleWithWebIdentity");
    assert.equal(
      statement.Condition.StringEquals[
        "token.actions.githubusercontent.com:sub"
      ],
      "repo:Chronote-gg/Chronote:environment:production",
    );
  }
}

function checkPolicyDocument({ after }) {
  for (const statement of statements(after.policy)) {
    if (statement.Effect !== "Allow") continue;
    assert.ok(!("NotAction" in statement) && !("NotResource" in statement));
    const actions = list(statement.Action);
    for (const action of actions)
      assert.ok(!["*", "iam:*", "sts:*"].includes(action));
    if (list(statement.Resource).includes("*"))
      for (const action of actions)
        assert.ok(
          /^[a-z0-9-]+:(Describe|List)[A-Za-z]*$/.test(action) ||
            resourceFreeActions.has(action),
        );
  }
}

function validateRuntimePlan(plan, { accountId }) {
  assert.match(accountId, /^\d{12}$/);
  return validateScopedPlan(plan, {
    targets: runtimeTargets,
    requiredNoOp: ["aws_kms_key.app_general", "aws_lb_listener.api_https[0]"],
    check: ({ address, change }) => {
      if (address === guildTable) checkGuildTable(change);
      if (apiTargetGroups.includes(address)) checkApiTargetGroup(change);
      if (oidcRoles.includes(address)) checkOidcTrust(change, accountId);
      if (policyDocuments.includes(address)) checkPolicyDocument(change);
    },
  });
}
module.exports = { validateRuntimePlan, runtimeTargets };
if (require.main === module)
  runCli(
    (plan) => validateRuntimePlan(plan, { accountId: process.argv[2] }),
    "Deployment runtime plan rejected: invalid action evidence or changes outside the runtime scope.\n",
  );
