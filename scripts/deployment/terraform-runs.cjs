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

// Apply runs only the artifact of a successful plan of this exact commit.
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
  for (;;) {
    let busy = true;
    try {
      busy = await applyInProgress(get, repository, environment);
    } catch {
      log("Terraform Apply runs could not be read; counting as in progress");
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

// Reads only addresses and actions from `terraform show -json`: the plan's
// before/after values carry secrets and must never reach the summary.
function planSummary(plan, { sha, digest }) {
  const changes = plan.resource_changes
    .map(({ address, change }) => ({
      address,
      kind: actionKinds.get(change.actions.join(",")),
    }))
    .filter((change) => change.kind);
  const count = (kind) => changes.filter((c) => c.kind === kind).length;
  const line = ({ address, kind }) => `- \`${address}\` ${kind}`;
  const dangerous = changes.filter((c) =>
    ["replace", "destroy"].includes(c.kind),
  );
  return [
    "## Terraform Plan",
    "",
    `Commit: \`${sha}\``,
    `Encrypted plan SHA-256: \`${digest}\``,
    "",
    `${count("add")} to add, ${count("change")} to change, ${count("replace")} to replace, ${count("destroy")} to destroy.`,
    "",
    ...(dangerous.length
      ? [
          "### :warning: Replace or destroy",
          "",
          ...dangerous.map((c) => `- **\`${c.address}\` ${c.kind}**`),
          "",
        ]
      : []),
    "### All changes",
    "",
    ...(changes.length ? changes.map(line) : ["No changes."]),
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
    const [planPath, sha, digest] = args;
    const plan = JSON.parse(readFileSync(planPath, "utf8"));
    process.stdout.write(planSummary(plan, { sha, digest }));
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
