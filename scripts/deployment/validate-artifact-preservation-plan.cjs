"use strict";
const assert = require("node:assert/strict");
const {
  validateScopedPlan,
  assertOtherwiseUnchanged,
  expectedCheckInstances,
  runCli,
} = require("./validate-prerequisite-plan.cjs");

const policy = "aws_iam_policy.transcripts_s3_policy";
const { join } = require("node:path");
const {
  verifySource,
  verifyChecks,
  excludedChecks,
} = require("./terraform-meeting-model.cjs");
const { hasUnknown, without } = require("./terraform-meeting-update.cjs");
const { storageBinding } = require("./private-capture.cjs");
const { writeSandboxSiteSessionOutput } = require("./sandbox-site-session.cjs");
const authority = "aws_iam_policy.sandbox_artifact_authority[0]";
const attachment =
  "aws_iam_role_policy_attachment.sandbox_artifact_authority[0]";
const role = "aws_iam_role.sandbox_deploy[0]";
const roleName = "meeting-notes-sandbox-github-deploy";
const authorityName = "meeting-notes-sandbox-artifact-authority";
const sandboxArtifactTargets = new Map([
  [policy, ["update"]],
  [authority, ["create"]],
  [attachment, ["create"]],
]);
const iamArn = (b, kind, name) => `arn:aws:iam::${b.accountId}:${kind}/${name}`;
const artifactPreservationTargets = new Map([[policy, ["update"]]]);
const policyName = "meeting-notes-prod-bot-transcripts-s3-policy";
// The task roles' complete transcripts bucket grant, including the versioned
// read that artifact preservation needs. Nothing else may appear.
const allowedActions = [
  "s3:AbortMultipartUpload",
  "s3:GetObject",
  "s3:GetObjectVersion",
  "s3:ListBucket",
  "s3:PutObject",
];
const bucketArn = /^arn:aws:s3:::[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

const sorted = (values) => [...values].sort();

function document(value) {
  assert.equal(typeof value, "string");
  const parsed = JSON.parse(value);
  assert.equal(parsed.Version, "2012-10-17");
  const [statement, ...extra] = parsed.Statement;
  assert.equal(extra.length, 0, "the policy holds exactly one statement");
  return statement;
}

// One bucket, named twice: the bucket itself and every object in it.
function resources(statement) {
  const [arn, objects, ...extra] = statement.Resource;
  assert.equal(extra.length, 0);
  assert.match(arn, bucketArn);
  assert.equal(objects, `${arn}/*`);
  return [arn, objects];
}

// The update may change the action list and nothing else: not the bucket it
// grants on, not the effect, and never to a wildcard or a deny.
function checkPolicy({ before, after }, name = policyName) {
  assert.ok(before && after);
  assert.equal(after.name, name);
  assert.equal(after.name, before.name);
  assert.equal(after.path, before.path);
  const current = document(after.policy);
  assert.equal(current.Effect, "Allow");
  assert.ok(!("NotAction" in current) && !("NotResource" in current));
  assert.ok(!("Condition" in current));
  assert.deepEqual(sorted(current.Action), allowedActions);
  assert.deepEqual(resources(current), resources(document(before.policy)));
}

// A single-target scope: the policy now builds its bucket ARN from the bucket
// name instead of the bucket resource, so nothing else is in the graph.
function assertClosure(plan) {
  for (const { address, mode } of plan.resource_changes)
    assert.ok(
      mode !== "managed" || address === policy,
      `${address} is outside the artifact-preservation closure`,
    );
}

function validateArtifactPreservationPlan(plan, binding, options = {}) {
  if (binding.environment === "sandbox")
    return validateSandboxArtifactPlan(plan, binding, options);
  const { accountId, environment } = binding;
  assert.match(accountId, /^\d{12}$/);
  assert.equal(environment, "production");
  assert.ok(plan && Array.isArray(plan.resource_changes));
  assertClosure(plan);
  const result = validateScopedPlan(plan, {
    targets: artifactPreservationTargets,
    requiredNoOp: [],
    check: ({ change }) => checkPolicy(change),
  });
  // An already applied or absent policy change is not this scope's plan.
  assert.deepEqual(result.changes, [{ address: policy, action: "update" }]);
  return result;
}

function sandboxArtifactBinding(storage, variables) {
  const b = storageBinding.parse(storage);
  assert.equal(b.accountId, variables.AWS_ACCOUNT_ID);
  assert.equal(b.region, "us-east-1");
  assert.equal(b.region, variables.AWS_REGION);
  assert.equal(
    variables.TERRAFORM_AWS_ROLE_ARN,
    iamArn(b, "role", "meeting-notes-sandbox-github-terraform"),
  );
  assert.equal(
    variables.SANDBOX_BACKEND_DEPLOY_ROLE_ARN,
    iamArn(b, "role", roleName),
  );
  return { environment: "sandbox", accountId: b.accountId, region: b.region };
}
function assertSandboxBinding(b) {
  assert.equal(b.environment, "sandbox");
  assert.match(b.accountId, /^\d{12}$/);
  assert.equal(b.region, "us-east-1");
}
function unchanged(change) {
  assert.ok(
    change.before && change.after && !hasUnknown(change.after_unknown ?? {}),
  );
  assert.deepEqual(change.before, change.after);
}
function checkComputedMask(key, value) {
  if (key === "tags_all" && typeof value !== "boolean")
    assert.deepEqual(value, {});
  else assert.equal(typeof value, "boolean");
}
function checkAuthority(change, b) {
  const computed = [
    "arn",
    "id",
    "attachment_count",
    "name_prefix",
    "policy_id",
    "tags_all",
  ];
  assert.ok(!hasUnknown(without(change.after_unknown ?? {}, computed)));
  for (const key of computed) {
    if (Object.hasOwn(change.after_unknown ?? {}, key))
      checkComputedMask(key, change.after_unknown[key]);
    if (change.after_unknown?.[key] === true)
      assert.equal(change.after[key] ?? null, null);
    else if (["arn", "id"].includes(key))
      assert.equal(change.after[key], iamArn(b, "policy", authorityName));
  }
  const after = change.after;
  assert.equal(change.before, null);
  for (const key of Object.keys(after))
    assert.ok(
      [
        ...computed,
        "name",
        "path",
        "description",
        "policy",
        "tags",
        "delay_after_policy_creation_in_ms",
      ].includes(key),
    );
  assert.equal(after.name, authorityName);
  assert.ok(after.path == null || after.path === "/");
  assert.ok(after.description == null || after.description === "");
  assert.deepEqual(after.tags ?? {}, {});
  if (change.after_unknown?.tags_all !== true)
    assert.deepEqual(after.tags_all, {
      Project: "meeting-notes",
      Environment: "sandbox",
      ManagedBy: "terraform",
      Service: "chronote",
    });
  assert.deepEqual(JSON.parse(after.policy), {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "ArtifactAuthorityChecks",
        Effect: "Allow",
        Action: ["dynamodb:ConditionCheckItem"],
        Resource: `arn:aws:dynamodb:${b.region}:${b.accountId}:table/meeting-notes-sandbox-MeetingHistoryTable`,
      },
    ],
  });
}
function checkArtifactAttachment(change, b, plan) {
  assert.equal(change.before, null);
  assert.equal(change.after.role, roleName);
  assert.ok(
    !hasUnknown(without(change.after_unknown ?? {}, ["id", "policy_arn"])),
  );
  for (const key of ["id", "policy_arn"])
    if (Object.hasOwn(change.after_unknown ?? {}, key))
      assert.equal(typeof change.after_unknown[key], "boolean");
  if (change.after_unknown?.id === true)
    assert.equal(change.after.id ?? null, null);
  if (change.after_unknown?.policy_arn === true) {
    assert.equal(change.after.policy_arn ?? null, null);
    const configured = plan.configuration?.root_module?.resources?.filter(
      (r) => r.address === attachment.replace("[0]", ""),
    );
    assert.equal(configured?.length, 1);
    assert.deepEqual(configured[0].expressions.policy_arn, {
      references: [authority + ".arn", authority, authority.replace("[0]", "")],
    });
  } else
    assert.equal(change.after.policy_arn, iamArn(b, "policy", authorityName));
}
function verifyArtifactChecks(plan, proof) {
  assert.deepEqual(
    plan.checks
      ?.map((c) => c.address)
      .sort((a, b) => a.to_display.localeCompare(b.to_display)),
    [...excludedChecks].sort((a, b) =>
      a.to_display.localeCompare(b.to_display),
    ),
  );
  verifyChecks(plan, proof, ["aws_iam_role.sandbox_deploy"]);
  const included = plan.checks.find(
    (c) => c.address.to_display === "aws_iam_role.sandbox_deploy",
  );
  assert.equal(included.status, "pass");
  assert.deepEqual(
    included.instances?.map((i) => i.address),
    [{ to_display: role, instance_key: 0 }],
  );
  for (const check of plan.checks.filter((c) => c.status === "pass")) {
    const expected = expectedCheckInstances(plan, check.address);
    assert.deepEqual(
      check.instances?.map((i) => i.address.to_display).sort(),
      expected.sort(),
    );
  }
}
function validateSandboxArtifactPlan(
  plan,
  b,
  { directory = join(__dirname, "../.."), sourceSha } = {},
) {
  assertSandboxBinding(b);
  assert.equal(plan.format_version, "1.2");
  assert.equal(plan.terraform_version, "1.17.1");
  assert.notEqual(plan.errored, true);
  // Targeting marks valid plans incomplete; scope, checks and deferrals decide admission.
  for (const key of [
    "resource_drift",
    "deferred_changes",
    "action_invocations",
    "ephemeral_resource_changes",
  ])
    assert.deepEqual(plan[key] ?? [], []);
  for (const [key, value] of Object.entries({
    environment: "sandbox",
    project_name: "meeting-notes",
    aws_region: b.region,
  }))
    assert.deepEqual(plan.variables?.[key], { value });
  const managed = [],
    seen = new Set();
  const data = [
    "data.aws_caller_identity.current",
    "data.aws_iam_openid_connect_provider.github_deploy[0]",
    "data.github_repository.repo",
    "data.github_organization.deployment_owner[0]",
  ];
  for (const r of plan.resource_changes) {
    assert.ok(!seen.has(r.address));
    seen.add(r.address);
    if (r.mode === "data") {
      assert.ok(data.includes(r.address));
      unchanged(r.change);
      if (r.address === "data.aws_caller_identity.current")
        assert.equal(r.change.after.account_id, b.accountId);
      if (r.address === "data.aws_iam_openid_connect_provider.github_deploy[0]")
        assert.equal(
          r.change.after.arn,
          `arn:aws:iam::${b.accountId}:oidc-provider/token.actions.githubusercontent.com`,
        );
    } else managed.push(r.address);
    if (r.address === role) {
      unchanged(r.change);
      assert.equal(r.change.after.name, roleName);
      assert.equal(r.change.after.arn, iamArn(b, "role", roleName));
    }
  }
  assert.deepEqual(
    managed.sort(),
    [...sandboxArtifactTargets.keys(), role].sort(),
  );
  const result = validateScopedPlan(plan, {
    targets: sandboxArtifactTargets,
    requiredNoOp: [role],
    check: ({ address, change }) => {
      if (address === authority) checkAuthority(change, b);
      else if (address === attachment) checkArtifactAttachment(change, b, plan);
      else {
        checkPolicy(change, "meeting-notes-sandbox-bot-transcripts-s3-policy");
        assert.ok(!hasUnknown(change.after_unknown ?? {}));
        assertOtherwiseUnchanged(
          { ...change, unknown: change.after_unknown ?? {} },
          ["policy"],
        );
        const prior = document(change.before.policy),
          after = document(change.after.policy);
        assert.deepEqual(
          sorted(prior.Action),
          allowedActions.filter((a) => a !== "s3:GetObjectVersion"),
        );
        assert.deepEqual({ ...after, Action: prior.Action }, prior);
        assert.deepEqual(resources(after), [
          `arn:aws:s3:::meeting-notes-sandbox-transcripts-${b.accountId}`,
          `arn:aws:s3:::meeting-notes-sandbox-transcripts-${b.accountId}/*`,
        ]);
      }
    },
  });
  assert.deepEqual(
    result.changes.map((c) => `${c.address}:${c.action}`).sort(),
    [...sandboxArtifactTargets]
      .map(([a, actions]) => `${a}:${actions[0]}`)
      .sort(),
  );
  verifyArtifactChecks(plan, verifySource(directory, sourceSha));
  return result;
}
function prepareSandboxArtifactSession(b, phase) {
  assertSandboxBinding(b);
  assert.ok(["plan", "apply"].includes(phase));
  const transcript = iamArn(
      b,
      "policy",
      "meeting-notes-sandbox-bot-transcripts-s3-policy",
    ),
    created = iamArn(b, "policy", authorityName);
  const policy = JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      { Effect: "Allow", Action: "*", Resource: "*" },
      {
        Effect: "Deny",
        NotAction: [
          "iam:Get*",
          "iam:List*",
          "s3:Get*",
          "s3:ListBucket",
          "s3:PutObject",
          "kms:Describe*",
          "kms:Get*",
          "kms:List*",
          "kms:GenerateDataKey",
          "kms:Decrypt",
          "dynamodb:DescribeTable",
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:DeleteItem",
          ...(phase === "apply"
            ? [
                "iam:CreatePolicyVersion",
                "iam:CreatePolicy",
                "iam:TagPolicy",
                "iam:AttachRolePolicy",
              ]
            : []),
        ],
        Resource: "*",
      },
      {
        Effect: "Deny",
        Action: "iam:CreatePolicyVersion",
        NotResource: transcript,
      },
      {
        Effect: "Deny",
        Action: ["iam:CreatePolicy", "iam:TagPolicy"],
        NotResource: created,
      },
      {
        Effect: "Deny",
        Action: "iam:AttachRolePolicy",
        NotResource: iamArn(b, "role", roleName),
      },
      {
        Effect: "Deny",
        Action: "iam:AttachRolePolicy",
        Resource: "*",
        Condition: { StringNotEquals: { "iam:PolicyARN": created } },
      },
    ],
  });
  assert.ok(Buffer.byteLength(policy) <= 2048);
  return { policy, masks: [...Object.values(b), transcript, created, policy] };
}
module.exports = {
  validateArtifactPreservationPlan,
  artifactPreservationTargets,
  sandboxArtifactTargets,
  sandboxArtifactBinding,
  prepareSandboxArtifactSession,
};
if (require.main === module && process.argv[2] === "--session") {
  try {
    assert.equal(process.argv.length, 4);
    writeSandboxSiteSessionOutput(
      prepareSandboxArtifactSession(
        sandboxArtifactBinding(
          JSON.parse(process.env.TERRAFORM_PRIVATE_STORAGE_JSON),
          JSON.parse(process.env.GITHUB_VARS_JSON),
        ),
        process.argv[3],
      ),
      process.env.GITHUB_OUTPUT,
    );
  } catch {
    process.stderr.write("Sandbox artifact session refused\n");
    process.exitCode = 1;
  }
} else if (require.main === module)
  runCli(
    (plan) =>
      validateArtifactPreservationPlan(plan, {
        accountId: process.argv[2],
        environment: process.argv[3],
      }),
    "Artifact preservation plan rejected: invalid action evidence, a changed bucket or grant, or changes outside the transcripts policy scope.\n",
  );
