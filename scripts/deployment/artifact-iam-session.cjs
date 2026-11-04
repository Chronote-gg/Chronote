"use strict";
const assert = require("node:assert/strict");
const { artifactIamBinding } = require("./validate-artifact-iam-plan.cjs");
const { storageBinding } = require("./private-capture.cjs");
const { writeSandboxSiteSessionOutput } = require("./sandbox-site-session.cjs");
function prepareArtifactIamSession({
  invocation,
  binding,
  phase,
  storage,
  variables,
  tfvars,
}) {
  assert.equal(invocation.scope, "artifact-preservation-iam");
  assert.ok(["plan", "apply"].includes(phase));
  assert.deepEqual(
    binding,
    artifactIamBinding({ invocation, storage, variables, tfvars }),
  );
  const s = storageBinding.parse(storage),
    b = binding;
  const terraformRole = `arn:aws:iam::${b.accountId}:role/${b.prefix}-github-terraform`;
  assert.equal(variables.TERRAFORM_AWS_ROLE_ARN, terraformRole);
  const principalArn =
    phase === "apply" && b.environment === "production"
      ? variables.PRODUCTION_APPLY_ROLE_ARN
      : terraformRole;
  assert.equal(typeof principalArn, "string");
  assert.match(
    principalArn,
    new RegExp(`^arn:aws:iam::${b.accountId}:role/[A-Za-z0-9+=,.@_/-]+$`),
  );
  const guard = phase === "apply" && b.environment === "production";
  if (guard)
    assert.equal(variables.DEPLOYMENT_CONTROL_TABLE, b.controlTableName);
  const stateBucket = "meeting-notes-terraform-state-bucket";
  const stateKey = `meeting-notes-terraform/${b.environment === "sandbox" ? "sandbox/meeting-notes-terraform/" : ""}state`;
  const capture = `arn:aws:s3:::${s.bucket}/terraform/${b.environment}/*`;
  const policyArn = `arn:aws:iam::${b.accountId}:policy/${b.prefix}-bot-transcripts-s3-policy`;
  const policy = JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      // Configuration patterns permit no object reads; installed grants bind metadata to the audited resources.
      {
        Effect: "Allow",
        Action: [
          "iam:Get*",
          "iam:List*",
          "dynamodb:Describe*",
          "dynamodb:ListTagsOfResource",
          "kms:DescribeKey",
          "kms:GetKey*",
          "kms:ListResourceTags",
          "s3:GetBucket*",
          "s3:Get*Configuration",
          "ecs:DescribeClusters",
          "ecs:ListTagsForResource",
          ...(b.environment === "sandbox"
            ? ["ecr:DescribeRepositories", "ecr:ListTagsForResource"]
            : []),
          "secretsmanager:DescribeSecret",
          "secretsmanager:GetResourcePolicy",
        ],
        Resource: "*",
      },
      {
        Effect: "Allow",
        Action: ["s3:GetObject", "s3:PutObject"],
        Resource: `arn:aws:s3:::${stateBucket}/${stateKey}`,
      },
      {
        Effect: "Allow",
        Action: "s3:ListBucket",
        Resource: [
          `arn:aws:s3:::${stateBucket}`,
          `arn:aws:s3:::${b.transcriptsBucket}`,
        ],
      },
      {
        Effect: "Allow",
        Action: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem"],
        Resource: `arn:aws:dynamodb:${b.region}:${b.accountId}:table/meeting-notes-terraform-state-locks`,
      },
      {
        Effect: "Allow",
        Action: ["s3:PutObject", "s3:GetObjectVersion"],
        Resource: capture,
      },
      {
        Effect: "Allow",
        Action: ["kms:GenerateDataKey", "kms:Decrypt"],
        Resource: s.kmsKeyArn,
      },
      ...(guard
        ? [
            {
              Effect: "Allow",
              Action: "dynamodb:GetItem",
              Resource: b.controlTableArn,
              Condition: {
                "ForAllValues:StringEquals": {
                  "dynamodb:LeadingKeys": ["ENV"],
                },
              },
            },
            {
              Effect: "Allow",
              Action: "kms:Decrypt",
              Resource: b.kmsKeyArn,
              Condition: {
                StringEquals: {
                  "kms:ViaService": `dynamodb.${b.region}.amazonaws.com`,
                  "kms:EncryptionContext:aws:dynamodb:tableName":
                    b.controlTableName,
                },
              },
            },
          ]
        : []),
      ...(phase === "apply"
        ? [
            {
              Effect: "Allow",
              Action: "iam:CreatePolicyVersion",
              Resource: policyArn,
            },
            {
              Effect: "Allow",
              Action: "iam:PutRolePolicy",
              Resource: b.deploymentRoleArn,
            },
          ]
        : []),
    ],
  });
  assert.ok(
    Buffer.byteLength(policy) <= 2048,
    "Artifact IAM session exceeds STS limit",
  );
  return {
    policy,
    principalArn,
    masks: [...Object.values(b), s.bucket, s.kmsKeyArn, principalArn, policy],
  };
}
async function assertArtifactIamVersionCapacity({ aws, binding, changes }) {
  const needed = changes.some(
    (c) =>
      c.address === "aws_iam_policy.transcripts_s3_policy" &&
      c.action === "update",
  );
  if (!needed)
    return { kind: "artifact-iam-version-capacity-v1", needed: false };
  const policyArn = `arn:aws:iam::${binding.accountId}:policy/${binding.prefix}-bot-transcripts-s3-policy`;
  const result = await aws(
    "iam",
    "list-policy-versions",
    { PolicyArn: policyArn },
    { region: binding.region, maxAttempts: 1 },
  );
  const versions = result.Versions;
  assert.ok(
    Array.isArray(versions) &&
      versions.length >= 1 &&
      versions.length < 5 &&
      !result.IsTruncated &&
      !result.Marker,
    "HOLD: managed policy version capacity unknown or full",
  );
  assert.ok(
    versions.every(
      (v) =>
        /^v[1-9]\d*$/.test(v.VersionId) &&
        typeof v.IsDefaultVersion === "boolean",
    ) &&
      new Set(versions.map((v) => v.VersionId)).size === versions.length &&
      versions.filter((v) => v.IsDefaultVersion).length === 1,
    "HOLD: managed policy version metadata malformed",
  );
  return {
    kind: "artifact-iam-version-capacity-v1",
    needed,
    policyArn,
    count: versions.length,
    versions,
  };
}
module.exports = {
  prepareArtifactIamSession,
  assertArtifactIamVersionCapacity,
};
if (require.main === module) {
  try {
    const { readFileSync } = require("node:fs");
    const { parseDispatch } = require("./terraform-dispatch.cjs");
    const invocation = parseDispatch(
      process.env,
      JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")),
    ).invocation;
    const storage = JSON.parse(process.env.TERRAFORM_PRIVATE_STORAGE_JSON);
    const variables = JSON.parse(process.env.GITHUB_VARS_JSON);
    const tfvars = JSON.parse(process.env.TERRAFORM_TFVARS_JSON);
    const binding = artifactIamBinding({
      invocation,
      storage,
      variables,
      tfvars,
    });
    const phase = invocation.workflowPath.endsWith("terraform-plan.yml")
      ? "plan"
      : "apply";
    writeSandboxSiteSessionOutput(
      prepareArtifactIamSession({
        invocation,
        binding,
        phase,
        storage,
        variables,
        tfvars,
      }),
      process.env.GITHUB_OUTPUT,
    );
  } catch {
    process.stderr.write("Artifact IAM session refused\n");
    process.exitCode = 1;
  }
}
