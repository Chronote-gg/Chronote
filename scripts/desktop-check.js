const { spawnSync } = require("node:child_process");

if (process.platform !== "win32") {
  console.log(
    "Skipping desktop Rust tests outside Windows; CI validates them on windows-latest.",
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
