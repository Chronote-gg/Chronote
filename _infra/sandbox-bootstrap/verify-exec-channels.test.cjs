"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { validateBootstrapPlan } = require("./verify-plan.cjs");
test("default-off runtime access preserves the original bootstrap contract", () => {
  const plan = JSON.parse(
    readFileSync(join(__dirname, "tests/fixtures/create-plan.json")),
  );
  const binding = JSON.parse(
    readFileSync(join(__dirname, "tests/fixtures/reviewed-binding.json")),
  );
  plan.variables.enable_sandbox_exec_channels = { value: false };
  plan.configuration.root_module.resources.push({
    address: "aws_iam_role_policy.sandbox_exec_channels",
    mode: "managed",
    type: "aws_iam_role_policy",
    name: "sandbox_exec_channels",
    count_expression: { references: ["var.enable_sandbox_exec_channels"] },
    provider_config_key: "aws",
  });
  assert.equal(validateBootstrapPlan(plan, binding), true);
  plan.variables.enable_sandbox_exec_channels.value = true;
  assert.throws(() => validateBootstrapPlan(plan, binding));
});
function candidate() {
  return {
    prior_state: {
      values: {
        root_module: {
          resources: [
            {
              address: "data.aws_caller_identity.current[0]",
              mode: "data",
              values: { account_id: "123456789012" },
            },
          ],
        },
      },
    },
    configuration: {
      provider_config: {
        aws: {
          name: "aws",
          full_name: "registry.terraform.io/hashicorp/aws",
          expressions: {
            allowed_account_ids: {
              references: [
                "var.enable_private_evidence_store",
                "var.sandbox_account_id",
              ],
            },
            region: { references: ["var.aws_region"] },
            default_tags: [],
          },
        },
      },
      root_module: {
        resources: [
          {
            address: "data.aws_caller_identity.current",
            provider_config_key: "aws",
          },
          {
            address: "aws_iam_role_policy.sandbox_exec_channels",
            provider_config_key: "aws",
          },
        ],
      },
    },
    checks: [
      {
        address: { to_display: "aws_iam_role_policy.sandbox_exec_channels" },
        status: "pass",
      },
      {
        address: { to_display: "var.enable_sandbox_exec_channels" },
        status: "pass",
      },
      {
        address: { to_display: "var.enable_private_evidence_store" },
        status: "pass",
      },
    ],
    format_version: "1.2",
    terraform_version: "1.16.0",
    errored: false,
    variables: {
      sandbox_account_id: { value: "123456789012" },
      environment: { value: "sandbox" },
      aws_region: { value: "us-east-1" },
      enable_sandbox_exec_channels: { value: true },
      enable_private_evidence_store: { value: true },
    },
    resource_changes: [
      {
        address: "data.aws_caller_identity.current[0]",
        mode: "data",
        provider_name: "registry.terraform.io/hashicorp/aws",
        change: {
          actions: ["no-op"],
          before: { account_id: "123456789012" },
          after: { account_id: "123456789012" },
          after_unknown: {},
        },
      },
      {
        address: "aws_iam_role_policy.sandbox_exec_channels[0]",
        mode: "managed",
        provider_name: "registry.terraform.io/hashicorp/aws",
        change: {
          actions: ["create"],
          before: null,
          after: {
            name: "meeting-notes-sandbox-ecs-exec-channels",
            name_prefix: null,
            role: "meeting-notes-sandbox-ecs-task-app-role",
            policy: JSON.stringify({
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
            }),
          },
          after_unknown: { id: true },
        },
      },
    ],
  };
}
test("accepts only the exact new Sandbox task-side channel policy", () => {
  const { validateExecChannelsPlan } = require("./verify-exec-channels.cjs");
  assert.equal(validateExecChannelsPlan(candidate(), "123456789012"), true);
});
for (const [name, alter] of [
  [
    "foreign role",
    (p) =>
      (p.resource_changes[1].change.after.role =
        "meeting-notes-prod-ecs-task-app-role"),
  ],
  [
    "extra action",
    (p) => {
      const c = p.resource_changes[1].change;
      const d = JSON.parse(c.after.policy);
      d.Statement[0].Action.push("ssm:StartSession");
      c.after.policy = JSON.stringify(d);
    },
  ],
  [
    "unknown policy",
    (p) => (p.resource_changes[1].change.after_unknown.policy = true),
  ],
  ["delete", (p) => (p.resource_changes[1].change.actions = ["delete"])],
  ["drift", (p) => (p.resource_drift = [{}])],
  [
    "import",
    (p) => (p.resource_changes[1].change.importing = { id: "foreign" }),
  ],
  ["move", (p) => (p.resource_changes[1].previous_address = "foreign")],
  [
    "other mutation",
    (p) =>
      p.resource_changes.push({
        ...structuredClone(p.resource_changes[1]),
        address: "aws_iam_role.other",
      }),
  ],
  ["production", (p) => (p.variables.environment.value = "prod")],
  ["disabled", (p) => (p.variables.enable_sandbox_exec_channels.value = false)],
])
  test(`refuses ${name}`, () => {
    const { validateExecChannelsPlan } = require("./verify-exec-channels.cjs");
    const p = candidate();
    alter(p);
    assert.throws(() => validateExecChannelsPlan(p, "123456789012"));
  });

test("binds policy to the approved root provider and actual caller", () => {
  const { validateExecChannelsPlan } = require("./verify-exec-channels.cjs");
  for (const alter of [
    (p) => delete p.configuration,
    (p) =>
      (p.configuration.provider_config.aws.expressions.region = {
        constant_value: "eu-west-1",
      }),
    (p) =>
      (p.configuration.root_module.resources[1].provider_config_key =
        "aws.foreign"),
    (p) => {
      p.prior_state.values.root_module.resources[0].values.account_id =
        "999999999999";
      p.resource_changes[0].change.after.account_id = "999999999999";
    },
  ]) {
    const p = candidate();
    alter(p);
    assert.throws(() => validateExecChannelsPlan(p, "123456789012"));
  }
});

test("saved-plan guard loads without application dependencies in Terraform CI", () => {
  const { spawnSync } = require("node:child_process");
  const script = `const Module=require('node:module');const load=Module._load;Module._load=function(id,...args){if(!id.startsWith('node:')&&!id.startsWith('.')&&!require('node:path').isAbsolute(id))throw Error('External dependency: '+id);return load.call(this,id,...args)};require(process.argv[1]);`;
  assert.equal(
    spawnSync(
      process.execPath,
      ["-e", script, join(__dirname, "verify-exec-channels.cjs")],
      { encoding: "utf8" },
    ).status,
    0,
  );
});
