/** @jest-environment node */
import { test, expect } from "@jest/globals";
import { Buffer } from "node:buffer";
import { searchPlanSession } from "../../scripts/deployment/search-plan-session.cjs";

const binding = {
  kind: "versioned-private-s3-v1",
  storeId: "synthetic",
  bucket: "synthetic-evidence-store",
  accountId: "123456789012",
  region: "us-east-1",
  kmsKeyArn:
    "arn:aws:kms:us-east-1:123456789012:key/11111111-1111-1111-1111-111111111111",
  policySha256: "a".repeat(64),
  lifecycleSha256: "b".repeat(64),
  retentionUntil: 2000000000000,
  administratorTrustSha256: "c".repeat(64),
};
const variables = {
  AWS_ACCOUNT_ID: binding.accountId,
  AWS_REGION: binding.region,
  TERRAFORM_AWS_ROLE_ARN:
    "arn:aws:iam::123456789012:role/meeting-notes-sandbox-github-terraform",
};

test("Plan session cannot read source meeting records or mutate search", () => {
  const { policy } = searchPlanSession(binding, variables);
  expect(Buffer.byteLength(policy)).toBeLessThanOrEqual(2048);
  const statements = JSON.parse(policy).Statement;
  expect(
    statements.some((statement) =>
      JSON.stringify(statement.Action).includes("PutVectors"),
    ),
  ).toBe(false);
  const sourceReads = statements.filter((statement) =>
    JSON.stringify(statement.Action).includes("dynamodb:GetItem"),
  );
  expect(sourceReads.map((statement) => statement.Resource)).toEqual([
    "arn:aws:dynamodb:us-east-1:123456789012:table/meeting-notes-terraform-state-locks",
  ]);
});

test("Plan session refuses wrong identity", () => {
  expect(() =>
    searchPlanSession(binding, {
      ...variables,
      AWS_ACCOUNT_ID: "999999999999",
    }),
  ).toThrow();
  expect(() =>
    searchPlanSession(binding, {
      ...variables,
      TERRAFORM_AWS_ROLE_ARN: "foreign",
    }),
  ).toThrow();
});
