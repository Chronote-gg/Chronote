import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const repoRoot = process.cwd();
const isWindows = process.platform === "win32";
const appBinaryPath = path.join(
  repoRoot,
  "apps",
  "desktop",
  "src-tauri",
  "target",
  "debug",
  isWindows ? "chronote-desktop.exe" : "chronote-desktop",
);
const accessToken = "chronote-desktop-smoke-access-token";
const uploadId = "00000000-0000-4000-8000-000000000249";
const meetingGuildId = "personal:desktop-smoke-user";
const channelIdTimestamp = "personal#2026-06-08T12:00:00.000Z";

function run(command, args, options = {}) {
  const result = spawnSync(
    isWindows ? [command, ...args].join(" ") : command,
    isWindows ? [] : args,
    {
      cwd: repoRoot,
      env: options.env ?? process.env,
      shell: isWindows,
      stdio: "inherit",
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with ${result.status}`,
    );
  }
}

function killProcessTree(child) {
  if (!child.pid) return;
  if (isWindows) {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
    });
    return;
  }
  child.kill();
}

function buildSmokePath(env) {
  const cargoBin = env.USERPROFILE
    ? path.join(env.USERPROFILE, ".cargo", "bin")
    : env.HOME
      ? path.join(env.HOME, ".cargo", "bin")
      : undefined;
  return [env.CHRONOTE_DESKTOP_WEBDRIVER_DIR, repoRoot, cargoBin, env.PATH]
    .filter(Boolean)
    .join(path.delimiter);
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function sendJson(response, status, body) {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  response.end(text);
}

function createMockApi() {
  const uploads = new Map();
  let statusChecks = 0;
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "POST" && url.pathname.startsWith("/mock-upload/")) {
      const sourceId = decodeURIComponent(url.pathname.split("/").pop() ?? "");
      uploads.set(sourceId, await readRequestBody(request));
      response.writeHead(204);
      response.end();
      return;
    }

    const expectedAuth = `Bearer ${accessToken}`;
    if (
      url.pathname.startsWith("/api/desktop/") &&
      request.headers.authorization !== expectedAuth
    ) {
      sendJson(response, 401, { error: "unauthorized" });
      return;
    }

    if (
      request.method === "POST" &&
      url.pathname === "/api/desktop/recordings/intent"
    ) {
      const baseUrl = `http://127.0.0.1:${server.address().port}`;
      const body = JSON.parse(
        (await readRequestBody(request)).toString("utf8"),
      );
      sendJson(response, 200, {
        uploadId,
        sources: body.sources.map((source) => ({
          sourceId: source.sourceId,
          sourceS3Key: `desktop-smoke/${source.sourceId}.wav`,
          contentType: "audio/wav",
          uploadToken: `token-${source.sourceId}`,
          upload: {
            url: `${baseUrl}/mock-upload/${encodeURIComponent(source.sourceId)}`,
            fields: {},
          },
        })),
      });
      return;
    }

    if (
      request.method === "POST" &&
      url.pathname === "/api/desktop/recordings/complete"
    ) {
      await readRequestBody(request);
      if (!uploads.has("owner_mic") || !uploads.has("system_output")) {
        sendJson(response, 400, { error: "missing_uploads" });
        return;
      }
      sendJson(response, 200, {
        job: {
          uploadId,
          status: "queued",
          errorMessage: null,
          meetingGuildId: null,
          channelIdTimestamp: null,
        },
      });
      return;
    }

    if (
      request.method === "GET" &&
      url.pathname === `/api/desktop/recordings/${uploadId}`
    ) {
      statusChecks += 1;
      sendJson(response, 200, {
        job: {
          uploadId,
          status: statusChecks >= 2 ? "complete" : "processing",
          errorMessage: null,
          meetingGuildId,
          channelIdTimestamp,
        },
      });
      return;
    }

    if (
      request.method === "POST" &&
      url.pathname === "/api/desktop/auth/revoke"
    ) {
      await readRequestBody(request);
      sendJson(response, 200, { ok: true });
      return;
    }

    sendJson(response, 404, { error: "not_found" });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function webdriverRequest(sessionId, method, route, body) {
  const response = await fetch(
    `http://127.0.0.1:4444${route.replace(":sessionId", sessionId ?? "")}`,
    {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    },
  );
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(
      parsed.value?.message ?? text ?? `WebDriver HTTP ${response.status}`,
    );
  }
  return parsed.value;
}

async function startSession(application) {
  const value = await webdriverRequest(null, "POST", "/session", {
    capabilities: {
      alwaysMatch: {
        browserName: "wry",
        "tauri:options": { application },
      },
    },
  });
  return value.sessionId;
}

async function waitForWebDriver(tauriDriver, timeoutMs = 10_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (tauriDriver.exitCode !== null) {
      throw new Error(`tauri-driver exited with code ${tauriDriver.exitCode}`);
    }
    try {
      const response = await fetch("http://127.0.0.1:4444/status");
      if (response.ok) return;
    } catch {
      // Keep polling until tauri-driver binds the WebDriver port.
    }
    await delay(250);
  }
  throw new Error("Timed out waiting for tauri-driver on 127.0.0.1:4444.");
}

async function execute(sessionId, script, args = []) {
  return webdriverRequest(
    sessionId,
    "POST",
    `/session/:sessionId/execute/sync`,
    {
      script,
      args,
    },
  );
}

async function waitFor(sessionId, description, predicate, timeoutMs = 20_000) {
  const startedAt = Date.now();
  let lastValue;
  while (Date.now() - startedAt < timeoutMs) {
    lastValue = await execute(sessionId, "return document.body.innerText;");
    if (predicate(String(lastValue))) return lastValue;
    await delay(250);
  }
  throw new Error(
    `Timed out waiting for ${description}. Last body text: ${lastValue}`,
  );
}

async function clickByText(sessionId, text) {
  await execute(
    sessionId,
    `const text = arguments[0];
const elements = [...document.querySelectorAll('button, a')];
const match = elements.find((element) => element.textContent.trim() === text);
if (!match) throw new Error('No clickable element with text: ' + text);
match.click();`,
    [text],
  );
}

async function runSmoke(application, env) {
  const tauriDriver = spawn("tauri-driver", [], {
    cwd: repoRoot,
    env: {
      ...env,
      PATH: buildSmokePath(env),
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  let spawnError;
  const spawnErrorReady = new Promise((resolve) => {
    tauriDriver.once("error", (error) => {
      spawnError = error;
      resolve();
    });
  });
  await Promise.race([
    waitForWebDriver(tauriDriver),
    spawnErrorReady.then(() => {
      throw spawnError;
    }),
  ]);

  let sessionId;
  try {
    sessionId = await startSession(application);
    await waitFor(sessionId, "preseeded desktop session", (text) =>
      text.includes("Signed in as Desktop Smoke Tester"),
    );
    await clickByText(sessionId, "Record");
    await waitFor(sessionId, "recording state", (text) =>
      text.includes("Recording started."),
    );
    await delay(500);
    await clickByText(sessionId, "Stop and upload");
    await waitFor(sessionId, "upload completion", (text) =>
      text.includes("Upload received."),
    );
    await waitFor(
      sessionId,
      "created meeting link",
      (text) => text.includes("Open created meeting"),
      30_000,
    );
    const meetingHref = await execute(
      sessionId,
      "return document.querySelector('a.meeting-link')?.href ?? '';",
    );
    if (!String(meetingHref).includes(encodeURIComponent(channelIdTimestamp))) {
      throw new Error(
        `Created meeting link was not populated correctly: ${meetingHref}`,
      );
    }
  } finally {
    if (sessionId) {
      await webdriverRequest(sessionId, "DELETE", `/session/:sessionId`).catch(
        () => undefined,
      );
    }
    killProcessTree(tauriDriver);
  }
}

const api = await createMockApi();
const apiBaseUrl = `http://127.0.0.1:${api.address().port}`;
const smokeEnv = {
  ...process.env,
  VITE_DESKTOP_API_BASE_URL: apiBaseUrl,
  VITE_DESKTOP_PORTAL_BASE_URL: "https://chronote.localhost",
  CHRONOTE_DESKTOP_TEST_SESSION: "1",
  CHRONOTE_DESKTOP_TEST_API_BASE_URL: apiBaseUrl,
  CHRONOTE_DESKTOP_TEST_ACCESS_TOKEN: accessToken,
  CHRONOTE_DESKTOP_TEST_USER_ID: "desktop-smoke-user",
  CHRONOTE_DESKTOP_TEST_USERNAME: "Desktop Smoke Tester",
};

try {
  if (process.env.DESKTOP_SMOKE_SKIP_BUILD !== "1") {
    run("yarn", ["--cwd", "apps/desktop", "build:smoke"], { env: smokeEnv });
  }
  await runSmoke(appBinaryPath, smokeEnv);
  console.log("Native desktop smoke test passed.");
} finally {
  await new Promise((resolve) => api.close(resolve));
}
