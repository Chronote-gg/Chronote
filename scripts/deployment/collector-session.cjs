"use strict";
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { executeChild } = require("./owned-child.cjs");
const { ExecuteCommandCommand } = require("@aws-sdk/client-ecs");
const { digest } = require("./collector-payload.cjs");
const { buildProbeRequests } = require("./maintenance-probe.cjs");
const { verifyCollectorRequest } = require("./collector-command.cjs");
const { checkDeadline } = require("./collector-principal.cjs");
const probeNames = [
  "meetingAcquire",
  "uploadClaim",
  "uploadRenew",
  "uploadProgress",
  "meetingRelease",
  "meetingRenew",
];
function decodeCollectorStream(bytes, request, sessionId) {
  assert.ok(Buffer.byteLength(bytes) <= 131072, "UNKNOWN: stream size");
  const text = new TextDecoder("utf-8", { fatal: true })
    .decode(Buffer.from(bytes))
    .replaceAll("\r\n", "\n");
  assert.ok(
    [...text].every(
      (c) => c === "\n" || (c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127),
    ),
    "UNKNOWN: PTY control",
  );
  const banner = `\nStarting session with SessionId: ${sessionId}\n`;
  assert.ok(text.startsWith(banner), "UNKNOWN: session banner");
  const lines = text.slice(banner.length).split("\n");
  assert.equal(lines.pop(), "", "UNKNOWN: truncated stream");
  assert.equal(lines.length, 10, "UNKNOWN: frame count");
  const records = lines.map((line, sequence) => {
    const row = JSON.parse(line);
    assert.equal(JSON.stringify(row), line, "UNKNOWN: noncanonical frame");
    assert.deepEqual(Object.keys(row).sort(), [
      "inputSha256",
      "nonce",
      "protocol",
      "sequence",
      "sourceSha256",
      "type",
      "value",
    ]);
    assert.equal(row.protocol, "chronote-collector-v1");
    assert.equal(row.sequence, sequence);
    for (const key of ["nonce", "inputSha256", "sourceSha256"])
      assert.equal(row[key], request[key], "UNKNOWN: frame binding");
    return row;
  });
  assert.equal(records[0].type, "start");
  if (request.taskArn) assert.equal(records[0].value.taskArn, request.taskArn);
  const terminal = records.at(-1);
  assert.equal(terminal.type, "terminal");
  assert.deepEqual(terminal.value, {
    status: "complete",
    count: 9,
    digest: digest(lines.slice(0, -1).join("\n") + "\n"),
  });
  const results = records.slice(1, -1);
  assert.ok(results.every((row) => row.type === "result"));
  assert.deepEqual(
    results.map((row) => row.value.kind),
    ["metadata", "identity", ...probeNames.map(() => "probe")],
  );
  assert.deepEqual(
    results.slice(2).map((row) => row.value.name),
    probeNames,
  );
  return results.map((row) => row.value);
}
function sessionArguments(m, native, session) {
  assert.match(session.sessionId, /^[A-Za-z0-9_-]{1,128}$/);
  assert.ok(
    typeof session.tokenValue === "string" &&
      session.tokenValue.length > 0 &&
      session.tokenValue.length <= 16384,
  );
  const url = new URL(session.streamUrl);
  assert.equal(url.protocol, "wss:");
  assert.equal(url.hostname, `ssmmessages.${m.binding.region}.amazonaws.com`);
  assert.ok(!url.username && !url.password && !url.port && !url.hash);
  assert.equal(url.pathname, `/v1/data-channel/${session.sessionId}`);
  assert.match(native.runtimeId, /^[a-f0-9-]{32,128}$/);
  const target = `ecs:${m.cluster}_${native.taskArn.split("/").at(-1)}_${native.runtimeId}`;
  return [
    "AWS_SSM_START_SESSION_RESPONSE_CHRONOTE",
    m.binding.region,
    "StartSession",
    "",
    JSON.stringify({ Target: target }),
    `https://ecs.${m.binding.region}.amazonaws.com`,
  ];
}
function pluginStream(
  args,
  session,
  launch = spawn,
  signal = AbortSignal.timeout(75000),
) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = launch("session-manager-plugin", args, {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        AWS_SSM_START_SESSION_RESPONSE_CHRONOTE: JSON.stringify(session),
      },
    });
    const chunks = [];
    let length = 0,
      failed = false;
    const fail = () => {
      if (failed) return;
      failed = true;
      child.kill("SIGKILL");
    };
    signal.addEventListener("abort", fail, { once: true });
    if (signal.aborted) fail();
    child.once("error", fail);
    child.stderr.on("data", fail);
    child.stdout.on("data", (bytes) => {
      length += bytes.length;
      if (length > 131072) fail();
      else chunks.push(Buffer.from(bytes));
    });
    child.once("close", (code) => {
      signal.removeEventListener("abort", fail);
      if (code !== 0 || failed)
        return reject(new Error("UNKNOWN: session transport; do not retry"));
      resolve(Buffer.concat(chunks));
    });
    // Keep stdin open: plugin EOF is not remote completion. Only close terminates this bounded capture.
  });
}
function validateSessionResults(m, request, records) {
  const identity = records[1],
    taskId = request.taskArn.split("/").at(-1);
  assert.equal(identity.accountId, m.binding.accountId);
  assert.equal(
    identity.arn,
    `arn:aws:sts::${m.binding.accountId}:assumed-role/${request.roleArn.split("/").at(-1)}/${taskId}`,
  );
  assert.match(identity.userId, new RegExp("^AROA[A-Z0-9]+:" + taskId + "$"));
  const probes = buildProbeRequests(m.binding);
  for (const result of records.slice(2)) {
    assert.equal(
      result.requestSha256,
      digest(JSON.stringify(probes[result.name])),
    );
    assert.ok(["iam_denied", "condition_refused"].includes(result.outcome));
  }
}
async function collectTaskSession({
  m,
  request,
  native,
  ecs,
  launch = spawn,
  version = executeChild,
  platform = process.platform,
}) {
  assert.equal(
    platform,
    "linux",
    "UNKNOWN: only Linux pipe transport is source-supported; Windows console transport unavailable",
  );
  const rendered = verifyCollectorRequest(m, request);
  const deadlineMs = Math.min(request.validUntil * 1000, Date.now() + 75000);
  assert.ok(
    Number.isFinite(deadlineMs) && deadlineMs > Date.now(),
    "UNKNOWN: invocation deadline",
  );
  const signal = AbortSignal.timeout(Math.ceil(deadlineMs - Date.now()));
  const installed = await version("session-manager-plugin", ["--version"], {
    timeout: Math.min(5000, Math.ceil(deadlineMs - Date.now())),
    signal,
    killSignal: "SIGKILL",
    maxBuffer: 1024,
    windowsHide: true,
  });
  assert.equal(installed.stdout.trim(), "1.2.835.0", "UNKNOWN: plugin version");
  assert.equal(await ecs.config.maxAttempts(), 1, "UNKNOWN: Exec retries");
  let response;
  try {
    checkDeadline(signal, deadlineMs);
    response = await ecs.send(
      new ExecuteCommandCommand({
        cluster: m.cluster,
        task: request.taskArn,
        container: m.containerName,
        command: rendered.command,
        interactive: true,
      }),
      { abortSignal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) },
    );
    assert.equal(response.taskArn, native.taskArn);
    assert.equal(response.containerArn, native.containerArn);
    assert.equal(response.containerName, m.containerName);
    assert.equal(
      response.clusterArn,
      `arn:aws:ecs:${m.binding.region}:${m.binding.accountId}:cluster/${m.cluster}`,
    );
    assert.equal(response.interactive, true);
    checkDeadline(signal, deadlineMs);
    const args = sessionArguments(m, native, response.session);
    const bytes = await pluginStream(args, response.session, launch, signal);
    const records = decodeCollectorStream(
      bytes,
      request,
      response.session.sessionId,
    );
    assert.deepEqual(records[0], {
      kind: "metadata",
      taskArn: native.taskArn,
      containerName: m.containerName,
      runtimeId: native.runtimeId,
      imageDigest: native.imageDigest,
    });
    validateSessionResults(m, request, records);
    return {
      outputBase64: bytes.toString("base64"),
      sessionId: response.session.sessionId,
      request,
      records,
      outputSha256: digest(bytes),
      outputBytes: bytes.length,
    };
  } catch {
    throw new Error("UNKNOWN: Exec/session acknowledgment; do not retry");
  }
}
module.exports = {
  decodeCollectorStream,
  collectTaskSession,
  sessionArguments,
  pluginStream,
};
