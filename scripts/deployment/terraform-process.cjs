"use strict";
const { spawn } = require("node:child_process");
const { openSync, closeSync, readFileSync, statSync } = require("node:fs");
const { join } = require("node:path");
const assert = require("node:assert/strict");
async function runPrivateCommand(
  file,
  args,
  { directory, index, cwd, env, signal },
) {
  signal.throwIfAborted();
  const stdoutPath = join(directory, `${index}.stdout`),
    stderrPath = join(directory, `${index}.stderr`);
  const stdout = openSync(stdoutPath, "wx", 0o600),
    stderr = openSync(stderrPath, "wx", 0o600);
  let result;
  try {
    result = await new Promise((resolve) => {
      let failed = false;
      const child = spawn(file, args, {
        cwd,
        env,
        stdio: ["ignore", stdout, stderr],
        windowsHide: true,
      });
      const abort = () => child.kill("SIGKILL");
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      child.once("error", () => {
        failed = true;
      });
      child.once("close", (exitCode, exitSignal) => {
        signal.removeEventListener("abort", abort);
        resolve({
          exitCode,
          exitSignal,
          outcome:
            failed || signal.aborted || exitCode === null
              ? "unknown"
              : "exited",
        });
      });
    });
  } finally {
    closeSync(stdout);
    closeSync(stderr);
  }
  // Keep the complete local files if the bounded durable format cannot hold them.
  assert.ok(
    statSync(stdoutPath).size + statSync(stderrPath).size <= 24000000,
    "UNKNOWN: command output exceeds private capture bound",
  );
  return {
    command: file,
    args,
    ...result,
    stdout: readFileSync(stdoutPath).toString("base64"),
    stderr: readFileSync(stderrPath).toString("base64"),
  };
}
module.exports = { runPrivateCommand };
