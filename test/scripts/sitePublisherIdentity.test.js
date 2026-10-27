/** @jest-environment node */
import { readFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import { test, expect } from "@jest/globals";
import { parse } from "yaml";
import { privateCaptureFixture } from "../fixtures/deployment/privateCapture.js";
import {
  prepareSiteIdentity,
  prepareSiteSession,
} from "../../scripts/deployment/site-publisher-identity.cjs";
function fixture(site) {
  const binding = privateCaptureFixture().binding;
  binding.bucket = `meeting-notes-prod-private-evidence-${binding.accountId}`;
  const text = JSON.stringify(binding),
    identity = prepareSiteIdentity(text);
  const variables = {
    AWS_ACCOUNT_ID: identity.outputs.account_id,
    AWS_REGION: "us-east-1",
    PRODUCTION_BACKEND_DEPLOY_ROLE_ARN: identity.outputs.role_arn,
    DEPLOYMENT_CONTROL_TABLE: identity.outputs.control_table,
    [site.toUpperCase() + "_BUCKET"]:
      `meeting-notes-prod-${site}-${binding.accountId}`,
    [site.toUpperCase() + "_DISTRIBUTION_ID"]: "ESYNTHETIC12345",
  };
  const workflow = parse(readFileSync(".github/workflows/deploy.yml", "utf8"));
  return {
    text,
    binding,
    identity,
    variables,
    template: workflow.jobs[`deploy-${site}`].steps.find(
      (s) => s.name === "Configure AWS credentials",
    ).with["inline-session-policy"],
  };
}
test.each(["docs", "frontend"])(
  "%s masks newly introduced identities and the exact later action policy",
  (site) => {
    const f = fixture(site);
    expect(f.identity.masks).toEqual(
      expect.arrayContaining([
        ...Object.values(f.identity.outputs),
        f.binding.kmsKeyArn,
        f.binding.bucket,
        f.variables[site.toUpperCase() + "_BUCKET"],
      ]),
    );
    const result = prepareSiteSession(
      f.text,
      JSON.stringify(f.variables),
      site,
      f.template,
    );
    expect(result.policy).not.toContain("${{");
    expect(Buffer.byteLength(result.policy)).toBeLessThanOrEqual(2048);
    const bucket = f.variables[site.toUpperCase() + "_BUCKET"],
      statements = JSON.parse(result.policy).Statement;
    expect(statements[0].Resource).toEqual([
      `arn:aws:s3:::${bucket}`,
      `arn:aws:s3:::${bucket}/*`,
    ]);
    expect(statements[1].Resource).toBe(
      `arn:aws:cloudfront::${f.binding.accountId}:distribution/${f.variables[site.toUpperCase() + "_DISTRIBUTION_ID"]}`,
    );
    expect(statements[3].Condition.StringLike).toEqual({
      "kms:EncryptionContext:aws:s3:arn": `arn:aws:s3:::${bucket}/*`,
    });
    expect(statements[4].Condition.StringEquals).toEqual({
      "kms:CallerAccount": f.binding.accountId,
      "kms:ViaService": "dynamodb.us-east-1.amazonaws.com",
      "kms:EncryptionContext:aws:dynamodb:subscriberId": f.binding.accountId,
      "kms:EncryptionContext:aws:dynamodb:tableName":
        f.identity.outputs.control_table,
    });
    expect(result.masks).toContain(result.policy);
    expect(result.masks).toContain(
      f.variables[site.toUpperCase() + "_DISTRIBUTION_ID"],
    );
  },
);
test.each([
  "AWS_ACCOUNT_ID",
  "PRODUCTION_BACKEND_DEPLOY_ROLE_ARN",
  "DEPLOYMENT_CONTROL_TABLE",
  "AWS_REGION",
  "DOCS_DISTRIBUTION_ID",
])(
  "strict session preparation refuses changed %s without producing policy output",
  (field) => {
    const f = fixture("docs");
    f.variables[field] = "wrong";
    expect(() =>
      prepareSiteSession(
        f.text,
        JSON.stringify(f.variables),
        "docs",
        f.template,
      ),
    ).toThrow();
  },
);
test.each(["docs", "frontend"])(
  "%s preserves a valid configured bucket override in both masks and session",
  (site) => {
    const f = fixture(site),
      bucket = `chronote-custom-${site}.archive`;
    f.variables[site.toUpperCase() + "_BUCKET"] = bucket;
    const prepared = prepareSiteSession(
      f.text,
      JSON.stringify(f.variables),
      site,
      f.template,
    );
    expect(prepared.masks).toContain(bucket);
    expect(prepared.policy).toContain(`arn:aws:s3:::${bucket}`);
  },
);
test.each(
  ["docs", "frontend"].flatMap((site) =>
    [
      "BadBucket",
      "ab",
      "bad/bucket",
      "bad*bucket",
      "bad..bucket",
      "127.0.0.1",
    ].map((bucket) => [site, bucket]),
  ),
)(
  "%s malformed configured bucket %s is refused before policy output",
  (site, bucket) => {
    const f = fixture(site);
    f.variables[site.toUpperCase() + "_BUCKET"] = bucket;
    expect(() =>
      prepareSiteSession(f.text, JSON.stringify(f.variables), site, f.template),
    ).toThrow();
  },
);
test("case-only canonical drift is refused after the coarse GitHub expression check", () => {
  const f = fixture("docs");
  f.variables.PRODUCTION_BACKEND_DEPLOY_ROLE_ARN =
    f.variables.PRODUCTION_BACKEND_DEPLOY_ROLE_ARN.toUpperCase();
  expect(() =>
    prepareSiteSession(f.text, JSON.stringify(f.variables), "docs", f.template),
  ).toThrow();
});
test.each(["docs", "frontend"])(
  "%s registers masks before new private values or OIDC inputs",
  (site) => {
    const workflow = parse(
        readFileSync(".github/workflows/deploy.yml", "utf8"),
      ),
      job = workflow.jobs[`deploy-${site}`];
    for (const key of [
      "DEPLOYMENT_ENVIRONMENT",
      "DEPLOYMENT_ACCOUNT_ID",
      "DEPLOYMENT_CONTROL_TABLE",
      "DEPLOYMENT_GUARD_ROLE_ARN",
    ])
      expect(job.env[key]).toBeUndefined();
    const mask = job.steps.findIndex((s) => s.id === "publisher-identity"),
      coarse = job.steps.findIndex(
        (s) => s.name === "Validate site publisher bindings",
      ),
      session = job.steps.findIndex(
        (s) => s.name === "Prepare site publisher session",
      ),
      credential = job.steps.findIndex(
        (s) => s.name === "Configure AWS credentials",
      );
    expect(mask).toBeLessThan(coarse);
    expect(coarse).toBeLessThan(session);
    expect(session).toBeLessThan(credential);
    expect(Object.keys(job.steps[mask].env)).toEqual([
      "TERRAFORM_PRIVATE_STORAGE_JSON",
    ]);
    expect(job.steps[coarse].env).toEqual({
      IDENTITY_MATCHES:
        "${{ vars.AWS_ACCOUNT_ID == steps.publisher-identity.outputs.account_id && vars.PRODUCTION_BACKEND_DEPLOY_ROLE_ARN == steps.publisher-identity.outputs.role_arn && vars.DEPLOYMENT_CONTROL_TABLE == steps.publisher-identity.outputs.control_table }}",
    });
    expect(job.steps[session].env.GITHUB_VARS_JSON).toBeUndefined();
    expect(Object.keys(job.steps[session].env).sort()).toEqual(
      [
        "TERRAFORM_PRIVATE_STORAGE_JSON",
        "AWS_ACCOUNT_ID",
        "PRODUCTION_BACKEND_DEPLOY_ROLE_ARN",
        "DEPLOYMENT_CONTROL_TABLE",
        site.toUpperCase() + "_BUCKET",
        site.toUpperCase() + "_DISTRIBUTION_ID",
      ].sort(),
    );
  },
);
