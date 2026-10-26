"use strict";
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const hash = (s) => createHash("sha256").update(s).digest("hex");
function validateBootstrapPlan(plan, binding) {
  assert.equal(
    binding.backendKey,
    "meeting-notes-terraform/production-bootstrap/state",
  );
  const v = binding.variables;
  assert.deepEqual(Object.keys(v).sort(), [
    "administrator_role_arn",
    "aws_region",
    "enable_private_evidence_store",
    "enable_production_terraform_role",
    "environment",
    "github_owner_id",
    "github_repository_id",
    "kms_key_arn",
    "production_account_id",
    "production_certificate_arn",
    "production_hosted_zone_id",
    "reviewer_role_arn",
  ]);
  assert.equal(v.environment, "prod");
  assert.equal(v.aws_region, "us-east-1");
  assert.equal(v.enable_private_evidence_store, true);
  assert.equal(v.enable_production_terraform_role, true);
  assert.match(v.production_account_id, /^\d{12}$/);
  assert.match(
    v.kms_key_arn,
    new RegExp(
      `^arn:aws:kms:us-east-1:${v.production_account_id}:key/[a-f0-9-]{36}$`,
    ),
  );
  assert.equal(plan.format_version, "1.2");
  assert.equal(plan.terraform_version, "1.16.0");
  assert.equal(plan.applyable, true);
  assert.equal(plan.complete, true);
  assert.equal(plan.errored, false);
  assert.deepEqual(plan.deferred_changes ?? [], []);
  assert.deepEqual(plan.resource_drift ?? [], []);
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(plan.variables).map(([k, x]) => [k, x.value]),
    ),
    v,
  );
  const expected = expectedResources(v);
  const configuration = plan.configuration.root_module.resources;
  assert.ok(Array.isArray(configuration));
  assert.ok(Array.isArray(plan.resource_changes));
  const seen = new Set();
  for (const r of plan.resource_changes) {
    assert.equal(r.provider_name, "registry.terraform.io/hashicorp/aws");
    assert.ok(!seen.has(r.address), "duplicate address");
    seen.add(r.address);
    assert.ok(!Object.hasOwn(r, "previous_address"), "move refused");
    assert.ok(!Object.hasOwn(r.change, "importing"), "import refused");
    validateResource(r, configuration, expected, binding);
  }
  assert.ok(
    Object.keys(expected).every((address) => seen.has(address)),
    "missing bootstrap resource",
  );
  return true;
}
function expectedResources(v) {
  const bucket = `meeting-notes-prod-private-evidence-${v.production_account_id}`;
  const role = "meeting-notes-prod-github-terraform";
  return {
    "aws_s3_bucket.private_evidence[0]": { bucket, force_destroy: false },
    "aws_s3_bucket_public_access_block.private_evidence[0]": {
      bucket,
      block_public_acls: true,
      block_public_policy: true,
      ignore_public_acls: true,
      restrict_public_buckets: true,
    },
    "aws_s3_bucket_ownership_controls.private_evidence[0]": {
      bucket,
      rule: [{ object_ownership: "BucketOwnerEnforced" }],
    },
    "aws_s3_bucket_versioning.private_evidence[0]": {
      bucket,
      versioning_configuration: [{ status: "Enabled" }],
    },
    "aws_s3_bucket_server_side_encryption_configuration.private_evidence[0]": {
      bucket,
      rule: [
        {
          apply_server_side_encryption_by_default: [
            { sse_algorithm: "aws:kms", kms_master_key_id: v.kms_key_arn },
          ],
          bucket_key_enabled: false,
        },
      ],
    },
    "aws_s3_bucket_policy.private_evidence[0]": { bucket },
    "aws_iam_role.production_terraform[0]": {
      name: role,
      path: "/",
      max_session_duration: 3600,
    },
    "aws_iam_role_policy.production_terraform[0]": {
      name: "meeting-notes-prod-terraform-prerequisites",
      role,
    },
  };
}
function expectedData(v) {
  return {
    "data.aws_caller_identity.current[0]": {
      account_id: v.production_account_id,
    },
    "data.aws_kms_key.existing[0]": {
      key_id: v.kms_key_arn,
      arn: v.kms_key_arn,
      aws_account_id: v.production_account_id,
      key_state: "Enabled",
    },
    "data.aws_iam_openid_connect_provider.github[0]": {
      arn: `arn:aws:iam::${v.production_account_id}:oidc-provider/token.actions.githubusercontent.com`,
    },
  };
}
function validateResource(r, configuration, expected, binding) {
  assertResourceIdentity(r);
  const configured = configuration.filter(
    (c) => c.address === r.address.replace("[0]", ""),
  );
  assert.equal(
    configured.length,
    1,
    "missing or duplicate resource configuration",
  );
  const config = configured[0];
  assert.equal(config.mode, r.mode);
  assert.equal(config.type, r.type);
  assert.equal(config.name, r.name);
  if (r.mode === "data") {
    assert.ok(
      Object.hasOwn(expectedData(binding.variables), r.address),
      "unexpected data read",
    );
    assert.ok(
      ["read", "no-op"].includes(r.change.actions?.[0]) &&
        r.change.actions.length === 1,
    );
    assertValues(r.change, expectedData(binding.variables)[r.address]);
    validateDataIdentity(r, binding.variables.production_account_id);
    return;
  }
  validateManagedResource(r, config, expected, binding);
}
function validateManagedResource(r, config, expected, binding) {
  const documents = {
    "aws_s3_bucket_policy.private_evidence[0]": ["policy", "bucket"],
    "aws_iam_role.production_terraform[0]": ["assume_role_policy", "trust"],
    "aws_iam_role_policy.production_terraform[0]": ["policy", "role"],
  };
  assert.equal(r.mode, "managed");
  assert.ok(Object.hasOwn(expected, r.address), "unexpected resource");
  assert.deepEqual(r.change.actions, ["create"]);
  assert.equal(r.change.before, null);
  assert.ok(r.change.after && !Array.isArray(r.change.after));
  assertValues(r.change, expected[r.address]);
  if (r.address === "aws_s3_bucket.private_evidence[0]")
    assertNoEmbeddedControls(r.change, config, [
      "lifecycle_rule",
      "replication_configuration",
      "object_lock_configuration",
      "grant",
      "policy",
      "acl",
      "logging",
      "website",
      "cors_rule",
      "server_side_encryption_configuration",
      "versioning",
    ]);
  if (r.address === "aws_iam_role.production_terraform[0]") {
    assertNoEmbeddedControls(r.change, config, [
      "inline_policy",
      "managed_policy_arns",
      "permissions_boundary",
    ]);
    assertKnown(r.change.after_unknown?.permissions_boundary, null);
    assertKnown(r.change.after_unknown?.force_detach_policies, false);
    assert.ok(!r.change.after.force_detach_policies);
  }
  if (documents[r.address]) {
    const [key, name] = documents[r.address];
    assert.ok(!r.change.after_unknown?.[key]);
    assert.match(binding.policySha256[name], /^[a-f0-9]{64}$/);
    assert.equal(
      hash(r.change.after[key]),
      binding.policySha256[name],
      `unreviewed ${name} policy bytes`,
    );
    validatePolicy(r.change.after[key], name);
  }
}
function assertResourceIdentity(r) {
  const parts = r.mode === "data" ? ["data", r.type, r.name] : [r.type, r.name];
  assert.equal(r.index, 0);
  assert.equal(r.address, `${parts.join(".")}[0]`);
}
function assertValues(change, values) {
  assertKnown(change.after_unknown, values);
  assert.ok(change.after && !Array.isArray(change.after));
  for (const [key, value] of Object.entries(values)) {
    // Providers add computed defaults within configuration blocks.
    assert.deepEqual(project(change.after[key], value), value);
  }
}
function validateDataIdentity(r, account) {
  if (r.type === "aws_caller_identity") {
    assertKnown(r.change.after_unknown?.arn, "");
    assert.match(
      r.change.after.arn,
      new RegExp(`^arn:aws:(iam|sts)::${account}:.+$`),
    );
  }
  if (r.type === "aws_iam_openid_connect_provider") {
    assertKnown(r.change.after_unknown?.url, "");
    // IAM readback may omit the scheme; the pinned provider copies it verbatim.
    assert.ok(
      [
        "https://token.actions.githubusercontent.com",
        "token.actions.githubusercontent.com",
      ].includes(r.change.after.url),
    );
    assertKnown(
      r.change.after_unknown?.client_id_list,
      r.change.after.client_id_list,
    );
    assert.ok(Array.isArray(r.change.after.client_id_list));
    assert.ok(r.change.after.client_id_list.includes("sts.amazonaws.com"));
  }
}
function assertNoEmbeddedControls(change, config, keys) {
  for (const key of keys) {
    assert.ok(
      !Object.hasOwn(config.expressions, key),
      `configured embedded ${key}`,
    );
    const value = change.after[key];
    assert.ok(
      value == null || (Array.isArray(value) && value.length === 0),
      `embedded ${key}`,
    );
  }
  // Unconfigured Optional+Computed fields are unknown on a legitimate create.
  if (config.type === "aws_s3_bucket") {
    assert.ok(!Object.hasOwn(config.expressions, "object_lock_enabled"));
    assert.ok(change.after.object_lock_enabled !== true);
  }
}
function validatePolicy(text, name) {
  const policy = JSON.parse(text);
  assertObject(policy);
  assert.equal(policy.Version, "2012-10-17");
  assert.ok(Array.isArray(policy.Statement) && policy.Statement.length > 0);
  for (const statement of policy.Statement) {
    assertObject(statement);
    assert.ok(["Allow", "Deny"].includes(statement.Effect));
    assertAlternative(statement, "Action", "NotAction");
    if (name === "trust") {
      assertObject(statement.Principal);
      assertStringList(statement.Principal.Federated);
    } else {
      assertAlternative(statement, "Resource", "NotResource");
      if (name === "bucket") assertPrincipal(statement.Principal);
    }
  }
}
function assertAlternative(statement, positive, negative) {
  assert.notEqual(
    Object.hasOwn(statement, positive),
    Object.hasOwn(statement, negative),
  );
  assertStringList(
    statement[Object.hasOwn(statement, positive) ? positive : negative],
  );
}
function assertPrincipal(principal) {
  if (principal === "*") return;
  assertObject(principal);
  assert.ok(Object.keys(principal).length > 0);
  Object.values(principal).forEach(assertStringList);
}
function assertObject(value) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
}
function assertStringList(value) {
  const values = Array.isArray(value) ? value : [value];
  assert.ok(
    values.length > 0 &&
      values.every((v) => typeof v === "string" && v.trim().length > 0),
  );
}
function assertKnown(unknown, expected) {
  assert.notEqual(unknown, true, "unknown required field");
  if (Array.isArray(expected))
    expected.forEach((v, i) => assertKnown(unknown?.[i], v));
  else if (expected && typeof expected === "object")
    Object.entries(expected).forEach(([k, v]) => assertKnown(unknown?.[k], v));
}
function project(actual, expected) {
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual));
    assert.equal(actual.length, expected.length);
    return actual.map((x, i) => project(x, expected[i]));
  }
  if (expected && typeof expected === "object") {
    assert.ok(actual && typeof actual === "object");
    return Object.fromEntries(
      Object.entries(expected).map(([k, v]) => [k, project(actual[k], v)]),
    );
  }
  return actual;
}
if (require.main === module) {
  assert.equal(
    process.argv.length,
    4,
    "usage: node verify-plan.cjs private-plan.json reviewed-binding.json",
  );
  validateBootstrapPlan(
    JSON.parse(readFileSync(process.argv[2], "utf8")),
    JSON.parse(readFileSync(process.argv[3], "utf8")),
  );
  process.stdout.write(
    "Bootstrap create-only plan matches reviewed bindings.\n",
  );
}
module.exports = { validateBootstrapPlan };
