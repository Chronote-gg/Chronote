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

function shouldPublish(before, after) {
  if (![before, after].every((sha) => /^[0-9a-f]{40}$/.test(sha ?? "")))
    return true;
  try {
    // GitHub path filters inspect only the first 300 paths.
    // Read the complete diff, including deletions and rename destinations.
    const paths = execFileSync(
      "git",
      ["diff", "--name-only", "--no-renames", "-z", before, after, "--"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 16 * 1024 * 1024,
      },
    )
      .split("\0")
      .filter(Boolean);
    return needsPublication(paths);
  } catch {
    return true;
  }
}

if (require.main === module)
  console.log(shouldPublish(...process.argv.slice(2)));

module.exports = { needsPublication, shouldPublish };
