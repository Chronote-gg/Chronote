"use strict";
const assert = require("node:assert/strict");
const { storageBinding } = require("./private-capture.cjs");
const { writeSandboxSiteSessionOutput } = require("./sandbox-site-session.cjs");

function searchPlanSession(storage, variables) {
  const b = storageBinding.parse(storage);
  assert.equal(b.region, "us-east-1");
  assert.equal(variables.AWS_ACCOUNT_ID, b.accountId);
  assert.equal(variables.AWS_REGION, b.region);
  assert.equal(
    variables.TERRAFORM_AWS_ROLE_ARN,
    `arn:aws:iam::${b.accountId}:role/meeting-notes-sandbox-github-terraform`,
  );
  const arn = (service, suffix) =>
    `arn:aws:${service}:${b.region}:${b.accountId}:${suffix}`;
  const allow = (Action, Resource) => ({ Effect: "Allow", Action, Resource });
  const document = {
    Version: "2012-10-17",
    Statement: [
      allow(
        [
          "dynamodb:Describe*",
          "dynamodb:ListTagsOfResource",
          "iam:Get*",
          "iam:List*",
          "kms:Describe*",
          "kms:Get*",
          "kms:List*",
          "s3:ListBucket",
          "s3:GetBucket*",
          "s3:GetEncryptionConfiguration",
          "s3:GetLifecycleConfiguration",
          "logs:DescribeLogGroups",
        ],
        "*",
      ),
      allow(
        [
          "s3vectors:GetVectorBucket",
          "s3vectors:GetIndex",
          "s3vectors:ListTagsForResource",
          "s3vectors:ListIndexes",
        ],
        arn("s3vectors", `bucket/meeting-notes-sandbox-search-${b.accountId}*`),
      ),
      allow(
        ["lambda:Get*", "lambda:List*"],
        [
          arn("lambda", "function:meeting-notes-sandbox-search-projection"),
          arn("lambda", "event-source-mapping:*"),
        ],
      ),
      allow(
        [
          "events:DescribeRule",
          "events:ListTargetsByRule",
          "events:ListTagsForResource",
        ],
        arn("events", "rule/meeting-notes-sandbox-search-reconcile"),
      ),
      allow(
        ["sqs:GetQueueAttributes", "sqs:GetQueueUrl", "sqs:ListQueueTags"],
        arn("sqs", "meeting-notes-sandbox-search-failures"),
      ),
      allow(
        ["logs:ListTagsForResource"],
        arn(
          "logs",
          "log-group:/aws/lambda/meeting-notes-sandbox-search-projection*",
        ),
      ),
      allow(
        ["s3:GetObject"],
        "arn:aws:s3:::meeting-notes-terraform-state-bucket/meeting-notes-terraform/sandbox/meeting-notes-terraform/state",
      ),
      allow(
        ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem"],
        arn("dynamodb", "table/meeting-notes-terraform-state-locks"),
      ),
      allow(
        ["s3:PutObject", "s3:GetObjectVersion"],
        `arn:aws:s3:::${b.bucket}/terraform/sandbox/*`,
      ),
      allow(["kms:GenerateDataKey", "kms:Decrypt"], arn("kms", "key/*")),
    ],
  };
  // Merge metadata-only statements to remain within STS's 2 KB session-policy limit.
  const metadata = document.Statement.splice(1, 5);
  document.Statement.splice(
    1,
    0,
    allow(
      [
        ...metadata.flatMap((statement) => statement.Action),
        "secretsmanager:DescribeSecret",
        "secretsmanager:GetResourcePolicy",
      ],
      [
        ...metadata.flatMap((statement) =>
          Array.isArray(statement.Resource)
            ? statement.Resource
            : [statement.Resource],
        ),
        arn("secretsmanager", "secret:meeting-notes-sandbox/*"),
      ],
    ),
  );
  const policy = JSON.stringify(document);
  assert.ok(
    Buffer.byteLength(policy) <= 2048,
    "Search Plan session exceeds STS policy limit",
  );
  return { policy, masks: [...Object.values(b), policy] };
}

module.exports = { searchPlanSession };
if (require.main === module) {
  try {
    writeSandboxSiteSessionOutput(
      searchPlanSession(
        JSON.parse(process.env.TERRAFORM_PRIVATE_STORAGE_JSON),
        JSON.parse(process.env.GITHUB_VARS_JSON),
      ),
      process.env.GITHUB_OUTPUT,
    );
  } catch {
    process.stderr.write("Search Plan session refused\n");
    process.exitCode = 1;
  }
}
