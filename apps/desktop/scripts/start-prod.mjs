import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import path from "node:path";

const apiBaseUrl =
  process.env.VITE_DESKTOP_API_BASE_URL || "https://api.chronote.gg";
const portalBaseUrl =
  process.env.VITE_DESKTOP_PORTAL_BASE_URL || "https://chronote.gg";
const env = {
  ...process.env,
  VITE_DESKTOP_API_BASE_URL: apiBaseUrl,
  VITE_DESKTOP_PORTAL_BASE_URL: portalBaseUrl,
};
const viteCliPath = path.join("node_modules", "vite", "bin", "vite.js");
const desktopExePath = path.join(
  process.cwd(),
  "src-tauri",
  "target",
  "debug",
  "chronote-desktop.exe",
);
const viteHost = "127.0.0.1";
const vitePort = 1420;

function run(command, args) {
  const result = spawnSync(command, args, {
    env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function waitForPort(host, port, timeoutMs = 15_000) {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const tryConnect = () => {
      const socket = net.connect(port, host);
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() - startedAt >= timeoutMs) {
          reject(new Error(`Timed out waiting for ${host}:${port}.`));
          return;
        }
        setTimeout(tryConnect, 250);
      });
    };

    tryConnect();
  });
}

console.log("Launching Chronote Desktop against production endpoints:");
console.log(`  API: ${apiBaseUrl}`);
console.log(`  Portal: ${portalBaseUrl}`);

run("cargo", [
  "build",
  "--manifest-path",
  "src-tauri/Cargo.toml",
  "--no-default-features",
]);

const vite = spawn(
  process.execPath,
  [viteCliPath, "--host", viteHost, "--port", String(vitePort)],
  {
    detached: true,
    env,
    stdio: "ignore",
  },
);
vite.unref();
await waitForPort(viteHost, vitePort);

const child = spawn(desktopExePath, {
  cwd: path.join(process.cwd(), "src-tauri"),
  detached: true,
  env,
  stdio: "ignore",
});
child.unref();

console.log(`Started Chronote Desktop PID ${child.pid}.`);
