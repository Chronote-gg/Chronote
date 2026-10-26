"use strict";
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const {
  checkDeadline,
  withinDeadline,
  readBody,
  boundedBody,
  parseIdentity,
  runProbe,
  collectPrincipal,
} = require("./collector-principal.cjs");
const { buildProbeRequests } = require("./maintenance-probe.cjs");
const { validateBinding } = require("./maintenance-fence.cjs");
function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
async function readTaskMetadata(input, signal, deadlineMs) {
  const uri = new URL(process.env.ECS_CONTAINER_METADATA_URI_V4);
  assert.equal(uri.protocol, "http:");
  assert.equal(uri.hostname, "169.254.170.2");
  assert.ok(
    !uri.port && !uri.username && !uri.password && !uri.search && !uri.hash,
  );
  assert.match(uri.pathname, /^\/v4\/[A-Za-z0-9-]+\/?$/);
  const rows = [];
  for (const suffix of ["", "/task"]) {
    checkDeadline(signal, deadlineMs);
    const response = await fetch(uri.href.replace(/\/$/, "") + suffix, {
      signal,
      redirect: "error",
    });
    assert.equal(response.status, 200);
    rows.push(JSON.parse(await boundedBody(response.body, 65536, signal)));
  }
  const [container, task] = rows;
  assert.equal(task.TaskARN, input.request.taskArn);
  assert.equal(container.Name, input.containerName);
  assert.equal(
    `${task.Family}:${task.Revision}`,
    input.request.taskDefinition.split("/").at(-1),
  );
  assert.match(container.DockerId, /^[a-f0-9-]{32,128}$/);
  assert.match(container.ImageID, /^sha256:[a-f0-9]{64}$/);
  const matches = task.Containers.filter((row) => row.Name === container.Name);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].DockerId, container.DockerId);
  assert.equal(matches[0].ImageID, container.ImageID);
  return {
    taskArn: task.TaskARN,
    containerName: container.Name,
    runtimeId: container.DockerId,
    imageDigest: container.ImageID,
  };
}
async function runPayload(input, provenance) {
  let signal;
  const deadlineMs = Math.min(
    input.request.validUntil * 1000,
    Date.now() + 60000,
  );
  const lines = [];
  const emit = (type, value) => {
    const record = {
      protocol: "chronote-collector-v1",
      nonce: input.request.nonce,
      inputSha256: provenance.inputSha256,
      sourceSha256: provenance.sourceSha256,
      sequence: lines.length,
      type,
      value,
    };
    const line = JSON.stringify(record);
    process.stdout.write(line + "\n");
    lines.push(line);
  };
  try {
    emit("start", { taskArn: input.request.taskArn });
    assert.ok(
      Number.isFinite(deadlineMs) && deadlineMs > Date.now(),
      "UNKNOWN: invocation deadline",
    );
    signal = AbortSignal.timeout(Math.ceil(deadlineMs - Date.now()));
    const metadata = await readTaskMetadata(input, signal, deadlineMs);
    emit("result", { kind: "metadata", ...metadata });
    const sdk = require("/app/node_modules/@aws-sdk/client-dynamodb");
    const version =
      require("/app/node_modules/@aws-sdk/client-dynamodb/package.json").version;
    const result = await collectPrincipal({
      sdk,
      version,
      region: input.binding.region,
      expected: {
        accountId: input.binding.accountId,
        roleArn: input.request.roleArn,
        taskArn: input.request.taskArn,
      },
      probes: buildProbeRequests(input.binding),
      signal,
      deadlineMs,
    });
    emit("result", { kind: "identity", ...result.identity });
    for (const [name, value] of Object.entries(result.results))
      emit("result", {
        kind: "probe",
        name,
        ...value,
        requestSha256: digest(
          JSON.stringify(buildProbeRequests(input.binding)[name]),
        ),
      });
    emit("terminal", {
      status: "complete",
      count: lines.length,
      digest: digest(lines.join("\n") + "\n"),
    });
  } catch {
    emit("terminal", {
      status: "UNKNOWN",
      count: lines.length,
      digest: digest(lines.join("\n") + "\n"),
    });
    process.exitCode = 1;
  }
}
function payloadSource() {
  return (
    '"use strict";const assert=require("node:assert/strict");const {createHash}=require("node:crypto");\n' +
    [
      digest,
      validateBinding,
      buildProbeRequests,
      checkDeadline,
      withinDeadline,
      readBody,
      boundedBody,
      parseIdentity,
      runProbe,
      collectPrincipal,
      readTaskMetadata,
      runPayload,
    ]
      .map(String)
      .join("\n")
  );
}
module.exports = { payloadSource, digest };
