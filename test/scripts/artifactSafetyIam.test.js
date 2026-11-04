/** @jest-environment node */
import { test, expect } from "@jest/globals";
import { readFileSync } from "node:fs";

test("version-specific artifact readback has the runtime object-version read grant", () => {
  const source = readFileSync("_infra/main.tf", "utf8");
  const policy = source
    .split('resource "aws_iam_policy" "transcripts_s3_policy"')[1]
    .split("\nresource ")[0];
  expect(policy).toContain('"s3:GetObjectVersion"');
  expect(policy).toContain("${aws_s3_bucket.transcripts.arn}/*");
});
test.each(["production", "sandbox"])(
  "%s deployment may condition-check history without gaining writes",
  (environment) => {
    const source = readFileSync(`_infra/${environment}-deployment.tf`, "utf8");
    const policy = source.match(
      /Sid\s*=\s*"ArtifactAuthorityChecks"[\s\S]*?Resource\s*=\s*([^\r\n]+)/,
    )?.[0];
    expect(policy).toBeDefined();
    expect(policy).toMatch(/Action\s*=\s*\["dynamodb:ConditionCheckItem"\]/);
    expect(policy).toMatch(
      /Resource\s*=\s*aws_dynamodb_table.meeting_history_table.arn/,
    );
    expect(policy).not.toMatch(/PutItem|UpdateItem|DeleteItem/);
  },
);
