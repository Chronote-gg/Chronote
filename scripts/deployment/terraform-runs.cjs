"use strict";
// Checks the Terraform and deploy workflows make against GitHub Actions run
// metadata, and the redacted plan summary. Standard library only, so the
// Terraform workflows need no dependency install.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");

const repositoryPathPattern = /^\/repos\/Chronote-gg\/Chronote\/[\w/.?=&-]+$/;

function github(token, request = fetch) {
  assert.ok(token, "GH_TOKEN is required");
  return async (path) => {
    assert.match(path, repositoryPathPattern);
    const response = await request("https://api.github.com" + path, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    });
    assert.ok(response.ok, `GitHub API ${response.status} for ${path}`);
    return response.json();
  };
}

const planWorkflow = ".github/workflows/terraform-plan.yml";

// Apply runs only the artifact of a successful first-attempt plan of this
// exact commit: a re-run could replace the artifact that was reviewed.
async function verifyPlanRun(get, { repository, runId, environment, sha }) {
  const run = await get(`/repos/${repository}/actions/runs/${runId}`);
  assert.equal(String(run.id), String(runId));
  assert.equal(run.repository.full_name, repository);
  assert.equal(run.head_repository.full_name, repository);
  assert.equal(
    run.path.split("@")[0],
    planWorkflow,
    "Not a Terraform Plan run",
  );
  assert.equal(run.event, "workflow_dispatch");
  assert.equal(run.head_branch, "master", "The plan must run on master");
  assert.equal(run.display_title, `Terraform Plan ${environment}`);
  assert.equal(run.status, "completed");
  assert.equal(run.conclusion, "success", "The plan run did not succeed");
  assert.equal(
    run.head_sha,
    sha,
    "Apply must check out the commit the plan was made from",
  );
  assert.equal(
    run.run_attempt,
    1,
    "A re-run plan cannot be applied; plan again",
  );
  const artifacts = await get(
    `/repos/${repository}/actions/runs/${runId}/artifacts?name=terraform-plan-${environment}`,
  );
  assert.equal(
    artifacts.total_count,
    1,
    "The plan has no changes; there is nothing to apply",
  );
  return run;
}

// Workflows that move production traffic or roles that the Apply may change.
const productionWriters = ["deploy.yml"];
const activeStatuses = ["in_progress", "queued", "waiting", "pending"];
// Apply has its own concurrency group, so it checks for running writers
// itself, and each backend deploy waits for a running Apply (waitForApplyIdle).
// Both are snapshots: two starts within one poll of each other can overlap.
async function assertProductionIdle(get, repository) {
  for (const workflow of productionWriters)
    for (const status of activeStatuses) {
      const runs = await get(
        `/repos/${repository}/actions/workflows/${workflow}/runs?status=${status}&per_page=1`,
      );
      assert.ok(Number.isSafeInteger(runs.total_count));
      assert.equal(
        runs.total_count,
        0,
        `Production writer ${workflow} has a ${status} run; Apply after it settles`,
      );
    }
}

const applyPollMs = 30 * 1000;
const applyWaitMs = 60 * 60 * 1000;
const applyUnreadableMs = 5 * 60 * 1000;
// The runs API omits dispatch inputs; the Apply run name starts with them.
async function applyInProgress(get, repository, environment) {
  const runs = await get(
    `/repos/${repository}/actions/workflows/terraform-apply.yml/runs?status=in_progress&per_page=100`,
  );
  assert.equal(runs.workflow_runs.length, runs.total_count);
  return runs.workflow_runs.some((run) =>
    run.display_title.startsWith(`Terraform Apply ${environment} `),
  );
}
// Approved and running only: a queued or approval-waiting Apply has not
// started and refuses on its own while this deploy is open.
async function waitForApplyIdle(
  get,
  repository,
  environment,
  {
    now = Date.now,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log = console.log,
  } = {},
) {
  const start = now();
  let unreadableSince;
  for (;;) {
    let busy;
    try {
      busy = await applyInProgress(get, repository, environment);
      unreadableSince = undefined;
    } catch {
      // Proceeding could overlap an Apply, so an unreadable API counts as busy,
      // but only for a short window: then it fails under its own name.
      unreadableSince ??= now();
      if (now() - unreadableSince >= applyUnreadableMs)
        throw new Error(
          "Terraform Apply state could not be read for 5 minutes; deploy again once the GitHub Actions API answers",
        );
      log("Terraform Apply runs could not be read; counting as in progress");
      await sleep(applyPollMs);
      continue;
    }
    if (!busy) return "idle";
    if (now() - start >= applyWaitMs)
      throw new Error(
        `Terraform Apply for ${environment} is still in progress after 60 minutes; deploy again once it finishes`,
      );
    log(`Terraform Apply for ${environment} is in progress; waiting`);
    await sleep(applyPollMs);
  }
}

const actionKinds = new Map([
  ["create", "add"],
  ["update", "change"],
  ["delete,create", "replace"],
  ["create,delete", "replace"],
  ["delete", "destroy"],
]);

// Changes a reviewer must read even when they look routine: identity,
// encryption, network exposure, the approval gate and credentials.
const sensitiveType =
  /^(aws_iam_|aws_kms_|aws_s3_bucket_policy$|aws_s3_bucket_public_access_block$|aws_security_group|aws_default_security_group$|aws_vpc_security_group_|aws_secretsmanager_|github_repository_environment|github_actions_\w*secret)/;

// Reads only types, addresses and actions from `terraform show -json`: the
// plan's before/after values carry secrets and must never reach the summary.
function planSummary(plan, { sha, digest, attempt }) {
  const changes = (plan.resource_changes ?? [])
    .map(({ address, type, change }) => ({
      address,
      type,
      kind: actionKinds.get(change.actions.join(",")),
    }))
    .filter((change) => change.kind);
  const header = [
    "## Terraform Plan",
    "",
    `Commit: \`${sha}\``,
    `Plan run attempt: ${attempt}`,
  ];
  if (!changes.length)
    return [
      ...header,
      "",
      "No changes. Nothing was uploaded and there is nothing to apply.",
      "",
    ].join("\n");
  const count = (kind) => changes.filter((c) => c.kind === kind).length;
  const flagged = (title, list) =>
    list.length
      ? [
          `### :warning: ${title}`,
          "",
          ...list.map((c) => `- **\`${c.address}\` ${c.kind}**`),
          "",
        ]
      : [];
  return [
    ...header,
    `Encrypted plan SHA-256 (\`plan_sha256\`): \`${digest}\``,
    "",
    `${count("add")} to add, ${count("change")} to change, ${count("replace")} to replace, ${count("destroy")} to destroy.`,
    "",
    ...flagged(
      "Security-sensitive",
      changes.filter((c) => sensitiveType.test(c.type)),
    ),
    ...flagged(
      "Replace or destroy",
      changes.filter((c) => ["replace", "destroy"].includes(c.kind)),
    ),
    "### All changes",
    "",
    ...changes.map(({ address, kind }) => `- \`${address}\` ${kind}`),
    "",
  ].join("\n");
}

module.exports = {
  github,
  verifyPlanRun,
  assertProductionIdle,
  waitForApplyIdle,
  planSummary,
};

async function main([command, ...args]) {
  const { GITHUB_REPOSITORY: repository, GH_TOKEN: token } = process.env;
  if (command === "plan-summary") {
    const [planPath, sha, attempt, digest] = args;
    const plan = JSON.parse(readFileSync(planPath, "utf8"));
    process.stdout.write(planSummary(plan, { sha, attempt, digest }));
    return;
  }
  const get = github(token);
  if (command === "wait-apply-idle") {
    const [environment] = args;
    assert.ok(["production", "sandbox"].includes(environment));
    await waitForApplyIdle(get, repository, environment);
  } else if (command === "assert-production-idle") {
    await assertProductionIdle(get, repository);
  } else if (command === "verify-plan-run") {
    const [environment, runId] = args;
    assert.match(runId, /^[1-9]\d{0,15}$/);
    await verifyPlanRun(get, {
      repository,
      runId,
      environment,
      sha: process.env.GITHUB_SHA,
    });
  } else throw new Error(`Unknown command ${command}`);
}
if (require.main === module)
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
