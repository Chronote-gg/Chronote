const { appendFileSync } = require("node:fs");
const { execFileSync } = require("node:child_process");

const infrastructureOnlyPaths = new Set([
  ".github/workflows/terraform-apply.yml",
  ".github/workflows/terraform-plan.yml",
  "README.md",
  "docs/engineering/infrastructure.md",
  "docs/terraform-delivery.md",
  "scripts/deployment/production-release-scope.cjs",
  "scripts/deployment/terraform-runs.cjs",
  "scripts/deployment/terraform-tfvars.py",
  "test/scripts/deployConcurrency.test.ts",
  "test/scripts/productionReleaseScope.test.js",
  "test/scripts/terraformRuns.test.js",
  "test/scripts/terraformTfvars.test.js",
]);

function needsPublication(paths) {
  return (
    paths.length === 0 ||
    paths.some(
      (path) =>
        !path.startsWith("_infra/") &&
        !path.startsWith("_infra_state_mgmt/") &&
        !infrastructureOnlyPaths.has(path),
    )
  );
}

const shaPattern = /^[0-9a-f]{40}$/;
const publishJobs = ["Deploy Docs", "Deploy Backend", "Deploy Frontend"];

function publicationStatus(run, jobs) {
  if (run.status !== "completed") return "uncertain";
  if (
    run.conclusion === "success" &&
    publishJobs.every((name) =>
      jobs.some((job) => job.name === name && job.conclusion === "success"),
    )
  )
    return "published";
  // A canceled approval has no executed steps. An attempted deploy may already
  // have changed production even if the workflow ultimately failed.
  return jobs.some(
    (job) =>
      job.conclusion === "success" ||
      job.steps?.some((step) => step.started_at),
  )
    ? "uncertain"
    : "untouched";
}

function* deploymentRuns(get, workflowRoute) {
  const pageSize = 20;
  for (let page = 1; ; page += 1) {
    const { workflow_runs: runs } = get(
      workflowRoute + "?branch=master&per_page=" + pageSize + "&page=" + page,
    );
    yield* runs;
    if (runs.length < pageSize) return;
  }
}

function lastPublishedHead(get, repo) {
  const route = "repos/" + repo + "/actions";
  const currentRunId = Number(process.env.GITHUB_RUN_ID);
  for (const run of deploymentRuns(get, route + "/workflows/deploy.yml/runs")) {
    if (!Number.isSafeInteger(run.id) || !shaPattern.test(run.head_sha)) return;
    if (run.id === currentRunId) continue;
    const pages = get(
      route + "/runs/" + run.id + "/jobs?filter=all&per_page=100",
      true,
    );
    const jobs = pages
      .flatMap(({ jobs }) => jobs)
      .filter((job) => publishJobs.includes(job.name));
    const status = publicationStatus(run, jobs);
    if (status === "published") return run.head_sha;
    if (status === "uncertain") return;
  }
}

function changedPaths(before, after) {
  if (![before, after].every((sha) => shaPattern.test(sha ?? ""))) return [];
  execFileSync("git", ["merge-base", "--is-ancestor", before, after], {
    stdio: "ignore",
    timeout: 10000,
  });
  // Read the full diff. GitHub path filters only inspect the first 300 paths.
  return execFileSync(
    "git",
    ["diff", "--name-only", "--no-renames", "-z", before, after, "--"],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10000,
      maxBuffer: 16 * 1024 * 1024,
    },
  )
    .split("\0")
    .filter(Boolean);
}

function publicationDecision(
  repo,
  after,
  get = (path, paginate = false) =>
    JSON.parse(
      execFileSync(
        "gh",
        ["api", ...(paginate ? ["--paginate", "--slurp"] : []), path],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 10000,
          maxBuffer: 8 * 1024 * 1024,
        },
      ),
    ),
  diff = changedPaths,
  verifyMaster = false,
) {
  try {
    const before = lastPublishedHead(get, repo);
    if (verifyMaster) {
      const current = get("repos/" + repo + "/git/ref/heads/master").object.sha;
      if (shaPattern.test(current) && current !== after)
        return { publish: false, paths: [], superseded: true };
    }
    if (before) {
      const paths = diff(before, after);
      if (paths.length)
        return { publish: needsPublication(paths), before, paths };
    }
  } catch {
    // Keep the guarded publish path when GitHub or Git cannot establish scope.
  }
  return { publish: true, paths: [] };
}

if (require.main === module) {
  const [repo, after] = process.argv.slice(2);
  const { publish, before, paths, superseded } = publicationDecision(
    repo,
    after,
    undefined,
    undefined,
    process.env.GITHUB_ACTIONS === "true",
  );
  if (process.env.GITHUB_STEP_SUMMARY) {
    const decision = superseded
      ? "Production publication skipped because a newer master commit superseded this run."
      : !paths.length
        ? "Production publication required because the baseline or diff could not be verified."
        : publish
          ? "Production publication required for this release."
          : "Production publication skipped. The diff contains only infrastructure and operator files.";
    const summary = [decision];
    if (paths.length) {
      summary.push(
        "",
        "Last published commit: " + before,
        "",
        "Changed paths (" + paths.length + "):",
        "",
        "~~~text",
        ...paths.slice(0, 50).map((path) => JSON.stringify(path)),
        "~~~",
      );
      if (paths.length > 50) summary.push("", "First 50 paths shown.");
    }
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary.join("\n") + "\n");
  }
  console.log(publish);
}

module.exports = { needsPublication, publicationDecision, publishJobs };
