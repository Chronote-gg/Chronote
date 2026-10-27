/** @jest-environment node */
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { test, expect } from "@jest/globals";
import { load } from "js-yaml";
import {
  preparePlanIdentity,
  validatePlanVariables,
} from "../../scripts/deployment/terraform-plan-identity.cjs";
import { privateCaptureFixture } from "../fixtures/deployment/privateCapture.js";

function fixture() {
  const binding = privateCaptureFixture().binding;
  binding.bucket = `meeting-notes-prod-private-evidence-${binding.accountId}`;
  const workflow = load(
    readFileSync(".github/workflows/terraform-plan.yml", "utf8"),
  );
  const policy = workflow.jobs.plan.steps.find(
    (s) => s.name === "Configure production AWS credentials",
  ).with["inline-session-policy"];
  return { binding, policy };
}
test("mask preparation derives and masks exact installed identities and expanded session policy without AWS", () => {
  const { binding, policy } = fixture();
  const result = preparePlanIdentity(JSON.stringify(binding), policy);
  expect(result.outputs).toEqual({
    account_id: binding.accountId,
    role_arn: `arn:aws:iam::${binding.accountId}:role/meeting-notes-prod-github-terraform`,
    control_table: "meeting-notes-prod-DeploymentControlTable",
  });
  for (const value of [
    ...Object.values(result.outputs),
    binding.bucket,
    binding.kmsKeyArn,
  ])
    expect(result.masks).toContain(value);
  expect(result.masks).toContain(
    policy.replaceAll("${{ vars.AWS_ACCOUNT_ID }}", binding.accountId),
  );
  expect(result.masks.every((value) => !/[\r\n]/.test(value))).toBe(true);
});
test.each(["account", "bucket", "region", "unknown"])(
  "mask preparation refuses %s drift before producing output",
  (fault) => {
    const { binding, policy } = fixture();
    if (fault === "account") binding.accountId = "000000000000";
    if (fault === "bucket") binding.bucket = "other-evidence";
    if (fault === "region") binding.region = "us-west-2";
    if (fault === "unknown") binding.other = true;
    expect(() =>
      preparePlanIdentity(JSON.stringify(binding), policy),
    ).toThrow();
  },
);

test("strict canonical validation rejects case-only drift before credentials and preserves TFVAR overrides", () => {
  const { binding, policy } = fixture(),
    expected = preparePlanIdentity(JSON.stringify(binding), policy).outputs;
  const variables = {
    AWS_ACCOUNT_ID: expected.account_id,
    TERRAFORM_AWS_ROLE_ARN: expected.role_arn,
    DEPLOYMENT_CONTROL_TABLE: expected.control_table,
    TFVAR_ENABLE_ONBOARDING: "true",
  };
  expect(() =>
    validatePlanVariables(JSON.stringify(variables), expected),
  ).not.toThrow();
  for (const key of ["TERRAFORM_AWS_ROLE_ARN", "DEPLOYMENT_CONTROL_TABLE"])
    expect(() =>
      validatePlanVariables(
        JSON.stringify({ ...variables, [key]: variables[key].toUpperCase() }),
        expected,
      ),
    ).toThrow();
});
test("Plan logs private values only after masking and validates canonical variables without printing them", () => {
  const workflow = load(
      readFileSync(".github/workflows/terraform-plan.yml", "utf8"),
    ),
    job = workflow.jobs.plan;
  for (const key of [
    "DEPLOYMENT_ENVIRONMENT",
    "DEPLOYMENT_ACCOUNT_ID",
    "DEPLOYMENT_CONTROL_TABLE",
    "DEPLOYMENT_GUARD_ROLE_ARN",
  ])
    expect(job.env[key]).toBeUndefined();
  const mask = job.steps.findIndex((s) => s.id === "plan-identity");
  const check = job.steps.findIndex(
    (s) => s.name === "Validate production identity bindings",
  );
  const credential = job.steps.findIndex(
    (s) => s.name === "Configure production AWS credentials",
  );
  const strict = job.steps.findIndex(
    (s) => s.name === "Validate exact production identity",
  );
  expect(mask).toBeGreaterThanOrEqual(0);
  expect(mask).toBeLessThan(check);
  expect(check).toBeLessThan(strict);
  expect(strict).toBeLessThan(credential);
  expect(Object.keys(job.steps[mask].env)).toEqual([
    "TERRAFORM_PRIVATE_STORAGE_JSON",
  ]);
  expect(job.steps[check].env).toEqual({
    IDENTITY_MATCHES:
      "${{ vars.AWS_ACCOUNT_ID == steps.plan-identity.outputs.account_id && vars.TERRAFORM_AWS_ROLE_ARN == steps.plan-identity.outputs.role_arn && vars.DEPLOYMENT_CONTROL_TABLE == steps.plan-identity.outputs.control_table }}",
  });
  expect(job.steps[check].run).toBe('test "$IDENTITY_MATCHES" = true');
  expect(job.steps[strict].run).toBe(
    "node scripts/deployment/terraform-plan-identity.cjs --validate",
  );
  expect(job.steps[strict].env.GITHUB_VARS_JSON).toBe("${{ toJSON(vars) }}");
  expect(job.steps[credential].with["mask-aws-account-id"]).toBe(true);
});

test("actual mask helper emits masks before exporting identities and never prints raw input errors", () => {
  const { binding, policy } = fixture(),
    dir = mkdtempSync(join(tmpdir(), "plan-mask-"));
  try {
    const output = join(dir, "output");
    const env = {
      ...process.env,
      TERRAFORM_PRIVATE_STORAGE_JSON: JSON.stringify(binding),
      GITHUB_OUTPUT: output,
    };
    const script = "scripts/deployment/terraform-plan-identity.cjs";
    const result = spawnSync(process.execPath, [script], {
      env,
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(
      result.stdout
        .trim()
        .split("\n")
        .every((line) => line.startsWith("::add-mask::")),
    ).toBe(true);
    const expected = preparePlanIdentity(
      JSON.stringify(binding),
      policy,
    ).outputs;
    for (const [name, value] of Object.entries(expected))
      expect(readFileSync(output, "utf8")).toContain(`${name}=${value}\n`);
    const variables = {
      AWS_ACCOUNT_ID: expected.account_id,
      TERRAFORM_AWS_ROLE_ARN: expected.role_arn,
      DEPLOYMENT_CONTROL_TABLE: expected.control_table,
    };
    const accepted = spawnSync(process.execPath, [script, "--validate"], {
      env: { ...env, GITHUB_VARS_JSON: JSON.stringify(variables) },
      encoding: "utf8",
    });
    expect(accepted.status).toBe(0);
    expect(accepted.stdout).toBe("");
    const probes = [
      { args: [], env: { TERRAFORM_PRIVATE_STORAGE_JSON: "SECRET_SENTINEL" } },
      {
        args: ["--validate"],
        env: {
          GITHUB_VARS_JSON: JSON.stringify({
            ...variables,
            TERRAFORM_AWS_ROLE_ARN: expected.role_arn.toUpperCase(),
          }),
        },
      },
    ];
    for (const probe of probes) {
      const refused = spawnSync(process.execPath, [script, ...probe.args], {
        env: { ...env, ...probe.env },
        encoding: "utf8",
      });
      expect(refused.status).toBe(1);
      expect(refused.stdout).toBe("");
      expect(refused.stderr).toBe("Production Plan identity refused\n");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
