import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const release = "84fa993cf93b9dedd4da19ecbad75bc8712d0874";
const repo = resolve(fileURLToPath(new URL("../", import.meta.url)));
const setup =
  "Set QUALITY_RATCHET_HOME to a clean quality-ratchet checkout at " +
  release +
  ". See docs/engineering/code-quality.md for setup.";

function toolInspectionEnvironment() {
  const result = spawnSync("git", ["rev-parse", "--local-env-vars"], {
    encoding: "utf8",
  });
  if (result.status !== 0)
    throw new Error("Cannot inspect Git hook environment. " + setup);
  const local = new Set(
    result.stdout
      .trim()
      .split(/\r?\n/)
      .map((key) => key.toUpperCase()),
  );
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !local.has(key.toUpperCase()),
    ),
  );
}

function git(home, env, ...args) {
  const result = spawnSync("git", ["-C", home, ...args], {
    encoding: "utf8",
    env,
  });
  if (result.status !== 0)
    throw new Error("Cannot inspect the shared tool checkout. " + setup);
  return result.stdout.trim();
}

function run() {
  const location = process.env.QUALITY_RATCHET_HOME;
  if (!location || !existsSync(location)) throw new Error(setup);
  const home = realpathSync(resolve(location));
  const inspectionEnv = toolInspectionEnvironment();
  if (git(home, inspectionEnv, "rev-parse", "HEAD") !== release)
    throw new Error(
      "Shared tool HEAD does not match the expected release. " + setup,
    );
  if (
    realpathSync(git(home, inspectionEnv, "rev-parse", "--show-toplevel")) !==
    home
  )
    throw new Error(
      "QUALITY_RATCHET_HOME must name the tool checkout root. " + setup,
    );
  if (
    git(home, inspectionEnv, "status", "--porcelain", "--untracked-files=all")
  )
    throw new Error("Shared tool source must be clean. " + setup);
  const entry = join(home, "bin", "quality-ratchet.mjs");
  if (!existsSync(entry))
    throw new Error("Shared tool entry point is unavailable. " + setup);
  const result = spawnSync(
    process.execPath,
    [entry, "--repo", repo, ...process.argv.slice(2)],
    { stdio: "inherit" },
  );
  if (result.error || result.signal || result.status === null)
    throw new Error("Could not run the shared quality tool. " + setup);
  return result.status;
}

try {
  process.exitCode = run();
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
