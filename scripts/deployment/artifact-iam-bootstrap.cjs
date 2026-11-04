"use strict";
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { canonical, hasUnknown } = require("./terraform-meeting-update.cjs");
const hash = (s) => createHash("sha256").update(s).digest("hex");
const selectors = ["artifact_app_kms_key_arn", "artifact_transcripts_bucket"];
function artifactIamBootstrapStatements(v, environment) {
  assert.ok(["sandbox", "production"].includes(environment));
  const account = v[`${environment}_account_id`],
    prefix = `meeting-notes-${environment === "sandbox" ? "sandbox" : "prod"}`;
  assert.match(account, /^\d{12}$/);
  assert.equal(v.aws_region, "us-east-1");
  assert.match(
    v.artifact_app_kms_key_arn,
    new RegExp(`^arn:aws:kms:us-east-1:${account}:key/[a-f0-9-]{36}$`),
  );
  assert.match(
    v.artifact_transcripts_bucket,
    /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/,
  );
  assert.ok(
    !v.artifact_transcripts_bucket.includes("..") &&
      !/^\d+\.\d+\.\d+\.\d+$/.test(v.artifact_transcripts_bucket),
  );
  const allow = (Sid, Action, Resource) => ({
    Sid,
    Effect: "Allow",
    Action,
    Resource,
  });
  const roles = [
    "ecs-task-app-role",
    "ecs-task-exec-role",
    "github-deploy",
  ].map((n) => `arn:aws:iam::${account}:role/${prefix}-${n}`);
  const grants = [
    allow(
      "ArtifactPolicyVersions",
      [
        "iam:GetPolicy",
        "iam:GetPolicyVersion",
        "iam:ListPolicyTags",
        "iam:ListPolicyVersions",
        "iam:CreatePolicyVersion",
      ],
      `arn:aws:iam::${account}:policy/${prefix}-bot-transcripts-s3-policy`,
    ),
    allow("ArtifactBackendPolicy", "iam:PutRolePolicy", roles[2]),
    allow(
      "ArtifactRoleMetadata",
      [
        "iam:GetRole",
        "iam:ListRolePolicies",
        "iam:GetRolePolicy",
        "iam:ListAttachedRolePolicies",
      ],
      roles.slice(0, 2),
    ),
    allow(
      "ArtifactTranscriptMetadata",
      [
        "s3:ListBucket",
        "s3:GetBucketPolicy",
        "s3:GetBucketAcl",
        "s3:GetBucketCORS",
        "s3:GetBucketWebsite",
        "s3:GetBucketVersioning",
        "s3:GetAccelerateConfiguration",
        "s3:GetBucketRequestPayment",
        "s3:GetBucketLogging",
        "s3:GetLifecycleConfiguration",
        "s3:GetReplicationConfiguration",
        "s3:GetEncryptionConfiguration",
        "s3:GetBucketObjectLockConfiguration",
        "s3:GetBucketTagging",
      ],
      `arn:aws:s3:::${v.artifact_transcripts_bucket}`,
    ),
    allow(
      "ArtifactApplicationKeyMetadata",
      [
        "kms:DescribeKey",
        "kms:GetKeyPolicy",
        "kms:GetKeyRotationStatus",
        "kms:ListResourceTags",
      ],
      v.artifact_app_kms_key_arn,
    ),
    ...(environment === "sandbox"
      ? [
          allow(
            "ArtifactClusterMetadata",
            ["ecs:DescribeClusters", "ecs:ListTagsForResource"],
            `arn:aws:ecs:us-east-1:${account}:cluster/${prefix}-bot-cluster`,
          ),
          allow(
            "ArtifactRepositoryMetadata",
            ["ecr:DescribeRepositories", "ecr:ListTagsForResource"],
            `arn:aws:ecr:us-east-1:${account}:repository/${prefix}-bot-repo`,
          ),
          allow(
            "ArtifactSecretMetadata",
            [
              "secretsmanager:DescribeSecret",
              "secretsmanager:GetResourcePolicy",
            ],
            [
              "discord-bot-token",
              "discord-client-secret",
              "langfuse-public-key",
              "langfuse-secret-key",
              "oauth-secret",
              "openai-api-key",
              "stripe-secret-key",
              "stripe-webhook-secret",
            ].map(
              (n) =>
                `arn:aws:secretsmanager:us-east-1:${account}:secret:${prefix}/${n}-??????`,
            ),
          ),
        ]
      : []),
  ];
  const metadata = grants.slice(2);
  return [
    ...grants.slice(0, 2),
    {
      Sid: "ArtifactMetadata",
      Effect: "Allow",
      Action: [...new Set(metadata.flatMap((s) => s.Action))],
      Resource: [...new Set(metadata.flatMap((s) => s.Resource))],
    },
  ];
}
function inlinePolicySize(policy) {
  assert.equal(typeof policy, "string");
  JSON.parse(policy);
  assert.ok(
    [...policy].every((c) => {
      const n = c.charCodeAt(0);
      return [9, 10, 13].includes(n) || (n >= 32 && n <= 255);
    }),
  );
  return policy.replace(/[ \t\r\n]/g, "").length;
}
function assertInlineQuota(policies) {
  const size = policies.reduce((n, p) => n + inlinePolicySize(p.policy), 0);
  assert.ok(size <= 10240, "HOLD: aggregate IAM inline policy quota");
  return size;
}
// Empty opt-in selectors keep the existing create/site guard contracts usable.
function withoutArtifactDefaults(plan, binding) {
  if (
    !selectors.some(
      (k) =>
        Object.hasOwn(plan.variables, k) || Object.hasOwn(binding.variables, k),
    )
  )
    return { plan, binding };
  const p = structuredClone(plan),
    b = structuredClone(binding);
  for (const k of selectors) {
    assert.ok(
      !Object.hasOwn(p.variables, k) || p.variables[k]?.value === "",
      "Artifact changes require artifact-iam-update",
    );
    assert.ok(
      !Object.hasOwn(b.variables, k) || b.variables[k] === "",
      "Artifact changes require artifact-iam-update",
    );
    delete p.variables[k];
    delete b.variables[k];
  }
  return { plan: p, binding: b };
}
function executorInlinePolicies(plan, environment) {
  const role = plan.resource_changes.find(
    (r) => r.address === `aws_iam_role.${environment}_terraform[0]`,
  );
  const refreshed = role?.change?.after?.inline_policy;
  assert.ok(
    Array.isArray(refreshed) &&
      refreshed.length > 0 &&
      !hasUnknown(role.change.after_unknown?.inline_policy ?? {}),
    "HOLD: aggregate inline policy readback unavailable",
  );
  assert.equal(new Set(refreshed.map((x) => x.name)).size, refreshed.length);
  for (const x of refreshed) {
    assert.deepEqual(Object.keys(x).sort(), ["name", "policy"]);
    assert.equal(typeof x.name, "string");
    inlinePolicySize(x.policy);
  }
  return refreshed;
}
function artifactIamBootstrapBase(plan, binding, environment) {
  assert.equal(plan.applyable, true);
  assert.equal(plan.complete, true);
  assert.equal(plan.errored, false);
  for (const field of [
    "deferred_changes",
    "resource_drift",
    "action_invocations",
    "ephemeral_resource_changes",
  ])
    assert.deepEqual(plan[field] ?? [], []);
  for (const check of plan.checks ?? []) assert.equal(check.status, "pass");
  assert.deepEqual(
    Object.keys(binding).sort(),
    [
      "backendKey",
      "variables",
      "policySha256",
      "previousRolePolicySha256",
      ...(environment === "sandbox" ? ["bucketOwnerCanonicalId"] : []),
    ].sort(),
  );
  const target = `aws_iam_role_policy.${environment}_terraform[0]`;
  assert.match(binding.previousRolePolicySha256, /^[a-f0-9]{64}$/);
  const expected = artifactIamBootstrapStatements(
    binding.variables,
    environment,
  );
  const p = structuredClone(plan),
    b = structuredClone(binding);
  const refreshed = executorInlinePolicies(p, environment);
  let found = false;
  for (const r of p.resource_changes) {
    if (r.mode !== "managed") continue;
    const c = r.change;
    assert.ok(
      c.before && c.after && !hasUnknown(c.after_unknown ?? {}),
      "Unknown existing bootstrap values",
    );
    if (r.address === target) {
      assert.ok(!found);
      found = true;
      assert.ok(
        c.actions.length === 1 && ["update", "no-op"].includes(c.actions[0]),
      );
      assert.equal(
        hash(c.before.policy),
        b.previousRolePolicySha256,
        "Unreviewed prior policy",
      );
      assert.equal(
        hash(c.after.policy),
        b.policySha256.role,
        "Unreviewed proposed policy",
      );
      const installed = refreshed.filter((x) => x.name === c.after.name);
      assert.equal(
        installed.length,
        1,
        "HOLD: executor inline policy readback missing",
      );
      assert.equal(
        installed[0].policy,
        c.before.policy,
        "HOLD: stale executor inline policy readback",
      );
      assertInlineQuota(
        refreshed.map((x) => ({
          ...x,
          policy: x.name === c.after.name ? c.after.policy : x.policy,
        })),
      );
      const before = JSON.parse(c.before.policy),
        after = JSON.parse(c.after.policy);
      const sids = new Set(expected.map((s) => s.Sid));
      assert.ok(
        !before.Statement.some((s) => sids.has(s.Sid)),
        "Artifact grants already installed; do not replay bootstrap update",
      );
      assert.deepEqual(
        canonical(after),
        canonical({ ...before, Statement: [...before.Statement, ...expected] }),
        "Unexpected artifact bootstrap permissions",
      );
      const old = { ...c.before };
      delete old.policy;
      const next = { ...c.after };
      delete next.policy;
      assert.deepEqual(old, next, "Unrelated executor field changed");
      c.after.policy = c.before.policy;
      c.actions = ["no-op"];
    } else {
      assert.deepEqual(c.actions, ["no-op"], "Non-executor bootstrap effect");
      assert.deepEqual(c.before, c.after, "Bootstrap storage/trust changed");
    }
  }
  assert.ok(found, "Missing executor policy");
  for (const k of selectors) {
    assert.deepEqual(p.variables[k], { value: b.variables[k] });
    delete p.variables[k];
    delete b.variables[k];
  }
  b.policySha256.role = b.previousRolePolicySha256;
  p.applyable = false;
  return { plan: p, binding: b };
}
module.exports = {
  artifactIamBootstrapStatements,
  artifactIamBootstrapBase,
  withoutArtifactDefaults,
  assertInlineQuota,
  inlinePolicySize,
};
