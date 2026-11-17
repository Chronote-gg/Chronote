/** @jest-environment node */
import { test, expect } from "@jest/globals";
import { readFileSync } from "node:fs";

test("version-specific artifact readback has the runtime object-version read grant", () => {
  const source = readFileSync("_infra/main.tf", "utf8");
  const policy = source
    .split('resource "aws_iam_policy" "transcripts_s3_policy"')[1]
    .split("\nresource ")[0];
  expect(policy).toContain('"s3:GetObjectVersion"');
  // The bucket ARN is built from the bucket name, not the bucket resource, so
  // the artifact-preservation plan scope does not refresh the bucket.
  expect(policy).toContain('"arn:aws:s3:::${local.transcripts_bucket_name}/*"');
  expect(policy).not.toContain("aws_s3_bucket.transcripts");
});
test("Sandbox artifact authority is independent of application resources", () => {
  const source = readFileSync("_infra/sandbox-artifact-authority.tf", "utf8");
  expect(source).toContain('Action   = ["dynamodb:ConditionCheckItem"]');
  expect(source).toContain(
    'Resource = "arn:aws:dynamodb:${var.aws_region}:${data.aws_caller_identity.current.account_id}:table/${local.name_prefix}-MeetingHistoryTable"',
  );
  expect(source).toContain("role       = aws_iam_role.sandbox_deploy[0].name");
  expect(source).toContain(
    "policy_arn = aws_iam_policy.sandbox_artifact_authority[0].arn",
  );
  expect(source).not.toMatch(
    /aws_dynamodb_table\.|PutItem|UpdateItem|DeleteItem/,
  );
  expect(readFileSync("_infra/sandbox-deployment.tf", "utf8")).not.toContain(
    "ArtifactAuthorityChecks",
  );
});
