const { spawnSync } = require("node:child_process");

// The desktop Rust tests only run on a Windows host, so a non-Windows run has
// to choose between two very different things. Locally, skipping is a
// convenience for a working copy that cannot run them. In CI it is a silent
// loss of the only desktop test coverage there is: the job still reports green
// while testing nothing, which is the defect the `cargo test` change below was
// made to fix. Refuse in that case instead of exiting 0.
function decideDesktopCheck(platform, env) {
  if (platform === "win32") {
    return "run";
  }
  return env.CI ? "refuse" : "skip";
}

module.exports = { decideDesktopCheck };

if (require.main === module) {
  const decision = decideDesktopCheck(process.platform, process.env);

  if (decision === "refuse") {
    console.error(
      `Desktop Rust tests cannot run on ${process.platform}. This job needs a Windows runner; skipping here would report success without testing the desktop app.`,
    );
    process.exit(1);
  }

  if (decision === "skip") {
    console.log(
      "Skipping desktop Rust tests outside Windows; CI validates them on a Windows runner.",
    );
    process.exit(0);
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
