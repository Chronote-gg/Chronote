"use strict";
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { createHash } = require("node:crypto");
const {
  expectedSearchProvisioningPolicy,
} = require("./search-policy-contract.cjs");
const names = ["sandbox_search", "sandbox_search_keys"];
const addresses = names.flatMap((name) => [
  `aws_iam_policy.${name}[0]`,
  `aws_iam_role_policy_attachment.${name}[0]`,
]);
function unknown(value) {
  if (value === true) return true;
  if (value == null || value === false) return false;
  assert.equal(typeof value, "object", "Malformed unknown mask");
  return Object.values(value).some(unknown);
}
const hash = (value) => createHash("sha256").update(value).digest("hex");

function validateSearchResources(
  plan,
  input,
  installed = false,
  reviewedHashes,
) {
  assert.match(input.sandbox_account_id, /^\d{12}$/);
  assert.equal(input.aws_region, "us-east-1");
  assert.equal(input.environment, "sandbox");
  assert.equal(input.enable_sandbox_search_permissions, true);
  assert.equal(input.enable_private_evidence_store, true);
  assert.equal(input.enable_sandbox_terraform_role, true);
  assert.match(
    input.kms_key_arn,
    new RegExp(
      `^arn:aws:kms:us-east-1:${input.sandbox_account_id}:key/[a-f0-9-]{36}$`,
    ),
  );
  assert.match(
    input.search_transcripts_bucket,
    /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/,
  );
  const whole = expectedSearchProvisioningPolicy(
    input.sandbox_account_id,
    input.kms_key_arn,
    input.search_transcripts_bucket,
  );
  const keySids = ["SearchStateKey", "SearchStateGrant", "SearchVectorKey"];
  const expected = [false, true].map((keys) => ({
    Version: "2012-10-17",
    Statement: whole.Statement.filter(
      (statement) => keySids.includes(statement.Sid) === keys,
    ),
  }));
  const found = new Set();
  for (const entry of plan.resource_changes) {
    if (!addresses.includes(entry.address)) continue;
    assert.ok(!found.has(entry.address));
    found.add(entry.address);
    assert.equal(entry.provider_name, "registry.terraform.io/hashicorp/aws");
    assert.equal(entry.mode, "managed");
    assert.equal(entry.previous_address ?? null, null);
    assert.equal(entry.change.importing ?? null, null);
    const change = entry.change;
    assert.deepEqual(change.actions, [installed ? "no-op" : "create"]);
    if (installed) assert.deepEqual(change.before, change.after);
    else assert.equal(change.before, null);
    const index = entry.address.includes("sandbox_search_keys") ? 1 : 0;
    const policyName = index
      ? "meeting-notes-sandbox-search-key-use"
      : "meeting-notes-sandbox-search-provisioning";
    const policyArn = `arn:aws:iam::${input.sandbox_account_id}:policy/${policyName}`;
    const after = change.after;
    const mask = change.after_unknown ?? {};
    const name = names[index];
    const config = plan.configuration.root_module.resources.find(
      (resource) => resource.address === entry.address.slice(0, -3),
    );
    assert.equal(config?.provider_config_key, "aws");
    assert.deepEqual(config.count_expression, {
      references: ["var.enable_sandbox_search_permissions"],
    });
    if (entry.type === "aws_iam_policy") {
      assert.equal(after.name, policyName);
      assert.equal(after.path, "/");
      assert.ok(!after.name_prefix);
      assert.ok(!unknown(mask.policy));
      assert.deepEqual(JSON.parse(after.policy), expected[index]);
      assert.ok(after.policy.replace(/\s/g, "").length <= 6144);
      if (reviewedHashes)
        assert.equal(
          hash(after.policy),
          reviewedHashes[index ? "keys" : "resources"],
        );
      if (after.arn) assert.equal(after.arn, policyArn);
      for (const [key, pending] of Object.entries(mask))
        assert.ok(
          !unknown(pending) ||
            ["arn", "id", "attachment_count", "policy_id", "tags_all"].includes(
              key,
            ),
        );
    } else {
      assert.equal(entry.type, "aws_iam_role_policy_attachment");
      assert.equal(after.role, "meeting-notes-sandbox-github-terraform");
      if (unknown(mask.policy_arn)) {
        assert.deepEqual(config.expressions.policy_arn.references, [
          `aws_iam_policy.${name}`,
          `aws_iam_policy.${name}[0].arn`,
          `aws_iam_policy.${name}[0]`,
        ]);
      } else assert.equal(after.policy_arn, policyArn);
      for (const [key, pending] of Object.entries(mask))
        assert.ok(!unknown(pending) || ["id", "policy_arn"].includes(key));
    }
    if (installed) assert.ok(!unknown(mask));
  }
  assert.deepEqual([...found].sort(), [...addresses].sort());
}

function validateSearchAccessPlan(plan, binding) {
  assert.deepEqual(
    [
      plan.format_version,
      plan.terraform_version,
      plan.errored,
      plan.complete,
      plan.applyable,
    ],
    ["1.2", "1.16.0", false, true, true],
  );
  assert.deepEqual(Object.keys(binding).sort(), [
    "accountId",
    "kmsKeyArn",
    "policySha256",
    "transcriptBucket",
  ]);
  assert.deepEqual(Object.keys(binding.policySha256).sort(), [
    "keys",
    "resources",
  ]);
  for (const digest of Object.values(binding.policySha256))
    assert.match(digest, /^[a-f0-9]{64}$/);
  for (const field of [
    "resource_drift",
    "deferred_changes",
    "action_invocations",
    "ephemeral_resource_changes",
  ])
    assert.deepEqual(plan[field] ?? [], []);
  const input = Object.fromEntries(
    Object.entries(plan.variables).map(([key, value]) => [key, value.value]),
  );
  assert.equal(input.sandbox_account_id, binding.accountId);
  assert.equal(input.kms_key_arn, binding.kmsKeyArn);
  assert.equal(input.search_transcripts_bucket, binding.transcriptBucket);
  const caller = plan.resource_changes.find(
    (entry) => entry.address === "data.aws_caller_identity.current[0]",
  );
  assert.equal(caller?.change.after.account_id, binding.accountId);
  assert.deepEqual(plan.configuration.root_module.child_modules ?? [], []);
  const provider = plan.configuration.provider_config.aws;
  assert.equal(provider.full_name, "registry.terraform.io/hashicorp/aws");
  assert.deepEqual(provider.expressions.allowed_account_ids, {
    references: ["var.enable_private_evidence_store", "var.sandbox_account_id"],
  });
  assert.deepEqual(provider.expressions.region, {
    references: ["var.aws_region"],
  });
  validateSearchResources(plan, input, false, binding.policySha256);
  for (const entry of plan.resource_changes) {
    if (addresses.includes(entry.address)) continue;
    assert.equal(entry.previous_address ?? null, null);
    assert.equal(entry.change.importing ?? null, null);
    assert.deepEqual(entry.change.actions, ["no-op"]);
    assert.deepEqual(entry.change.before, entry.change.after);
    assert.ok(!unknown(entry.change.after_unknown ?? {}));
  }
  for (const check of plan.checks ?? []) assert.equal(check.status, "pass");
  for (const output of Object.values(plan.output_changes ?? {}))
    assert.deepEqual(output.actions, ["no-op"]);
  return true;
}

function preserveInstalledSearchAccess(plan, binding) {
  if (!Object.hasOwn(binding.variables, "enable_sandbox_search_permissions"))
    return { plan, binding };
  for (const field of [
    "enable_sandbox_search_permissions",
    "search_transcripts_bucket",
  ])
    assert.deepEqual(plan.variables[field]?.value, binding.variables[field]);
  validateSearchResources(plan, binding.variables, true);
  const keptPlan = structuredClone(plan),
    keptBinding = structuredClone(binding);
  for (const field of [
    "enable_sandbox_search_permissions",
    "search_transcripts_bucket",
  ]) {
    delete keptPlan.variables[field];
    delete keptBinding.variables[field];
  }
  keptPlan.resource_changes = keptPlan.resource_changes.filter(
    (entry) => !addresses.includes(entry.address),
  );
  keptPlan.configuration.root_module.resources =
    keptPlan.configuration.root_module.resources.filter(
      (entry) => !addresses.includes(entry.address + "[0]"),
    );
  keptPlan.checks = (keptPlan.checks ?? []).filter(
    (check) =>
      ![
        "var.enable_sandbox_search_permissions",
        "var.search_transcripts_bucket",
        "aws_iam_policy.sandbox_search",
      ].includes(check.address.to_display),
  );
  return { plan: keptPlan, binding: keptBinding };
}
module.exports = {
  validateSearchAccessPlan,
  preserveInstalledSearchAccess,
  addresses,
};
if (require.main === module) {
  assert.equal(process.argv.length, 4);
  validateSearchAccessPlan(
    JSON.parse(readFileSync(process.argv[2], "utf8")),
    JSON.parse(readFileSync(process.argv[3], "utf8")),
  );
  console.log("Accepted exact Sandbox search permission creates");
}
