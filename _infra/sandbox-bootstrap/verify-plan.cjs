"use strict";
const strict = require("node:assert/strict");
const fs = require("node:fs");
const crypto = require("node:crypto");
const {
  expectedBucketPolicy,
  expectedTrustPolicy,
  expectedRolePolicy,
} = require("./policy-contracts.cjs");
const AWS = "registry.terraform.io/hashicorp/aws";
const VARIABLE_NAMES = [
  "administrator_role_arn",
  "aws_region",
  "enable_private_evidence_store",
  "enable_sandbox_terraform_role",
  "environment",
  "github_owner_id",
  "github_repository_id",
  "kms_key_arn",
  "reviewer_role_arn",
  "sandbox_account_id",
  "site_docs_bucket",
  "site_frontend_bucket",
  "trusted_refs",
];
const TRUSTED_REFS = [
  "refs/heads/codex/sandbox-terraform-capture",
  "refs/heads/master",
];
const digest = (bytes) =>
  crypto.createHash("sha256").update(bytes).digest("hex");
const insist = (condition, reason) => strict.ok(condition, reason);

function bindingVariables(binding) {
  strict.equal(
    binding.backendKey,
    "meeting-notes-terraform/sandbox-bootstrap/state",
  );
  const input = binding.variables;
  strict.deepEqual(Object.keys(input).sort(), VARIABLE_NAMES);
  strict.match(input.sandbox_account_id, /^\d{12}$/);
  strict.equal(input.environment, "sandbox");
  strict.equal(input.aws_region, "us-east-1");
  insist(
    input.enable_private_evidence_store === true &&
      input.enable_sandbox_terraform_role === true,
    "both reviewed flags must be enabled",
  );
  strict.deepEqual(input.trusted_refs, TRUSTED_REFS);
  strict.match(
    input.kms_key_arn,
    new RegExp(
      `^arn:aws:kms:us-east-1:${input.sandbox_account_id}:key/[a-f0-9-]{36}$`,
    ),
  );
  for (const field of ["github_owner_id", "github_repository_id"])
    strict.match(input[field], /^[1-9][0-9]+$/);
  const excluded = [
    "github-terraform",
    "ecs-task-app-role",
    "ecs-task-exec-role",
  ];
  for (const field of ["administrator_role_arn", "reviewer_role_arn"]) {
    strict.match(
      input[field],
      new RegExp(
        `^arn:aws:iam::${input.sandbox_account_id}:role/[A-Za-z0-9_+=,.@/-]+$`,
      ),
    );
    insist(
      !excluded.some(
        (name) =>
          input[field] ===
          `arn:aws:iam::${input.sandbox_account_id}:role/meeting-notes-sandbox-${name}`,
      ),
      "executor/runtime cannot be the administrator or reader",
    );
  }
  validateSiteBuckets(input);
  return input;
}

function validateSiteBuckets(input) {
  for (const field of ["site_frontend_bucket", "site_docs_bucket"]) {
    strict.match(input[field], /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/);
    insist(
      !input[field].includes("..") &&
        !/^\d+\.\d+\.\d+\.\d+$/.test(input[field]) &&
        !/^(xn--|sthree-|amzn-s3-demo-)/.test(input[field]) &&
        !/(-s3alias|--ol-s3|\.mrap|--x-s3|--table-s3)$/.test(input[field]),
      "invalid site bucket",
    );
  }
}
function managedValues(input) {
  const bucket = `meeting-notes-sandbox-private-evidence-${input.sandbox_account_id}`;
  const role = "meeting-notes-sandbox-github-terraform";
  return {
    aws_s3_bucket: { bucket, force_destroy: false },
    aws_s3_bucket_public_access_block: {
      bucket,
      block_public_acls: true,
      block_public_policy: true,
      ignore_public_acls: true,
      restrict_public_buckets: true,
    },
    aws_s3_bucket_ownership_controls: {
      bucket,
      rule: [{ object_ownership: "BucketOwnerEnforced" }],
    },
    aws_s3_bucket_versioning: {
      bucket,
      versioning_configuration: [{ status: "Enabled" }],
    },
    aws_s3_bucket_server_side_encryption_configuration: {
      bucket,
      rule: [
        {
          bucket_key_enabled: false,
          apply_server_side_encryption_by_default: [
            { sse_algorithm: "aws:kms", kms_master_key_id: input.kms_key_arn },
          ],
        },
      ],
    },
    aws_s3_bucket_policy: { bucket },
    aws_iam_role: { name: role, path: "/", max_session_duration: 3600 },
    aws_iam_role_policy: {
      name: "meeting-notes-sandbox-terraform-prerequisites",
      role,
    },
  };
}
function resourceName(type) {
  return type.startsWith("aws_s3_") ? "private_evidence" : "sandbox_terraform";
}
function metadataValues(input) {
  return {
    aws_caller_identity: ["current", { account_id: input.sandbox_account_id }],
    aws_kms_key: [
      "existing",
      {
        key_id: input.kms_key_arn,
        arn: input.kms_key_arn,
        aws_account_id: input.sandbox_account_id,
        key_state: "Enabled",
      },
    ],
    aws_iam_openid_connect_provider: [
      "github",
      {
        arn: `arn:aws:iam::${input.sandbox_account_id}:oidc-provider/token.actions.githubusercontent.com`,
      },
    ],
  };
}
function knownShape(actual, unknown, wanted) {
  insist(unknown !== true, "unknown required control");
  if (Array.isArray(wanted)) {
    insist(
      Array.isArray(actual) && actual.length === wanted.length,
      "changed control block",
    );
    wanted.forEach((entry, index) =>
      knownShape(actual[index], unknown?.[index], entry),
    );
  } else if (wanted !== null && typeof wanted === "object") {
    insist(
      actual !== null && typeof actual === "object" && !Array.isArray(actual),
      "missing control block",
    );
    for (const field of Object.keys(wanted))
      knownShape(actual[field], unknown?.[field], wanted[field]);
  } else strict.deepEqual(actual, wanted);
}
function noEmbeddedControls(change, config, fields) {
  for (const field of fields) {
    insist(
      !Object.hasOwn(config.expressions, field),
      `configured embedded ${field}`,
    );
    const control = change.after[field];
    insist(
      control == null || (Array.isArray(control) && control.length === 0),
      `embedded ${field}`,
    );
  }
}
function validateStorageAndRole(entry, config, binding) {
  const { change, type } = entry;
  if (type === "aws_s3_bucket") {
    noEmbeddedControls(change, config, [
      "acl",
      "grant",
      "policy",
      "lifecycle_rule",
      "replication_configuration",
      "object_lock_configuration",
      "logging",
      "website",
      "cors_rule",
      "server_side_encryption_configuration",
      "versioning",
    ]);
    insist(
      !Object.hasOwn(config.expressions, "object_lock_enabled") &&
        change.after.object_lock_enabled !== true,
      "object lock is outside this bootstrap",
    );
  }
  if (type === "aws_iam_role") {
    validateObservedInlinePolicy(entry, config, binding);
    noEmbeddedControls(change, config, [
      "managed_policy_arns",
      "permissions_boundary",
    ]);
    knownShape(
      change.after.permissions_boundary ?? null,
      change.after_unknown?.permissions_boundary,
      null,
    );
    knownShape(
      change.after.force_detach_policies ?? false,
      change.after_unknown?.force_detach_policies,
      false,
    );
  }
}
function validateObservedInlinePolicy(entry, config, binding) {
  const inline = entry.change.after.inline_policy ?? [];
  if (entry.change.actions[0] !== "no-op" || inline.length === 0) {
    noEmbeddedControls(entry.change, config, ["inline_policy"]);
    return;
  }
  insist(
    !Object.hasOwn(config.expressions, "inline_policy"),
    "configured embedded inline_policy",
  );
  strict.equal(inline.length, 1);
  strict.deepEqual(Object.keys(inline[0]).sort(), ["name", "policy"]);
  strict.equal(inline[0].name, "meeting-notes-sandbox-terraform-prerequisites");
  strict.equal(
    digest(inline[0].policy),
    binding.previousRolePolicySha256,
    "unreviewed refreshed inline policy",
  );
}
function approvedPolicy(entry, binding) {
  const fields = {
    aws_s3_bucket_policy: ["policy", "bucket", expectedBucketPolicy],
    aws_iam_role: ["assume_role_policy", "trust", expectedTrustPolicy],
    aws_iam_role_policy: ["policy", "role", expectedRolePolicy],
  };
  const selection = fields[entry.type];
  if (!selection) return;
  const [field, label, contract] = selection;
  insist(
    entry.change.after_unknown?.[field] !== true,
    "unknown policy document",
  );
  const bytes = entry.change.after[field];
  strict.match(binding.policySha256[label], /^[a-f0-9]{64}$/);
  strict.equal(
    digest(bytes),
    binding.policySha256[label],
    `unreviewed ${label} policy bytes`,
  );
  strict.deepEqual(
    JSON.parse(bytes),
    contract(binding.variables),
    `changed ${label} security contract`,
  );
}
function validateMetadata(entry, input, approved) {
  const [name, values] = approved[entry.type] ?? [];
  insist(name && entry.name === name, "unapproved metadata source");
  strict.equal(entry.address, `data.${entry.type}.${name}[0]`);
  insist(
    entry.change.actions.length === 1 &&
      ["read", "no-op"].includes(entry.change.actions[0]),
    "metadata effects refused",
  );
  knownShape(entry.change.after, entry.change.after_unknown, values);
  if (entry.type === "aws_caller_identity") {
    knownShape(
      entry.change.after.arn,
      entry.change.after_unknown?.arn,
      entry.change.after.arn,
    );
    strict.match(
      entry.change.after.arn,
      new RegExp(`^arn:aws:(iam|sts)::${input.sandbox_account_id}:.+$`),
    );
  }
  if (entry.type === "aws_iam_openid_connect_provider") {
    const result = entry.change.after;
    knownShape(result.url, entry.change.after_unknown?.url, result.url);
    insist(
      [
        "token.actions.githubusercontent.com",
        "https://token.actions.githubusercontent.com",
      ].includes(result.url),
      "foreign OIDC issuer",
    );
    knownShape(
      result.client_id_list,
      entry.change.after_unknown?.client_id_list,
      result.client_id_list,
    );
    insist(
      Array.isArray(result.client_id_list) &&
        result.client_id_list.some(
          (audience) => audience === "sts.amazonaws.com",
        ),
      "STS audience absent",
    );
  }
}
function configuredResources(plan, managed, metadata) {
  const module = plan.configuration.root_module;
  strict.deepEqual(module.child_modules ?? [], []);
  const configs = module.resources;
  insist(Array.isArray(configs), "resource configuration missing");
  const unique = new Set();
  for (const config of configs) {
    const name =
      config.mode === "data"
        ? metadata[config.type]?.[0]
        : resourceName(config.type);
    const address = `${config.mode === "data" ? "data." : ""}${config.type}.${name}`;
    insist(
      (config.mode === "data"
        ? Object.hasOwn(metadata, config.type)
        : Object.hasOwn(managed, config.type)) && config.address === address,
      "foreign configuration",
    );
    insist(!unique.has(address), "duplicate configuration");
    insist(
      !config.provider_config_key || config.provider_config_key === "aws",
      "foreign provider configuration",
    );
    unique.add(address);
  }
  return configs;
}
function validateEnvelope(plan, input, applyable) {
  strict.deepEqual(
    [
      plan.format_version,
      plan.terraform_version,
      plan.applyable,
      plan.complete,
      plan.errored,
    ],
    ["1.2", "1.16.0", applyable, true, false],
    "incomplete or unsupported saved plan",
  );
  for (const field of [
    "deferred_changes",
    "resource_drift",
    "action_invocations",
    "ephemeral_resource_changes",
  ])
    strict.deepEqual(plan[field] ?? [], [], `unreviewed ${field}`);
  strict.deepEqual(
    Object.fromEntries(
      Object.entries(plan.variables).map(([name, value]) => [
        name,
        value.value,
      ]),
    ),
    input,
  );
  for (const check of plan.checks ?? [])
    strict.equal(check.status, "pass", "unresolved check");
}
function validateBootstrapPlan(plan, binding) {
  validateBinding(binding, false);
  const seen = validatePlan(plan, binding, validateCreate, true);
  insist(
    Object.keys(managedValues(binding.variables)).every((type) =>
      seen.has(`${type}.${resourceName(type)}[0]`),
    ),
    "missing one of eight creates",
  );
  return true;
}
function validateBinding(binding, update) {
  const fields = ["backendKey", "variables", "policySha256"];
  if (update) {
    fields.push("previousRolePolicySha256");
    strict.match(binding.previousRolePolicySha256, /^[a-f0-9]{64}$/);
  }
  strict.deepEqual(Object.keys(binding).sort(), fields.sort());
  strict.deepEqual(Object.keys(binding.policySha256).sort(), [
    "bucket",
    "role",
    "trust",
  ]);
}
function validatePlan(plan, binding, inspectManaged, applyable) {
  const input = bindingVariables(binding);
  validateEnvelope(plan, input, applyable);
  const managed = managedValues(input);
  const metadata = metadataValues(input);
  const configs = configuredResources(plan, managed, metadata);
  const seen = new Set();
  insist(Array.isArray(plan.resource_changes), "missing changes");
  for (const entry of plan.resource_changes) {
    strict.equal(entry.provider_name, AWS);
    strict.equal(entry.index, 0);
    insist(!seen.has(entry.address), "duplicate change");
    insist(
      !Object.hasOwn(entry, "previous_address") &&
        !Object.hasOwn(entry.change, "importing"),
      "move/import refused",
    );
    seen.add(entry.address);
    const config = configs.find(
      (item) => item.address === entry.address.replace(/\[0\]$/, ""),
    );
    insist(
      config &&
        config.mode === entry.mode &&
        config.type === entry.type &&
        config.name === entry.name,
      "configuration identity mismatch",
    );
    validateResourceBindings(entry, config, input);
    if (entry.mode === "data") validateMetadata(entry, input, metadata);
    else {
      strict.equal(entry.mode, "managed");
      insist(Object.hasOwn(managed, entry.type), "extra managed resource");
      strict.equal(
        entry.address,
        `${entry.type}.${resourceName(entry.type)}[0]`,
      );
      inspectManaged(entry, binding);
      validateManagedControls(entry, config, managed, binding);
    }
  }
  return seen;
}
function validateManagedControls(entry, config, managed, binding) {
  knownShape(
    entry.change.after,
    entry.change.after_unknown,
    managed[entry.type],
  );
  validateStorageAndRole(entry, config, binding);
  validateAdditionalStorageControls(entry, config);
  approvedPolicy(entry, binding);
}
function validateCreate(entry) {
  strict.deepEqual(entry.change.actions, ["create"]);
  strict.equal(entry.change.before, null);
}
function validateBootstrapSitePermissionsUpdate(plan, binding) {
  validateBinding(binding, true);
  const target = "aws_iam_role_policy.sandbox_terraform[0]";
  const changed = plan.resource_changes?.some(
    (r) => r.mode === "managed" && r.change.actions[0] !== "no-op",
  );
  const seen = validatePlan(
    plan,
    binding,
    validateUnchangedOrSitePolicy,
    changed === true,
  );
  insist(seen.has(target), "missing runner policy");
  return true;
}
function hasUnknown(value) {
  if (value === true) return true;
  return (
    value != null &&
    typeof value === "object" &&
    Object.values(value).some(hasUnknown)
  );
}
function validateUnchangedOrSitePolicy(entry, binding) {
  const { change } = entry;
  insist(!hasUnknown(change.after_unknown), "unknown update value");
  insist(change.before && change.after, "missing existing resource");
  const before = { ...change.before },
    after = { ...change.after };
  if (entry.type === "aws_iam_role_policy") {
    insist(
      change.actions.length === 1 &&
        ["update", "no-op"].includes(change.actions[0]),
      "policy effect refused",
    );
    strict.equal(
      digest(before.policy),
      binding.previousRolePolicySha256,
      "unreviewed installed role policy",
    );
    if (change.actions[0] === "update") {
      delete before.policy;
      delete after.policy;
    }
  } else strict.deepEqual(change.actions, ["no-op"]);
  strict.deepEqual(before, after, "unrelated existing field changed");
}
module.exports = {
  validateBootstrapPlan,
  validateBootstrapSitePermissionsUpdate,
};
if (require.main === module) {
  const args = process.argv.slice(2);
  insist(
    args.length === 2 ||
      (args.length === 3 && args[2] === "--site-permissions-update"),
    "usage: node verify-plan.cjs PRIVATE_PLAN_JSON REVIEWED_BINDING_JSON [--site-permissions-update]",
  );
  const validate =
    args.length === 2
      ? validateBootstrapPlan
      : validateBootstrapSitePermissionsUpdate;
  validate(
    ...args
      .slice(0, 2)
      .map((path) => JSON.parse(fs.readFileSync(path, "utf8"))),
  );
}

function bindingExpression(expression, field, expected) {
  if (expression == null) return true;
  return Object.hasOwn(expression, "constant_value")
    ? expression.constant_value === expected
    : Object.keys(expression).length === 1 &&
        Array.isArray(expression.references) &&
        expression.references.length === 1 &&
        expression.references[0] === `var.${field}`;
}
function validateResourceBindings(entry, config, input) {
  const { after, after_unknown: unknown = {} } = entry.change;
  const region = config.expressions.region;
  insist(
    bindingExpression(region, "aws_region", input.aws_region),
    "unreviewed configured resource region",
  );
  if (region != null || after.region != null)
    knownShape(after.region, unknown.region, input.aws_region);
  // AWS6 computes an omitted regional attribute during creation. It is not
  // permission to accept a known foreign region or a configured unknown region.
  const owner = config.expressions.expected_bucket_owner;
  insist(
    owner == null ||
      owner.constant_value === null ||
      bindingExpression(owner, "sandbox_account_id", input.sandbox_account_id),
    "unreviewed expected bucket owner",
  );
  insist(
    unknown.expected_bucket_owner !== true,
    "unknown expected bucket owner",
  );
  if (after.expected_bucket_owner != null)
    strict.equal(after.expected_bucket_owner, input.sandbox_account_id);
}
function hasConfiguredSetting(expression, field) {
  if (expression === null || typeof expression !== "object") return false;
  if (Object.hasOwn(expression, field)) {
    const value = expression[field];
    // Null optional defaults have no operational setting.
    if (
      value != null &&
      !(
        typeof value === "object" &&
        Object.keys(value).length === 1 &&
        value.constant_value === null
      )
    )
      return true;
  }
  return Object.values(expression).some((value) =>
    hasConfiguredSetting(value, field),
  );
}
function validateAdditionalStorageControls(entry, config) {
  const { after, after_unknown: unknown = {} } = entry.change;
  if (entry.type === "aws_s3_bucket_versioning") {
    insist(
      !Object.hasOwn(config.expressions, "mfa") &&
        after.mfa == null &&
        !unknown.mfa,
      "MFA credentials are outside the reviewed bootstrap",
    );
    insist(
      !hasConfiguredSetting(
        config.expressions.versioning_configuration,
        "mfa_delete",
      ),
      "configured MFA-delete is outside the reviewed bootstrap",
    );
    const value = after.versioning_configuration[0].mfa_delete;
    insist(
      value == null || value === "Disabled",
      "MFA-delete must remain unconfigured/disabled",
    );
  }
  if (entry.type === "aws_s3_bucket_server_side_encryption_configuration") {
    insist(
      !hasConfiguredSetting(
        config.expressions.rule,
        "blocked_encryption_types",
      ),
      "unreviewed configured encryption controls",
    );
    const blocked = after.rule[0].blocked_encryption_types;
    insist(
      blocked == null ||
        (Array.isArray(blocked) &&
          (blocked.length === 0 ||
            (blocked.length === 1 && blocked[0] === "SSE-C"))),
      "incompatible encryption controls",
    );
  }
}
