const { spawnSync } = require("node:child_process");

if (process.platform !== "win32") {
  console.log(
    "Skipping desktop Rust check outside Windows; CI validates it on windows-latest.",
  );
  process.exit(0);
}

const result = spawnSync(
  "cargo",
  ["check", "--manifest-path", "apps/desktop/src-tauri/Cargo.toml"],
  {
    stdio: "inherit",
    shell: true,
  },
);

process.exit(result.status ?? 1);
