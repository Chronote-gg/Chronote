const { spawnSync } = require("node:child_process");
const path = require("node:path");

const args = process.argv.slice(2);
const updateSnapshots = args.includes("--update-snapshots");

const playwrightCli = path.resolve(
  __dirname,
  "..",
  "node_modules",
  "@playwright",
  "test",
  "cli.js",
);

const runArgs = [playwrightCli, "test", "--grep", "@visual"];
if (updateSnapshots) {
  runArgs.push("--update-snapshots");
}

const installDesktopResult = spawnSync("yarn", ["desktop:install"], {
  stdio: "inherit",
  shell: process.platform === "win32",
});
if (installDesktopResult.status !== 0) {
  process.exit(installDesktopResult.status ?? 1);
}

const result = spawnSync(process.execPath, runArgs, {
  stdio: "inherit",
  env: {
    ...process.env,
    PW_VISUAL: "true",
  },
});

process.exit(result.status ?? 1);
