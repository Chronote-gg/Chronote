"use strict";
const assert = require("node:assert/strict");
const { readFileSync, mkdirSync, appendFileSync } = require("node:fs");
const { execFileSync } = require("node:child_process");
const { join } = require("node:path");
function parseDispatch(env, event) {
  const { z } = require("zod");
  const { parseInvocation } = require("./terraform-bundle.cjs");
  assert.equal(env.GITHUB_ACTIONS, "true");
  assert.equal(env.GITHUB_EVENT_NAME, "workflow_dispatch");
  assert.equal(env.GITHUB_WORKFLOW_SHA, env.GITHUB_SHA);
  assert.equal(env.GITHUB_RUN_ATTEMPT, "1");
  assert.equal(event.repository.full_name, env.GITHUB_REPOSITORY);
  const prefix = env.GITHUB_REPOSITORY + "/",
    suffix = "@" + env.GITHUB_REF;
  assert.ok(
    env.GITHUB_WORKFLOW_REF.startsWith(prefix) &&
      env.GITHUB_WORKFLOW_REF.endsWith(suffix),
  );
  const workflowPath = env.GITHUB_WORKFLOW_REF.slice(
    prefix.length,
    -suffix.length,
  );
  const base = {
    github_environment: z.enum(["production", "sandbox"]),
    terraform_workspace: z.enum(["default", "sandbox"]),
    plan_scope: z.enum([
      "full",
      "purchase-permission",
      "meeting-update-delivery",
      "deployment-prerequisites",
      "deployment-runtime",
      "site-delivery",
      "processing-retry",
    ]),
  };
  const hash = z.string().regex(/^[a-f0-9]{64}$/);
  const apply = workflowPath === ".github/workflows/terraform-apply.yml";
  const input = z
    .object(
      apply
        ? {
            ...base,
            plan_run_id: z.string().regex(/^[1-9]\d{0,15}$/),
            artifact_name: z
              .string()
              .regex(
                /^terraform-plan-(production-default|sandbox-sandbox)-[1-9]\d{0,15}$/,
              ),
            plan_sha256: hash,
            bundle_sha256: hash,
            confirmation: z.literal("apply"),
          }
        : base,
    )
    .strict()
    .parse(event.inputs);
  const invocation = parseInvocation({
    repository: env.GITHUB_REPOSITORY,
    sourceSha: env.GITHUB_SHA,
    workflowPath,
    runId: env.GITHUB_RUN_ID,
    runAttempt: 1,
    environment: input.github_environment,
    workspace: input.terraform_workspace,
    scope: input.plan_scope,
  });
  return {
    invocation,
    producerRunId: input.plan_run_id,
    artifactName: input.artifact_name,
    planSha256: input.plan_sha256,
    bundleSha256: input.bundle_sha256,
  };
}
async function main(validateOnly = false) {
  let result = { status: "refused" };
  try {
    process.umask(0o077);
    const env = process.env,
      event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
    const options = parseDispatch(env, event);
    if (validateOnly) return;
    const { nativeGitHub } = require("./terraform-native.cjs");
    const { runTerraform } = require("./terraform-workflow.cjs");
    const directory = process.cwd();
    assert.equal(
      execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: directory,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim(),
      options.invocation.sourceSha,
    );
    const binding = JSON.parse(env.TERRAFORM_PRIVATE_STORAGE_JSON);
    const reference = options.producerRunId
      ? JSON.parse(env.TERRAFORM_PLAN_REFERENCE_JSON)
      : undefined;
    const privateDirectory = join(
      env.RUNNER_TEMP,
      `chronote-terraform-${options.invocation.runId}-1`,
    );
    mkdirSync(privateDirectory, { mode: 0o700 });
    const controller = new AbortController();
    const abort = () => controller.abort();
    process.once("SIGINT", abort);
    process.once("SIGTERM", abort);
    const deadline = setTimeout(abort, 5 * 60 * 60 * 1000);
    try {
      const executionOptions = {
        ...options,
        directory,
        privateDirectory,
        env,
        binding,
        reference,
        get: nativeGitHub(env.GH_TOKEN),
        signal: controller.signal,
      };
      result = { status: "unknown" };
      result = await runTerraform(executionOptions);
    } finally {
      clearTimeout(deadline);
      process.removeListener("SIGINT", abort);
      process.removeListener("SIGTERM", abort);
    }
  } catch {
    // Once delegated, an unexpected failure cannot establish non-execution.
  }
  process.exitCode = [
    "planned-changes",
    "planned-no-changes",
    "applied",
  ].includes(result.status)
    ? 0
    : 1;
  try {
    const publicValue = JSON.stringify(result);
    console.log(publicValue);
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, publicValue + "\n");
  } catch {
    // Publication failure does not replace the known or uncertain provider outcome.
    process.exitCode = 1;
  }
}
if (require.main === module) void main(process.argv[2] === "--validate");
module.exports = { parseDispatch };
