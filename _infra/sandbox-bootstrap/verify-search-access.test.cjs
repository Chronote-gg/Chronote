"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { createHash } = require("node:crypto");
const {
  validateSearchAccessPlan,
  preserveInstalledSearchAccess,
} = require("./verify-search-access.cjs");
const {
  expectedSearchProvisioningPolicy,
} = require("./search-policy-contract.cjs");
const { validateBootstrapPlan } = require("./verify-plan.cjs");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const fixture = (name) =>
  JSON.parse(readFileSync(join(__dirname, "tests/fixtures", name), "utf8"));

function candidate() {
  const plan = fixture("create-plan.json");
  const input = fixture("reviewed-binding.json").variables;
  plan.configuration.provider_config = {
    aws: {
      full_name: "registry.terraform.io/hashicorp/aws",
      expressions: {
        allowed_account_ids: {
          references: [
            "var.enable_private_evidence_store",
            "var.sandbox_account_id",
          ],
        },
        region: { references: ["var.aws_region"] },
      },
    },
  };
  for (const entry of plan.resource_changes) {
    entry.change.before = structuredClone(entry.change.after);
    entry.change.actions = ["no-op"];
    entry.change.after_unknown = {};
  }
  Object.assign(input, {
    enable_sandbox_search_permissions: true,
    search_transcripts_bucket: "synthetic-transcripts",
  });
  Object.assign(
    plan.variables,
    Object.fromEntries(
      Object.entries(input).map(([key, value]) => [key, { value }]),
    ),
  );
  const whole = expectedSearchProvisioningPolicy(
    input.sandbox_account_id,
    input.kms_key_arn,
    input.search_transcripts_bucket,
  );
  const keySids = ["SearchStateKey", "SearchStateGrant", "SearchVectorKey"];
  const binding = {
    accountId: input.sandbox_account_id,
    kmsKeyArn: input.kms_key_arn,
    transcriptBucket: input.search_transcripts_bucket,
    policySha256: {},
  };
  for (const keys of [false, true]) {
    const name = keys ? "sandbox_search_keys" : "sandbox_search";
    const policyName = keys
      ? "meeting-notes-sandbox-search-key-use"
      : "meeting-notes-sandbox-search-provisioning";
    const policy = JSON.stringify({
      Version: "2012-10-17",
      Statement: whole.Statement.filter(
        (s) => keySids.includes(s.Sid) === keys,
      ),
    });
    binding.policySha256[keys ? "keys" : "resources"] = hash(policy);
    for (const type of ["aws_iam_policy", "aws_iam_role_policy_attachment"]) {
      const address = `${type}.${name}`;
      plan.configuration.root_module.resources.push({
        address,
        provider_config_key: "aws",
        count_expression: {
          references: ["var.enable_sandbox_search_permissions"],
        },
        expressions:
          type === "aws_iam_role_policy_attachment"
            ? {
                policy_arn: {
                  references: [
                    `aws_iam_policy.${name}`,
                    `aws_iam_policy.${name}[0].arn`,
                    `aws_iam_policy.${name}[0]`,
                  ],
                },
              }
            : {},
      });
      const after =
        type === "aws_iam_policy"
          ? { name: policyName, path: "/", name_prefix: null, policy }
          : { role: "meeting-notes-sandbox-github-terraform" };
      plan.resource_changes.push({
        address: `${address}[0]`,
        type,
        name,
        mode: "managed",
        provider_name: "registry.terraform.io/hashicorp/aws",
        change: {
          actions: ["create"],
          before: null,
          after,
          after_unknown:
            type === "aws_iam_policy"
              ? {
                  arn: true,
                  id: true,
                  attachment_count: true,
                  policy_id: true,
                  tags_all: true,
                }
              : { id: true, policy_arn: true },
        },
      });
    }
  }
  plan.applyable = true;
  return { plan, binding, input };
}

test("exact managed grants fit both IAM policy limits and accept install", () => {
  const c = candidate();
  assert.equal(validateSearchAccessPlan(c.plan, c.binding), true);
  for (const entry of c.plan.resource_changes.filter(
    (r) => r.type === "aws_iam_policy",
  ))
    assert.ok(entry.change.after.policy.length <= 6144);
});

for (const [name, mutate] of Object.entries({
  "production attachment": (c) => {
    c.plan.resource_changes.at(-1).change.after.role =
      "meeting-notes-prod-github-terraform";
  },
  "widened KMS context": (c) => {
    const p = c.plan.resource_changes.find(
      (r) => r.address === "aws_iam_policy.sandbox_search_keys[0]",
    );
    const v = JSON.parse(p.change.after.policy);
    delete v.Statement[0].Condition;
    p.change.after.policy = JSON.stringify(v);
    c.binding.policySha256.keys = hash(p.change.after.policy);
  },
  "unrelated mutation": (c) => {
    c.plan.resource_changes[0].change.actions = ["update"];
  },
  drift: (c) => {
    c.plan.resource_drift = [{}];
  },
  "mismatched identity": (c) => {
    c.binding.accountId = "999999999999";
  },
  "missing target": (c) => {
    c.plan.resource_changes.pop();
  },
  "unknown policy": (c) => {
    c.plan.resource_changes.find(
      (r) => r.address === "aws_iam_policy.sandbox_search[0]",
    ).change.after_unknown.policy = true;
  },
  "unbound attachment": (c) => {
    c.plan.configuration.root_module.resources.at(
      -1,
    ).expressions.policy_arn.references = ["aws_iam_policy.other"];
  },
}))
  test(`refuses ${name}`, () => {
    const c = candidate();
    mutate(c);
    assert.throws(() => validateSearchAccessPlan(c.plan, c.binding));
  });

test("default-off resources preserve the original cold bootstrap guard", () => {
  const plan = fixture("create-plan.json"),
    binding = fixture("reviewed-binding.json");
  plan.variables.enable_sandbox_search_permissions = { value: false };
  plan.variables.search_transcripts_bucket = { value: "" };
  for (const type of ["aws_iam_policy", "aws_iam_role_policy_attachment"])
    for (const name of ["sandbox_search", "sandbox_search_keys"])
      plan.configuration.root_module.resources.push({
        address: `${type}.${name}`,
        provider_config_key: "aws",
        count_expression: {
          references: ["var.enable_sandbox_search_permissions"],
        },
      });
  assert.equal(validateBootstrapPlan(plan, binding), true);
  plan.variables.enable_sandbox_search_permissions.value = true;
  assert.throws(() => validateBootstrapPlan(plan, binding));
});

test("installed grants can only be preserved unchanged under later bootstrap reviews", () => {
  const c = candidate();
  for (const entry of c.plan.resource_changes) {
    if (!entry.address.includes("sandbox_search")) continue;
    if (entry.type === "aws_iam_role_policy_attachment")
      entry.change.after.policy_arn = `arn:aws:iam::${c.input.sandbox_account_id}:policy/${entry.name === "sandbox_search_keys" ? "meeting-notes-sandbox-search-key-use" : "meeting-notes-sandbox-search-provisioning"}`;
    entry.change.before = structuredClone(entry.change.after);
    entry.change.actions = ["no-op"];
    entry.change.after_unknown = {};
  }
  const kept = preserveInstalledSearchAccess(c.plan, { variables: c.input });
  assert.ok(
    !kept.plan.resource_changes.some((r) =>
      r.address.includes("sandbox_search"),
    ),
  );
  c.plan.resource_changes.at(-1).change.actions = ["delete"];
  assert.throws(() =>
    preserveInstalledSearchAccess(c.plan, { variables: c.input }),
  );
});

test("mocked provider HCL policies match the independent contract when capture is supplied", () => {
  if (!process.env.SANDBOX_BOOTSTRAP_SEARCH_MOCK_PLAN_JSONL) return;
  const rows = readFileSync(
    process.env.SANDBOX_BOOTSTRAP_SEARCH_MOCK_PLAN_JSONL,
    "utf8",
  )
    .trim()
    .split(/\r?\n/)
    .map((row) => JSON.parse(row));
  const plan = rows.find(
    (row) => row.type === "test_plan" && row["@testrun"] === "enabled",
  )?.test_plan;
  assert.ok(plan);
  const c = candidate();
  for (const entry of c.plan.resource_changes.filter(
    (r) => r.type === "aws_iam_policy",
  )) {
    const native = plan.resource_changes.find(
      (r) => r.address === entry.address,
    );
    assert.deepEqual(
      JSON.parse(native.change.after.policy),
      JSON.parse(entry.change.after.policy),
    );
  }
});
