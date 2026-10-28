"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { parse } = require("yaml");
const { preparePlanIdentity } = require("./terraform-plan-identity.cjs");
function prepareSiteIdentity(text) {
  const base = preparePlanIdentity(text, "{}").outputs;
  const binding = JSON.parse(text);
  const outputs = {
    ...base,
    role_arn: `arn:aws:iam::${base.account_id}:role/meeting-notes-prod-github-deploy`,
  };
  return {
    outputs,
    masks: [
      ...Object.values(outputs),
      binding.bucket,
      binding.kmsKeyArn,
      `meeting-notes-prod-docs-${base.account_id}`,
      `meeting-notes-prod-frontend-${base.account_id}`,
    ],
  };
}
function prepareSiteSession(text, variablesText, site, template) {
  assert.ok(["docs", "frontend"].includes(site));
  const { outputs } = prepareSiteIdentity(text),
    variables = JSON.parse(variablesText);
  assert.equal(variables.AWS_ACCOUNT_ID, outputs.account_id);
  assert.equal(variables.PRODUCTION_BACKEND_DEPLOY_ROLE_ARN, outputs.role_arn);
  assert.equal(variables.DEPLOYMENT_CONTROL_TABLE, outputs.control_table);
  assert.equal(variables.AWS_REGION, "us-east-1");
  const bucketName = site.toUpperCase() + "_BUCKET",
    distributionName = site.toUpperCase() + "_DISTRIBUTION_ID";
  assert.match(variables[bucketName], /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/);
  assert.ok(
    !variables[bucketName].includes("..") &&
      !/^\d+\.\d+\.\d+\.\d+$/.test(variables[bucketName]),
  );
  assert.match(variables[distributionName], /^[A-Z0-9]{1,32}$/);
  const allowed = new Set([
    "AWS_ACCOUNT_ID",
    "AWS_REGION",
    "DEPLOYMENT_CONTROL_TABLE",
    bucketName,
    distributionName,
  ]);
  const policy = template.replace(
    /\$\{\{\s*vars\.([A-Z0-9_]+)\s*\}\}/g,
    (_match, name) => {
      assert.ok(allowed.has(name));
      return variables[name];
    },
  );
  assert.ok(!policy.includes("${{"));
  JSON.parse(policy);
  assert.ok(Buffer.byteLength(policy) <= 2048);
  return {
    policy,
    masks: [policy, variables[bucketName], variables[distributionName]],
  };
}
if (require.main === module) {
  try {
    const mode = process.argv[2],
      text = process.env.TERRAFORM_PRIVATE_STORAGE_JSON;
    assert.ok(["identity", "session"].includes(mode));
    assert.equal(process.argv.length, mode === "identity" ? 3 : 4);
    const identity = prepareSiteIdentity(text);
    let masks = identity.masks;
    if (mode === "session") {
      const site = process.argv[3];
      assert.ok(["docs", "frontend"].includes(site));
      const workflow = parse(
        fs.readFileSync(".github/workflows/deploy.yml", "utf8"),
      );
      const template = workflow.jobs[`deploy-${site}`].steps.find(
        (step) => step.name === "Configure AWS credentials",
      ).with["inline-session-policy"];
      const names = [
        "AWS_ACCOUNT_ID",
        "PRODUCTION_BACKEND_DEPLOY_ROLE_ARN",
        "DEPLOYMENT_CONTROL_TABLE",
        "AWS_REGION",
        site.toUpperCase() + "_BUCKET",
        site.toUpperCase() + "_DISTRIBUTION_ID",
      ];
      const variables = Object.fromEntries(
        names.map((name) => [name, process.env[name]]),
      );
      masks = prepareSiteSession(
        text,
        JSON.stringify(variables),
        site,
        template,
      ).masks;
    }
    for (const value of masks) process.stdout.write(`::add-mask::${value}\n`);
    if (mode === "identity")
      for (const [key, value] of Object.entries(identity.outputs))
        fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  } catch {
    process.stderr.write("Site publisher identity refused\n");
    process.exitCode = 1;
  }
}
module.exports = { prepareSiteIdentity, prepareSiteSession };
