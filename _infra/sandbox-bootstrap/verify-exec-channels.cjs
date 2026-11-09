"use strict";
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const {
  hasUnknown,
} = require("../../scripts/deployment/terraform-meeting-update.cjs");
const target = "aws_iam_role_policy.sandbox_exec_channels[0]";
const expectedPolicy = {
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Action: [
        "ssmmessages:CreateControlChannel",
        "ssmmessages:CreateDataChannel",
        "ssmmessages:OpenControlChannel",
        "ssmmessages:OpenDataChannel",
      ],
      Resource: "*",
    },
  ],
};
function validateExecChannelsPlan(plan, accountId) {
  assert.match(accountId, /^\d{12}$/);
  assert.equal(plan.format_version, "1.2");
  assert.equal(plan.terraform_version, "1.16.0");
  assert.equal(plan.errored, false);
  for (const field of [
    "resource_drift",
    "deferred_changes",
    "action_invocations",
    "ephemeral_resource_changes",
  ])
    assert.deepEqual(plan[field] ?? [], []);
  const excluded = new Set([
    "aws_iam_role.sandbox_terraform",
    "aws_s3_bucket.private_evidence",
    ...[
      "administrator_role_arn",
      "enable_sandbox_terraform_role",
      "github_owner_id",
      "github_repository_id",
      "kms_key_arn",
      "reviewer_role_arn",
      "site_docs_bucket",
      "site_frontend_bucket",
      "trusted_refs",
    ].map((k) => "var." + k),
  ]);
  for (const check of plan.checks) {
    if (check.status === "unknown") {
      assert.ok(excluded.has(check.address.to_display));
      assert.deepEqual(check.instances ?? [], []);
    } else assert.equal(check.status, "pass");
  }
  for (const name of [
    "aws_iam_role_policy.sandbox_exec_channels",
    "var.enable_sandbox_exec_channels",
    "var.enable_private_evidence_store",
  ])
    assert.equal(
      plan.checks.find((c) => c.address.to_display === name)?.status,
      "pass",
    );
  const configuration = plan.configuration;
  assert.deepEqual(Object.keys(configuration.provider_config), ["aws"]);
  const provider = configuration.provider_config.aws;
  assert.equal(provider.name, "aws");
  assert.equal(provider.full_name, "registry.terraform.io/hashicorp/aws");
  assert.deepEqual(Object.keys(provider.expressions).sort(), [
    "allowed_account_ids",
    "default_tags",
    "region",
  ]);
  assert.deepEqual(provider.expressions.region, {
    references: ["var.aws_region"],
  });
  assert.deepEqual(provider.expressions.allowed_account_ids, {
    references: ["var.enable_private_evidence_store", "var.sandbox_account_id"],
  });
  assert.deepEqual(configuration.root_module.child_modules ?? [], []);
  for (const name of [
    "aws_iam_role_policy.sandbox_exec_channels",
    "data.aws_caller_identity.current",
  ])
    assert.equal(
      configuration.root_module.resources.find((r) => r.address === name)
        ?.provider_config_key,
      "aws",
    );
  const caller = plan.prior_state.values.root_module.resources.find(
    (r) => r.address === "data.aws_caller_identity.current[0]",
  );
  assert.equal(caller?.mode, "data");
  assert.equal(caller.values.account_id, accountId);
  for (const [key, value] of Object.entries({
    sandbox_account_id: accountId,
    environment: "sandbox",
    aws_region: "us-east-1",
    enable_sandbox_exec_channels: true,
    enable_private_evidence_store: true,
  }))
    assert.equal(plan.variables[key]?.value, value);
  let created = 0;
  for (const r of plan.resource_changes) {
    assert.equal(r.provider_name, "registry.terraform.io/hashicorp/aws");
    assert.equal(r.previous_address ?? null, null);
    assert.equal(r.change.importing ?? null, null);
    const c = r.change;
    if (r.address !== target) {
      assert.deepEqual(c.actions, ["no-op"]);
      assert.deepEqual(c.after, c.before);
      assert.ok(!hasUnknown(c.after_unknown ?? {}));
      continue;
    }
    created++;
    assert.equal(r.mode, "managed");
    assert.deepEqual(c.actions, ["create"]);
    assert.equal(c.before, null);
    assert.deepEqual(
      Object.keys(c.after)
        .filter((k) => !["id", "name_prefix"].includes(k))
        .sort(),
      ["name", "policy", "role"],
    );
    assert.equal(c.after.name, "meeting-notes-sandbox-ecs-exec-channels");
    assert.equal(c.after.name_prefix ?? null, null);
    assert.equal(c.after.role, "meeting-notes-sandbox-ecs-task-app-role");
    assert.deepEqual(JSON.parse(c.after.policy), expectedPolicy);
    const unknown = { ...c.after_unknown };
    delete unknown.id;
    delete unknown.name_prefix;
    assert.ok(!hasUnknown(unknown));
  }
  assert.equal(created, 1);
  for (const output of Object.values(plan.output_changes ?? {}))
    assert.deepEqual(output.actions, ["no-op"]);
  return true;
}
module.exports = { validateExecChannelsPlan };
if (require.main === module) {
  assert.equal(process.argv.length, 4);
  validateExecChannelsPlan(
    JSON.parse(readFileSync(process.argv[2], "utf8")),
    process.argv[3],
  );
  console.log("Accepted exact Sandbox task-side channel policy create");
}
