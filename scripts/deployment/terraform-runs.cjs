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

// Saved plans and Terraform logs live in a restricted prefix of the state bucket.
function planStore(environment, runId, attempt, backendSource) {
  assert.ok(["production", "sandbox"].includes(environment));
  assert.match(String(runId), /^[1-9]\d{0,15}$/);
  assert.match(String(attempt), /^[1-9]\d{0,3}$/);
  const bucket = backendSource.match(
    /backend "s3" \{[^}]*?\bbucket\s*=\s*"([^"]+)"/,
  )?.[1];
  assert.ok(bucket, "No S3 backend bucket in _infra/main.tf");
  return {
    bucket,
    prefix: `terraform-plans/${environment}/${runId}-${attempt}`,
  };
}

// Apply runs only the bundle of a successful first-attempt plan of this exact
// commit: a re-run would store a different bundle under another attempt.
async function verifyPlanRun(
  get,
  { repository, runId, environment, sha, planSha256 },
) {
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
  assert.match(planSha256, /^[0-9a-f]{64}$/);
  const artifacts = await get(
    `/repos/${repository}/actions/runs/${runId}/artifacts?per_page=100`,
  );
  assert.equal(artifacts.artifacts.length, artifacts.total_count);
  const digests = artifacts.artifacts.filter((artifact) =>
    artifact.name.startsWith("terraform-plan-sha256-"),
  );
  assert.equal(
    digests.length,
    1,
    "The plan run must publish one reviewed bundle digest",
  );
  assert.equal(
    digests[0].expired,
    false,
    "The reviewed plan digest expired; plan again",
  );
  assert.equal(
    digests[0].name,
    `terraform-plan-sha256-${planSha256}`,
    "The digest does not match the plan run",
  );
  return run;
}

const planPrefix = "terraform-plans/";
// A stored plan holds credentials, so nothing may be stored unless the bucket
// itself expires it. The bucket is versioned: expiring the current version
// only adds a delete marker, so noncurrent versions must expire too.
function checkPlanRetention(config) {
  const covering = (config.Rules ?? []).filter((rule) => {
    if (rule.Status !== "Enabled") return false;
    const prefix =
      rule.Filter?.Prefix ?? rule.Filter?.And?.Prefix ?? rule.Prefix ?? "";
    return (
      prefix === planPrefix &&
      !rule.Filter?.And &&
      Object.keys(rule.Filter ?? {}).every((key) => key === "Prefix")
    );
  });
  assert.ok(
    covering.some(
      (rule) =>
        Number.isInteger(rule.Expiration?.Days) &&
        rule.Expiration.Days > 0 &&
        rule.Expiration.Days <= 30,
    ),
    "No enabled lifecycle rule expires terraform-plans/ in the state bucket; add the rule in docs/terraform-delivery.md before planning",
  );
  assert.ok(
    covering.some(
      (rule) =>
        rule.NoncurrentVersionExpiration?.NoncurrentDays === 1 &&
        !rule.NoncurrentVersionExpiration.NewerNoncurrentVersions,
    ),
    "No enabled lifecycle rule removes noncurrent versions under terraform-plans/; add the rule in docs/terraform-delivery.md before planning",
  );
}

// Both prefixes need their own deny: ReadOnlyAccess must not cross environments.
function checkPlanPolicy(policy, account) {
  assert.match(account, /^\d{12}$/);
  const environmentRoles = ["prod", "sandbox"].map((environment) =>
    ["terraform", "terraform-plan"].map(
      (role) =>
        `arn:aws:iam::${account}:role/meeting-notes-${environment}-github-${role}`,
    ),
  );
  const allRoles = environmentRoles.flat();
  assert.ok(
    !policy.Statement?.some((statement) => {
      const allowed = statement.Condition?.ArnNotLike?.["aws:PrincipalArn"];
      return (
        statement.Effect === "Deny" &&
        statement.Resource ===
          "arn:aws:s3:::meeting-notes-terraform-state-bucket/terraform-plans/*" &&
        Array.isArray(allowed) &&
        !allRoles.every((role) => allowed.includes(role))
      );
    }),
    "Replace the legacy shared-prefix read deny with isolated environment restrictions before planning",
  );
  for (const [index, environment] of ["production", "sandbox"].entries()) {
    const roles = environmentRoles[index];
    assert.ok(
      policy.Statement?.some((statement) => {
        const allowed = statement.Condition?.ArnNotLike?.["aws:PrincipalArn"];
        return (
          statement.Effect === "Deny" &&
          statement.Principal === "*" &&
          statement.Resource ===
            `arn:aws:s3:::meeting-notes-terraform-state-bucket/terraform-plans/${environment}/*` &&
          Array.isArray(statement.Action) &&
          ["s3:GetObject", "s3:GetObjectVersion"].every((action) =>
            statement.Action.includes(action),
          ) &&
          Object.keys(statement.Condition).length === 1 &&
          Object.keys(statement.Condition.ArnNotLike).length === 1 &&
          Array.isArray(allowed) &&
          allowed.length === 3 &&
          roles.every((role) => allowed.includes(role)) &&
          allowed.filter((arn) => !allRoles.includes(arn)).length === 1 &&
          allowed.every(
            (arn) =>
              arn.startsWith(`arn:aws:iam::${account}:role/`) &&
              /^arn:aws:iam::[0-9]{12}:role\/[A-Za-z0-9_+=,.@/-]+$/.test(arn),
          )
        );
      }),
      `Stored plans require the ${environment} read restriction in docs/terraform-delivery.md before planning`,
    );
  }
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
  ["forget", "remove from state"],
]);

// Changes a reviewer must read even when they look routine: identity,
// encryption, network exposure, the approval gate and credentials.
const sensitiveType =
  /^(aws_iam_|aws_kms_|aws_s3_bucket_policy$|aws_s3_bucket_public_access_block$|aws_security_group|aws_default_security_group$|aws_vpc_security_group_|aws_secretsmanager_|github_repository_environment|github_actions_\w*secret)/;

// Reads only types, addresses and actions from `terraform show -json`: the
// plan's before/after values carry secrets and must never reach the summary.
function planSummary(plan, { sha, digest, attempt, location }) {
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
      "No changes. Nothing was stored and there is nothing to apply.",
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
    `Plan bundle SHA-256 (\`plan_sha256\`): \`${digest}\``,
    `Plan bundle: \`${location}\``,
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
    ...flagged(
      "Remove from state",
      changes.filter((c) => c.kind === "remove from state"),
    ),
    "### All changes",
    "",
    ...changes.map(({ address, kind }) => `- \`${address}\` ${kind}`),
    "",
  ].join("\n");
}

module.exports = {
  github,
  checkPlanRetention,
  checkPlanPolicy,
  verifyPlanRun,
  assertProductionIdle,
  waitForApplyIdle,
  planStore,
  planSummary,
};

async function main([command, ...args]) {
  const { GITHUB_REPOSITORY: repository, GH_TOKEN: token } = process.env;
  if (command === "plan-summary") {
    const [planPath, sha, attempt, digest, location] = args;
    const plan = JSON.parse(readFileSync(planPath, "utf8"));
    process.stdout.write(planSummary(plan, { sha, attempt, digest, location }));
    return;
  }
  if (command === "check-plan-retention") {
    checkPlanRetention(JSON.parse(readFileSync(args[0], "utf8")));
    return;
  }
  if (command === "plan-store") {
    const [environment, runId, attempt] = args;
    const store = planStore(
      environment,
      runId,
      attempt,
      readFileSync("_infra/main.tf", "utf8"),
    );
    process.stdout.write(`bucket=${store.bucket}\nprefix=${store.prefix}\n`);
    return;
  }
  if (command === "check-plan-policy") {
    checkPlanPolicy(JSON.parse(readFileSync(args[0], "utf8")), args[1]);
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
      planSha256: process.env.PLAN_SHA256,
    });
  } else throw new Error(`Unknown command ${command}`);
}
if (require.main === module)
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
