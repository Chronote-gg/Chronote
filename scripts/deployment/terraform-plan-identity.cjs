"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { load } = require("js-yaml");
const { storageBinding } = require("./private-capture.cjs");
function preparePlanIdentity(text, policy) {
  const binding = storageBinding.parse(JSON.parse(text));
  assert.equal(binding.region, "us-east-1");
  assert.equal(
    binding.bucket,
    `meeting-notes-prod-private-evidence-${binding.accountId}`,
  );
  assert.ok(
    binding.kmsKeyArn.startsWith(
      `arn:aws:kms:${binding.region}:${binding.accountId}:key/`,
    ),
  );
  const outputs = {
    account_id: binding.accountId,
    role_arn: `arn:aws:iam::${binding.accountId}:role/meeting-notes-prod-github-terraform`,
    control_table: "meeting-notes-prod-DeploymentControlTable",
  };
  const expandedPolicy = policy.replaceAll(
    "${{ vars.AWS_ACCOUNT_ID }}",
    binding.accountId,
  );
  JSON.parse(expandedPolicy);
  return {
    outputs,
    masks: [
      ...Object.values(outputs),
      binding.bucket,
      binding.kmsKeyArn,
      expandedPolicy,
    ],
  };
}
function validatePlanVariables(text, expected) {
  const variables = JSON.parse(text);
  assert.equal(variables.AWS_ACCOUNT_ID, expected.account_id);
  assert.equal(variables.TERRAFORM_AWS_ROLE_ARN, expected.role_arn);
  assert.equal(variables.DEPLOYMENT_CONTROL_TABLE, expected.control_table);
}
if (require.main === module) {
  try {
    const validate = process.argv[2] === "--validate";
    assert.equal(process.argv.length, validate ? 3 : 2);
    const workflow = load(
      fs.readFileSync(".github/workflows/terraform-plan.yml", "utf8"),
    );
    const policy = workflow.jobs.plan.steps.find(
      (step) => step.name === "Configure production AWS credentials",
    ).with["inline-session-policy"];
    const prepared = preparePlanIdentity(
      process.env.TERRAFORM_PRIVATE_STORAGE_JSON,
      policy,
    );
    if (validate)
      validatePlanVariables(process.env.GITHUB_VARS_JSON, prepared.outputs);
    else {
      for (const value of prepared.masks)
        process.stdout.write(`::add-mask::${value}\n`);
      for (const [key, value] of Object.entries(prepared.outputs))
        fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
    }
  } catch {
    process.stderr.write("Production Plan identity refused\n");
    process.exitCode = 1;
  }
}
module.exports = { preparePlanIdentity, validatePlanVariables };
