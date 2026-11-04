const { spawnSync } = require("node:child_process");

// The desktop Rust tests only run on a Windows host, so a non-Windows run has
// to choose between two very different things. Locally, skipping is a
// convenience for a working copy that cannot run them. In a CI job it is a
// silent loss of the only desktop test coverage there is: the job still reports
// green while testing nothing, which is the defect the `cargo test` below was
// made to fix. Refuse in that case instead of exiting 0.
//
// Keyed on GITHUB_ACTIONS rather than CI on purpose. CI is set by devcontainers
// and agent sandboxes that legitimately run `yarn check:ci` on Linux, and those
// should keep skipping; GITHUB_ACTIONS marks the runner where a skip would
// actually hide a missing gate.
function decideDesktopCheck(platform, env) {
  if (platform === "win32") {
    return "run";
  }
  return env.GITHUB_ACTIONS ? "refuse" : "skip";
}

function exitCodeForDecision(decision) {
  return decision === "refuse" ? 1 : 0;
}

module.exports = { decideDesktopCheck, exitCodeForDecision };

if (require.main === module) {
  const decision = decideDesktopCheck(process.platform, process.env);

  if (decision !== "run") {
    const message =
      decision === "refuse"
        ? `Desktop Rust tests cannot run on ${process.platform}. This job needs a Windows runner; skipping here would report success without testing the desktop app.`
        : "Skipping desktop Rust tests outside Windows; CI validates them on a Windows runner.";
    const code = exitCodeForDecision(decision);
    if (code === 0) {
      console.log(message);
    } else {
      console.error(message);
    }
    process.exit(code);
  }

  // `cargo test` rather than `cargo check`: it covers everything the check did and
  // also compiles the test target, which a check silently skips. Without it the
  // desktop tests never run anywhere in CI, and a test left referencing a deleted
  // function still passes every gate.
  const result = spawnSync(
    "cargo",
    ["test", "--manifest-path", "apps/desktop/src-tauri/Cargo.toml"],
    {
      stdio: "inherit",
      shell: true,
    },
  );

  process.exit(result.status ?? 1);
}
