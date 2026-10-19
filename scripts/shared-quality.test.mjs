import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const launcher = fileURLToPath(
  new URL("run-shared-quality.mjs", import.meta.url),
);
const localGitEnvironment = new Set(
  execFileSync("git", ["rev-parse", "--local-env-vars"], { encoding: "utf8" })
    .trim()
    .split(/\r?\n/)
    .map((key) => key.toUpperCase()),
);
const fixtureEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !localGitEnvironment.has(key.toUpperCase()),
  ),
);
const git = (dir, ...args) =>
  execFileSync("git", args, {
    cwd: dir,
    env: fixtureEnvironment,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const run = (script, home, args = [], extraEnv = {}) =>
  spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env: { ...fixtureEnvironment, ...extraEnv, QUALITY_RATCHET_HOME: home },
  });

test("missing local checkout gives setup instructions and operational exit", () => {
  for (const home of ["", join(tmpdir(), "missing-shared-quality-checkout")]) {
    const result = run(launcher, home);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /QUALITY_RATCHET_HOME/);
    assert.match(result.stderr, /0873869f6b8fd80150d24689849ec0aebd94e9dd/);
  }
});

test("the launcher refuses an incorrect release checkout", () => {
  const dir = mkdtempSync(join(tmpdir(), "consumer-quality-"));
  try {
    git(dir, "init", "-q");
    git(
      dir,
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--allow-empty",
      "-qm",
      "fixture",
    );
    const result = run(launcher, dir);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /release|HEAD/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a clean pinned tool receives literal arguments and the current Node, with exits preserved", () => {
  const dir = mkdtempSync(join(tmpdir(), "consumer-quality-"));
  try {
    const home = join(dir, "tool with spaces");
    mkdirSync(join(home, "bin"), { recursive: true });
    writeFileSync(
      join(home, "bin/quality-ratchet.mjs"),
      'console.log(JSON.stringify({execPath:process.execPath,args:process.argv.slice(2),env:Object.fromEntries(Object.entries(process.env).filter(([key])=>key.startsWith("GIT_")))})); process.exitCode=Number(process.argv.at(-1));',
    );
    git(home, "init", "-q");
    git(home, "add", ".");
    git(
      home,
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "fixture",
    );
    // Substitute only the release identity in this isolated fixture copy.
    mkdirSync(join(dir, "scripts"));
    const fixtureLauncher = join(dir, "scripts", "launcher.mjs");
    writeFileSync(
      fixtureLauncher,
      readFileSync(launcher, "utf8").replaceAll(
        "0873869f6b8fd80150d24689849ec0aebd94e9dd",
        git(home, "rev-parse", "HEAD"),
      ),
    );
    for (const code of [0, 1, 2]) {
      const result = run(fixtureLauncher, home, [
        "--base",
        "literal;$(echo should-not-run)",
        String(code),
      ]);
      assert.equal(result.status, code, result.stderr);
      const output = JSON.parse(result.stdout);
      assert.equal(output.execPath, process.execPath);
      assert.deepEqual(output.args, [
        "--repo",
        dir,
        "--base",
        "literal;$(echo should-not-run)",
        String(code),
      ]);
    }
    const consumer = join(dir, "consumer checkout");
    mkdirSync(consumer);
    git(consumer, "init", "-q");
    writeFileSync(join(consumer, "source.txt"), "committed\n");
    git(consumer, "add", "source.txt");
    git(
      consumer,
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "consumer",
    );
    writeFileSync(join(consumer, "source.txt"), "staged\n");
    git(consumer, "add", "source.txt");
    writeFileSync(join(consumer, "source.txt"), "working\n");
    const consumerGit = git(consumer, "rev-parse", "--absolute-git-dir");
    const globalConfig = join(dir, "global-config");
    const systemConfig = join(dir, "system-config");
    writeFileSync(globalConfig, "[core]\n  autocrlf = input\n");
    writeFileSync(systemConfig, "[core]\n  autocrlf = false\n");
    const hookEnvironment = {
      GIT_DIR: consumerGit,
      GIT_COMMON_DIR: consumerGit,
      GIT_WORK_TREE: consumer,
      GIT_INDEX_FILE: join(consumerGit, "index"),
      GIT_OBJECT_DIRECTORY: join(consumerGit, "objects"),
      GIT_PREFIX: "nested/",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.worktree",
      GIT_CONFIG_VALUE_0: consumer,
      GIT_CONFIG_GLOBAL: globalConfig,
      GIT_CONFIG_SYSTEM: systemConfig,
    };
    const beforeTree = git(consumer, "write-tree");
    const beforeStatus = git(consumer, "status", "--porcelain");
    const beforeIndex = readFileSync(hookEnvironment.GIT_INDEX_FILE);
    for (const code of [0, 1, 2]) {
      const fromHook = run(
        fixtureLauncher,
        home,
        ["--base", "literal;$(echo should-not-run)", String(code)],
        hookEnvironment,
      );
      assert.equal(fromHook.status, code, fromHook.stderr);
      const output = JSON.parse(fromHook.stdout);
      assert.equal(output.execPath, process.execPath);
      assert.deepEqual(output.args, [
        "--repo",
        dir,
        "--base",
        "literal;$(echo should-not-run)",
        String(code),
      ]);
      for (const [key, value] of Object.entries(hookEnvironment)) {
        assert.equal(output.env[key], value, key);
      }
    }
    assert.deepEqual(readFileSync(hookEnvironment.GIT_INDEX_FILE), beforeIndex);
    assert.equal(git(consumer, "write-tree"), beforeTree);
    assert.equal(git(consumer, "status", "--porcelain"), beforeStatus);
    const withoutGit = join(dir, "without-git");
    mkdirSync(withoutGit);
    const pathKey =
      Object.keys(fixtureEnvironment).find(
        (key) => key.toUpperCase() === "PATH",
      ) ?? "PATH";
    const discoveryFailure = run(fixtureLauncher, home, [], {
      [pathKey]: withoutGit,
    });
    assert.equal(discoveryFailure.status, 2);
    assert.match(
      discoveryFailure.stderr,
      /Cannot inspect Git hook environment/,
    );
    writeFileSync(
      join(home, "untracked-source.mjs"),
      "export const unsafe = true;\n",
    );
    let result = run(fixtureLauncher, home);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /clean/);
    rmSync(join(home, "untracked-source.mjs"));
    writeFileSync(join(home, "bin/quality-ratchet.mjs"), "process.exitCode=0;");
    result = run(fixtureLauncher, home);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /clean/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
