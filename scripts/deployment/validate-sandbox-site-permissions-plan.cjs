"use strict";
const assert = require("node:assert/strict");
const { readFileSync, readdirSync, lstatSync } = require("node:fs");
const { join } = require("node:path");
const { isUtf8 } = require("node:buffer");
const { digest } = require("./collector-payload.cjs");
const {
  validateScopedPlan,
  assertOtherwiseUnchanged,
} = require("./validate-prerequisite-plan.cjs");
const { hasUnknown, without } = require("./terraform-meeting-update.cjs");
const {
  prepareSandboxSiteSession,
  writeSandboxSiteSessionOutput,
} = require("./sandbox-site-session.cjs");
const { storageBinding } = require("./private-capture.cjs");
const policyAddress = "aws_iam_policy.site_publishing[0]";
const attachmentAddress = "aws_iam_role_policy_attachment.site_publishing[0]";
const roleAddress = "aws_iam_role.sandbox_deploy[0]";
const policyName = "meeting-notes-sandbox-site-publishing";
const roleName = "meeting-notes-sandbox-github-deploy";
// Reviewed direct attachment expression. Normalize source line endings only.
const siteSourceSha256 =
  "513d11b5602001d0e8db03d5240a3dd83f393a1342f9d1c2e50ad435f8a5fd9b";
const sandboxSitePermissionsTargets = new Map([
  [policyAddress, ["create", "update"]],
  [attachmentAddress, ["create"]],
]);
const policyArn = (b) => `arn:aws:iam::${b.accountId}:policy/${policyName}`;
function sandboxSitePermissionsBinding(storage, variables) {
  const s = storageBinding.parse(storage);
  assert.ok(
    variables && !Array.isArray(variables) && typeof variables === "object",
  );
  for (const site of ["frontend", "docs"]) {
    prepareSandboxSiteSession(variables, site);
    const aliases = Object.keys(variables).filter(
      (key) =>
        key.startsWith("TFVAR_") &&
        key.slice(6).toLowerCase() === `${site}_distribution_id`,
    );
    assert.equal(aliases.length, 1);
    assert.equal(
      variables[aliases[0]],
      variables[`${site.toUpperCase()}_DISTRIBUTION_ID`],
    );
  }
  assert.equal(s.accountId, variables.AWS_ACCOUNT_ID);
  assert.equal(s.region, variables.AWS_REGION);
  assert.equal(
    variables.SANDBOX_BACKEND_DEPLOY_ROLE_ARN,
    `arn:aws:iam::${s.accountId}:role/${roleName}`,
  );
  assert.ok(
    s.kmsKeyArn.startsWith(`arn:aws:kms:${s.region}:${s.accountId}:key/`),
  );
  return {
    environment: "sandbox",
    accountId: s.accountId,
    region: s.region,
    kmsKeyArn: s.kmsKeyArn,
    frontendBucket: variables.FRONTEND_BUCKET,
    docsBucket: variables.DOCS_BUCKET,
    frontendDistributionId: variables.FRONTEND_DISTRIBUTION_ID,
    docsDistributionId: variables.DOCS_DISTRIBUTION_ID,
    deploymentRoleArn: variables.SANDBOX_BACKEND_DEPLOY_ROLE_ARN,
  };
}
function assertBinding(b) {
  assert.equal(b.environment, "sandbox");
  assert.match(
    b.kmsKeyArn,
    new RegExp(`^arn:aws:kms:${b.region}:${b.accountId}:key/[a-f0-9-]{36}$`),
  );
  assert.equal(
    b.deploymentRoleArn,
    `arn:aws:iam::${b.accountId}:role/${roleName}`,
  );
  for (const site of ["frontend", "docs"])
    prepareSandboxSiteSession(
      {
        AWS_ACCOUNT_ID: b.accountId,
        AWS_REGION: b.region,
        SANDBOX_BACKEND_DEPLOY_ROLE_ARN: b.deploymentRoleArn,
        [`${site.toUpperCase()}_BUCKET`]: b[`${site}Bucket`],
        [`${site.toUpperCase()}_DISTRIBUTION_ID`]: b[`${site}DistributionId`],
      },
      site,
    );
}
function expectedPolicy(b) {
  const buckets = [b.frontendBucket, b.docsBucket].map(
    (name) => `arn:aws:s3:::${name}`,
  );
  const objects = buckets.map((arn) => `${arn}/*`);
  const distributions = [b.frontendDistributionId, b.docsDistributionId].map(
    (id) => `arn:aws:cloudfront::${b.accountId}:distribution/${id}`,
  );
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "SiteBuckets",
        Effect: "Allow",
        Action: ["s3:ListBucket"],
        Resource: buckets,
      },
      {
        Sid: "SiteObjects",
        Effect: "Allow",
        Action: ["s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload"],
        Resource: objects,
      },
      {
        Sid: "SiteInvalidation",
        Effect: "Allow",
        Action: ["cloudfront:CreateInvalidation"],
        Resource: distributions,
      },
      {
        Sid: "DocsPreflightAndWait",
        Effect: "Allow",
        Action: ["cloudfront:GetDistribution", "cloudfront:GetInvalidation"],
        Resource: [distributions[1]],
      },
      {
        Sid: "SiteObjectEncryption",
        Effect: "Allow",
        Action: ["kms:GenerateDataKey", "kms:Decrypt"],
        Resource: [b.kmsKeyArn],
        Condition: {
          StringEquals: {
            "kms:CallerAccount": b.accountId,
            "kms:ViaService": `s3.${b.region}.amazonaws.com`,
          },
          StringLike: { "kms:EncryptionContext:aws:s3:arn": objects },
        },
      },
    ],
  };
}
// IAM arrays are sets; retain every member and every object key during comparison.
function canonical(value) {
  if (Array.isArray(value))
    return value
      .map(canonical)
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, member]) => [key, canonical(member)]),
    );
  return value;
}
function unchanged(change) {
  assert.ok(
    change.before && change.after && !hasUnknown(change.after_unknown ?? {}),
  );
  assert.deepEqual(change.before, change.after);
}
function checkComputedPolicyFields(change, created) {
  const computed = [
    "arn",
    "id",
    "attachment_count",
    "policy_id",
    "name_prefix",
  ];
  assert.ok(
    !hasUnknown(without(change.after_unknown ?? {}, created ? computed : [])),
  );
  const after = change.after;
  if (Object.hasOwn(change.after_unknown ?? {}, "name_prefix"))
    assert.equal(typeof change.after_unknown.name_prefix, "boolean");
  for (const field of computed)
    if (change.after_unknown?.[field] === true)
      assert.equal(after[field] ?? null, null);
}
function checkPolicy(change, b) {
  const created = change.actions[0] === "create";
  checkComputedPolicyFields(change, created);
  const after = change.after;
  assert.equal(after.name, policyName);
  assert.equal(after.path, "/");
  assert.ok(after.description == null || after.description === "");
  assert.deepEqual(after.tags ?? {}, {});
  assert.deepEqual(after.tags_all, {
    Project: "meeting-notes",
    Environment: "sandbox",
    ManagedBy: "terraform",
    Service: "chronote",
  });
  for (const key of ["arn", "id"])
    if (after[key] != null || change.after_unknown?.[key] !== true)
      assert.equal(after[key], policyArn(b));
  assert.deepEqual(
    canonical(JSON.parse(after.policy)),
    canonical(expectedPolicy(b)),
  );
  if (!created)
    assertOtherwiseUnchanged(
      { before: change.before, after, unknown: change.after_unknown ?? {} },
      ["policy"],
    );
}
function assertDirectReferenceSource(directory) {
  const root = join(directory, "_infra");
  assert.ok(
    !readdirSync(root).some((name) =>
      /(^|_)override\.tf(?:\.json)?$/.test(name),
    ),
  );
  const file = join(root, "site-publishing.tf");
  assert.ok(lstatSync(file).isFile());
  const bytes = readFileSync(file);
  assert.ok(isUtf8(bytes));
  assert.equal(
    digest(Buffer.from(bytes.toString("utf8").replaceAll("\r\n", "\n"))),
    siteSourceSha256,
  );
}
function checkAttachment(change, b, plan, createdPolicy, directory) {
  const created = change.actions[0] === "create";
  assert.equal(change.after.role, roleName);
  const unknown = change.after_unknown ?? {};
  if (change.after.policy_arn != null)
    assert.equal(change.after.policy_arn, policyArn(b));
  assert.ok(!hasUnknown(without(unknown, created ? ["id", "policy_arn"] : [])));
  if (unknown.policy_arn === true) {
    assert.ok(created && createdPolicy);
    assertDirectReferenceSource(directory);
    const configured = plan.configuration.root_module.resources.filter(
      (r) => r.address === attachmentAddress.replace("[0]", ""),
    );
    assert.equal(configured.length, 1);
    assert.deepEqual(configured[0].expressions.policy_arn, {
      references: [
        "aws_iam_policy.site_publishing[0].arn",
        policyAddress,
        "aws_iam_policy.site_publishing",
      ],
    });
  } else assert.equal(change.after.policy_arn, policyArn(b));
  if (!created) unchanged(change);
}
function assertPlanContext(plan, b) {
  assert.equal(plan.format_version, "1.2");
  assert.notEqual(plan.errored, true);
  for (const name of [
    "resource_drift",
    "deferred_changes",
    "action_invocations",
  ])
    assert.deepEqual(plan[name] ?? [], []);
  assert.ok(Array.isArray(plan.checks ?? []));
  for (const check of plan.checks ?? []) {
    assert.equal(check.status, "pass");
    for (const instance of check.instances ?? [])
      assert.equal(instance.status, "pass");
  }
  for (const [name, value] of Object.entries({
    environment: "sandbox",
    project_name: "meeting-notes",
    aws_region: b.region,
    frontend_distribution_id: b.frontendDistributionId,
    docs_distribution_id: b.docsDistributionId,
  }))
    assert.deepEqual(plan.variables[name], { value });
}
function validateSiteDependencies(resources, b) {
  const dependencies = {
    "aws_s3_bucket.frontend": {
      bucket: b.frontendBucket,
      arn: `arn:aws:s3:::${b.frontendBucket}`,
    },
    "aws_s3_bucket.docs": {
      bucket: b.docsBucket,
      arn: `arn:aws:s3:::${b.docsBucket}`,
    },
    "aws_kms_key.app_general": { arn: b.kmsKeyArn },
    [roleAddress]: { name: roleName, arn: b.deploymentRoleArn },
  };
  for (const [address, values] of Object.entries(dependencies)) {
    const r = resources.get(address);
    assert.equal(r.mode, "managed");
    unchanged(r.change);
    for (const [key, value] of Object.entries(values))
      assert.equal(r.change.after[key], value);
  }
  return Object.keys(dependencies);
}
function validateSandboxSitePermissionsPlan(
  plan,
  b,
  { directory = join(__dirname, "../..") } = {},
) {
  assertBinding(b);
  assertPlanContext(plan, b);
  assert.ok(Array.isArray(plan.resource_changes));
  const resources = new Map();
  for (const r of plan.resource_changes) {
    assert.ok(!resources.has(r.address));
    resources.set(r.address, r);
  }
  const dependencyAddresses = validateSiteDependencies(resources, b);
  for (const address of sandboxSitePermissionsTargets.keys())
    assert.equal(resources.get(address)?.mode, "managed");
  const check = ({ address, change }) =>
    address === policyAddress
      ? checkPolicy(change, b)
      : checkAttachment(
          change,
          b,
          plan,
          resources.get(policyAddress).change.actions[0] === "create",
          directory,
        );
  const result = validateScopedPlan(plan, {
    targets: sandboxSitePermissionsTargets,
    requiredNoOp: dependencyAddresses,
    check,
  });
  // The shared validator skips no-ops. This scope must still verify installed policy contents.
  for (const r of plan.resource_changes)
    if (r.mode === "managed" && r.change.actions[0] === "no-op") {
      unchanged(r.change);
      if (sandboxSitePermissionsTargets.has(r.address)) check(r);
    }
  return result;
}
function prepareSandboxSitePermissionSession(b) {
  assertBinding(b);
  const policy = JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      { Effect: "Allow", Action: "*", Resource: "*" },
      { Effect: "Deny", Action: "dynamodb:UpdateTable", Resource: "*" },
      {
        Effect: "Deny",
        Action: [
          "iam:CreatePolicy",
          "iam:TagPolicy",
          "iam:CreatePolicyVersion",
        ],
        NotResource: policyArn(b),
      },
      {
        Effect: "Deny",
        Action: "iam:AttachRolePolicy",
        NotResource: b.deploymentRoleArn,
      },
    ],
  });
  assert.ok(Buffer.byteLength(policy) <= 2048);
  return { policy, masks: [...Object.values(b), policyArn(b), policy] };
}
module.exports = {
  sandboxSitePermissionsTargets,
  sandboxSitePermissionsBinding,
  prepareSandboxSitePermissionSession,
  validateSandboxSitePermissionsPlan,
};
if (require.main === module) {
  try {
    const binding = sandboxSitePermissionsBinding(
      JSON.parse(process.env.TERRAFORM_PRIVATE_STORAGE_JSON),
      JSON.parse(process.env.GITHUB_VARS_JSON),
    );
    if (process.argv[2] === "--session") {
      assert.equal(process.argv.length, 3);
      assert.ok(process.env.GITHUB_OUTPUT);
      const prepared = prepareSandboxSitePermissionSession(binding);
      writeSandboxSiteSessionOutput(prepared, process.env.GITHUB_OUTPUT);
    } else {
      assert.equal(process.argv.length, 2);
      process.stdout.write(
        JSON.stringify(
          validateSandboxSitePermissionsPlan(
            JSON.parse(readFileSync(0, "utf8")),
            binding,
          ),
        ) + "\n",
      );
    }
  } catch {
    process.stderr.write("Sandbox site permissions refused\n");
    process.exitCode = 1;
  }
}
