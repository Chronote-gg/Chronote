import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const apiBaseUrl =
  process.env.VITE_DESKTOP_API_BASE_URL || "https://api.chronote.gg";
const portalBaseUrl =
  process.env.VITE_DESKTOP_PORTAL_BASE_URL || "https://chronote.gg";
const tauriCliPath = fileURLToPath(
  new URL("../node_modules/@tauri-apps/cli/tauri.js", import.meta.url),
);

console.log("Launching Chronote Desktop against production endpoints:");
console.log(`  API: ${apiBaseUrl}`);
console.log(`  Portal: ${portalBaseUrl}`);

const child = spawn(process.execPath, [tauriCliPath, "dev"], {
  env: {
    ...process.env,
    VITE_DESKTOP_API_BASE_URL: apiBaseUrl,
    VITE_DESKTOP_PORTAL_BASE_URL: portalBaseUrl,
  },
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`Chronote Desktop exited after signal ${signal}.`);
    process.exit(1);
  }
  process.exit(code ?? 0);
});

child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});
