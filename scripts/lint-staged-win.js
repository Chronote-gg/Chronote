#!/usr/bin/env node
const { execFileSync } = require("child_process");
const path = require("path");

function batches(files) {
  const result = [];
  let batch = [];
  let length = 0;
  for (const file of files) {
    if (length + file.length + 3 > 6000 && batch.length) {
      result.push(batch);
      batch = [];
      length = 0;
    }
    batch.push(file);
    length += file.length + 3;
  }
  if (batch.length) result.push(batch);
  return result;
}

function runStagedChecks(run = execFileSync) {
  const readPaths = (args) =>
    run("git", args, { encoding: "utf8" }).split("\0").filter(Boolean);
  const staged = readPaths([
    "diff",
    "--cached",
    "--name-only",
    "--diff-filter=ACM",
    "-z",
  ]);
  if (!staged.length) return;
  const tools = [
    ["eslint/bin/eslint.js", "--fix", /\.(js|jsx|ts|tsx)$/],
    [
      "prettier/bin/prettier.cjs",
      "--write",
      /\.(js|jsx|ts|tsx|json|md|yml|yaml)$/,
    ],
  ];
  for (const [tool, option, pattern] of tools) {
    for (const batch of batches(staged.filter((file) => pattern.test(file)))) {
      run(
        process.execPath,
        [
          path.resolve(__dirname, "../node_modules", tool),
          option,
          "--",
          ...batch,
        ],
        {
          stdio: "inherit",
        },
      );
    }
  }
  const stagedSet = new Set(staged);
  const changed = readPaths(["diff", "--name-only", "-z"]).filter((file) =>
    stagedSet.has(file),
  );
  for (const batch of batches(changed)) {
    run("git", ["add", "--", ...batch], { stdio: "inherit" });
  }
}

module.exports = { runStagedChecks };
if (require.main === module) {
  try {
    runStagedChecks();
  } catch (error) {
    console.error("Staged checks failed:", error.message);
    process.exitCode = 1;
  }
}
