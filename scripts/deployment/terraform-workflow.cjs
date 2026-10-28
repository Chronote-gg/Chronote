"use strict";
const assert = require("node:assert/strict");
const { readFileSync, writeFileSync, appendFileSync } = require("node:fs");
const { join } = require("node:path");
const { createTerraformCapture } = require("./private-capture.cjs");
const {
  parseInvocation,
  createBundle,
  verifyBundle,
  restoreBundle,
} = require("./terraform-bundle.cjs");
const { verifyRun, verifyApproval } = require("./terraform-native.cjs");
const { runPrivateCommand } = require("./terraform-process.cjs");
const { verifyMeetingUpdatePlan } = require("./terraform-meeting-update.cjs");
const { digest } = require("./collector-payload.cjs");
const {
  targets,
  validatePrerequisitePlan,
} = require("./validate-prerequisite-plan.cjs");
const {
  runtimeTargets,
  validateRuntimePlan,
} = require("./validate-runtime-plan.cjs");
const scopedValidators = {
  "deployment-prerequisites": validatePrerequisitePlan,
  "deployment-runtime": validateRuntimePlan,
};
const prerequisites = new WeakMap();
function privatePrerequisiteVerified(token, config) {
  const binding = prerequisites.get(token);
  if (!binding || JSON.stringify(binding.config) !== JSON.stringify(config))
    return false;
  try {
    require("./production-writer-guard.cjs").assertPrerequisitePlan(
      binding.plan,
      config.table,
    );
    return true;
  } catch {
    return false;
  }
}

function execution(options, invocation) {
  const output = [],
    store = createTerraformCapture({
      invocation,
      binding: options.binding,
      client: options.client,
    });
  let commandUnknown = false,
    captureUnknown = false,
    captureIndex = 0;
  async function retain(value) {
    const index = captureIndex++;
    writeFileSync(
      join(options.privateDirectory, `capture-${index}.json`),
      JSON.stringify(value),
      { flag: "wx", mode: 0o600 },
    );
    try {
      const reference = await store.capture(value);
      writeFileSync(
        join(options.privateDirectory, `reference-${index}.json`),
        JSON.stringify(reference),
        { flag: "wx", mode: 0o600 },
      );
      return reference;
    } catch {
      captureUnknown = true;
      throw new Error("UNKNOWN: private capture acknowledgment");
    }
  }
  async function command(file, args) {
    let result;
    try {
      result = await (options.command ?? runPrivateCommand)(file, args, {
        directory: options.privateDirectory,
        index: output.length,
        cwd: options.directory,
        env: options.env,
        signal: options.signal,
      });
    } catch (error) {
      commandUnknown = true;
      throw error;
    }
    commandUnknown = result.outcome !== "exited";
    output.push(result);
    appendFileSync(
      join(options.privateDirectory, "commands.jsonl"),
      JSON.stringify(result) + "\n",
      { mode: 0o600 },
    );
    assert.equal(result.outcome, "exited", "UNKNOWN: command acknowledgment");
    return result;
  }
  async function terraform(args, accepted = [0]) {
    const result = await command("terraform", ["-chdir=_infra", ...args]);
    assert.ok(accepted.includes(result.exitCode), "Terraform command failed");
    return result;
  }
  return {
    store,
    retain,
    command,
    terraform,
    output,
    isUncertain: () => captureUnknown,
    hasUnknownCommand: () => commandUnknown,
  };
}
async function prepare(executionState, options, allowWorkspaceCreation) {
  const written = await executionState.command("python3", [
    join(__dirname, "terraform-tfvars.py"),
  ]);
  assert.equal(written.exitCode, 0);
  await executionState.terraform([
    "init",
    "-input=false",
    "-lockfile=readonly",
  ]);
  const selected = await executionState.terraform(
    ["workspace", "select", options.invocation.workspace],
    allowWorkspaceCreation ? [0, 1] : [0],
  );
  if (selected.exitCode === 1)
    await executionState.terraform([
      "workspace",
      "new",
      options.invocation.workspace,
    ]);
  await executionState.terraform(["validate", "-no-color"]);
}
async function version(executionState) {
  const result = await executionState.terraform(["version", "-json"]);
  const value = JSON.parse(
    Buffer.from(result.stdout, "base64").toString(),
  ).terraform_version;
  assert.match(value, /^\d+\.\d+\.\d+$/);
  return value;
}
async function verifyDelivery(e, options, invocation) {
  if (invocation.scope !== "meeting-update-delivery") return;
  const shown = await e.terraform(["show", "-json", "tfplan"]);
  verifyMeetingUpdatePlan(
    JSON.parse(Buffer.from(shown.stdout, "base64").toString()),
    {
      accountId: options.binding.accountId,
      region: options.binding.region,
    },
  );
}
async function plan(options, invocation, e) {
  await verifyRun(options.get, invocation, false);
  await e.retain({ kind: "terraform-plan-intent-v1", invocation });
  const terraformVersion = await version(e);
  await prepare(e, options, invocation.environment === "production");
  const args = [
    "plan",
    "-no-color",
    "-input=false",
    "-detailed-exitcode",
    "-out=tfplan",
  ];
  if (invocation.scope === "purchase-permission")
    args.push("-target=aws_iam_role_policy.initial_purchase_condition");
  if (invocation.scope === "meeting-update-delivery")
    args.push(
      "-target=aws_dynamodb_table.meeting_history_table",
      "-target=aws_iam_policy.dynamodb_access_policy",
    );
  if (invocation.scope === "deployment-prerequisites")
    args.push(...[...targets].map((target) => `-target=${target}`));
  if (invocation.scope === "deployment-runtime")
    args.push(
      ...[...runtimeTargets.keys()].map((target) => `-target=${target}`),
    );
  const planned = await e.terraform(args, [0, 2]);
  const validateScope = scopedValidators[invocation.scope];
  if (validateScope) {
    const shown = await e.terraform(["show", "-json", "tfplan"]);
    validateScope(JSON.parse(Buffer.from(shown.stdout, "base64").toString()));
  }
  const shown = await e.terraform(["show", "-no-color", "tfplan"]);
  await verifyDelivery(e, options, invocation);
  const bundle = createBundle({
    invocation,
    terraformVersion,
    lockfileSha256: options.lockfileSha256,
    directory: join(options.directory, "_infra"),
    review: Buffer.from(shown.stdout, "base64"),
    output: e.output,
  });
  const reference = await e.retain(bundle);
  writeFileSync(
    join(options.privateDirectory, "bundle-reference.json"),
    JSON.stringify(reference),
    { flag: "wx", mode: 0o600 },
  );
  return {
    status: planned.exitCode === 2 ? "planned-changes" : "planned-no-changes",
    bundleSha256: reference.sha256,
    planSha256: digest(readFileSync(join(options.directory, "_infra/tfplan"))),
    artifactName: `terraform-plan-${invocation.environment}-${invocation.workspace}-${invocation.runId}`,
  };
}
async function apply(options, invocation, e, startApply) {
  if (invocation.environment === "production")
    await require("./production-writer-guard.cjs").runGuard(options.env, true);
  const proof = await verifyApproval(options.get, invocation, options);
  const producer = parseInvocation({
    ...invocation,
    workflowPath: ".github/workflows/terraform-plan.yml",
    runId: options.producerRunId,
  });
  assert.equal(
    options.artifactName,
    `terraform-plan-${producer.environment}-${producer.workspace}-${producer.runId}`,
  );
  const nativeProducer = await verifyRun(options.get, producer, true);
  assert.ok(
    Date.parse(nativeProducer.updated_at) < Date.parse(proof.createdAt),
  );
  assert.equal(options.reference.sha256, options.bundleSha256);
  const producerStore = createTerraformCapture({
    invocation: producer,
    binding: options.binding,
    client: options.client,
  });
  const bundle = await producerStore.readCapture(options.reference);
  await e.retain({
    kind: "terraform-apply-intent-v1",
    invocation,
    producer,
    planSha256: options.planSha256,
    bundleSha256: options.bundleSha256,
    approval: proof,
  });
  const terraformVersion = await version(e);
  const files = verifyBundle(bundle, {
    invocation: producer,
    terraformVersion,
    lockfileSha256: options.lockfileSha256,
    planSha256: options.planSha256,
    bundleSha256: options.bundleSha256,
  });
  restoreBundle(files, join(options.directory, "_infra"));
  await prepare(e, options, false);
  const shown = await e.terraform(["show", "-no-color", "tfplan"]);
  assert.deepEqual(
    Buffer.from(shown.stdout, "base64"),
    files.get("terraform-review.txt"),
  );
  assert.deepEqual(
    await verifyApproval(options.get, invocation, options),
    proof,
  );
  const producerAgain = await verifyRun(options.get, producer, true);
  assert.deepEqual(producerAgain, nativeProducer);
  assert.equal(
    digest(readFileSync(join(options.directory, "_infra/.terraform.lock.hcl"))),
    options.lockfileSha256,
  );
  for (const [name, bytes] of files)
    assert.deepEqual(
      readFileSync(join(options.directory, "_infra", name)),
      bytes,
    );
  let prerequisite;
  if (invocation.environment === "production") {
    const {
      runGuard,
      guardConfiguration,
    } = require("./production-writer-guard.cjs");
    if (invocation.scope === "deployment-prerequisites") {
      const shown = await e.terraform(["show", "-json", "tfplan"]);
      const plan = JSON.parse(Buffer.from(shown.stdout, "base64").toString());
      const config = guardConfiguration(options.env);
      validatePrerequisitePlan(plan);
      // Only this authenticated, restored bundle can authorize a missing Control table.
      assert.deepEqual(
        readFileSync(join(options.directory, "_infra/tfplan")),
        files.get("tfplan"),
      );
      prerequisite = {};
      prerequisites.set(prerequisite, { config, plan });
    }
    if (invocation.scope === "deployment-runtime") {
      const shown = await e.terraform(["show", "-json", "tfplan"]);
      validateRuntimePlan(
        JSON.parse(Buffer.from(shown.stdout, "base64").toString()),
      );
    }
    await runGuard(options.env, false, prerequisite);
  }
  await verifyDelivery(e, options, invocation);
  assert.equal(
    digest(readFileSync(join(options.directory, "_infra/tfplan"))),
    options.planSha256,
  );
  options.signal.throwIfAborted();
  startApply();
  await e.terraform(["apply", "-no-color", "-input=false", "tfplan"]);
  assert.deepEqual(
    await verifyApproval(options.get, invocation, options),
    proof,
  );
  return {
    status: "applied",
    bundleSha256: options.bundleSha256,
    planSha256: options.planSha256,
  };
}
async function runTerraform(options) {
  let e,
    invocation,
    result,
    applyStarted = false,
    ready = false;
  try {
    invocation = parseInvocation(options.invocation);
    e = execution(options, invocation);
    await e.store.checkReady();
    options.signal.throwIfAborted();
    options = {
      ...options,
      invocation,
      lockfileSha256: digest(
        readFileSync(join(options.directory, "_infra/.terraform.lock.hcl")),
      ),
    };
    ready = true;
    result = invocation.workflowPath.endsWith("terraform-plan.yml")
      ? await plan(options, invocation, e)
      : await apply(options, invocation, e, () => {
          applyStarted = true;
        });
  } catch (error) {
    result = {
      status:
        applyStarted || e?.isUncertain() || e?.hasUnknownCommand()
          ? "unknown"
          : ready && invocation.workflowPath.endsWith("terraform-plan.yml")
            ? "failed"
            : "refused",
    };
    try {
      writeFileSync(
        join(options.privateDirectory, "failure.txt"),
        String(error.stack),
        { flag: "wx", mode: 0o600 },
      );
    } catch {
      // Preserve the primary outcome and any existing evidence if local persistence fails.
    }
  }
  if (ready && !e.isUncertain()) {
    try {
      await e.retain({
        kind: "terraform-execution-output-v1",
        invocation,
        reviewedBundleSha256: options.bundleSha256 ?? null,
        result,
        output: e.output,
      });
    } catch {
      result = { status: "unknown" };
    }
  }
  return result;
}
module.exports = { runTerraform, privatePrerequisiteVerified };
