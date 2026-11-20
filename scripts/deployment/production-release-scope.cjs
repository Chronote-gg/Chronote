const { appendFileSync } = require("node:fs");
const { execFileSync } = require("node:child_process");

const infrastructureOnlyPaths = new Set([
  ".github/workflows/deploy.yml",
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

function lastPublishedHead(get, repo) {
  const route = "repos/" + repo + "/actions";
  const { workflow_runs: runs } = get(
    route +
      "/workflows/deploy.yml/runs?branch=master&status=success&per_page=20",
  );
  for (const run of runs) {
    if (!Number.isSafeInteger(run.id) || !shaPattern.test(run.head_sha))
      continue;
    const { jobs } = get(route + "/runs/" + run.id + "/jobs?per_page=100");
    if (
      publishJobs.every((name) =>
        jobs.some((job) => job.name === name && job.conclusion === "success"),
      )
    ) {
      return run.head_sha;
    }
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
  get = (path) =>
    JSON.parse(
      execFileSync("gh", ["api", path], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 10000,
      }),
    ),
  diff = changedPaths,
) {
  try {
    const before = lastPublishedHead(get, repo);
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
  const { publish, before, paths } = publicationDecision(
    ...process.argv.slice(2),
  );
  if (process.env.GITHUB_STEP_SUMMARY) {
    const decision = !paths.length
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

module.exports = { needsPublication, publicationDecision };
