"use strict";
const assert = require("node:assert/strict");
function checkDeadline(signal, deadlineMs) {
  signal.throwIfAborted();
  assert.ok(Date.now() < deadlineMs, "UNKNOWN: invocation deadline");
}
async function withinDeadline(promise, signal) {
  signal.throwIfAborted();
  let onAbort;
  const expired = new Promise((resolve, reject) => {
    onAbort = () => reject(new Error("UNKNOWN: invocation deadline"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, expired]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
async function boundedBody(body, maxBytes, signal) {
  return withinDeadline(readBody(body, maxBytes, signal), signal);
}
async function readBody(body, maxBytes, signal) {
  const chunks = [];
  let length = 0;
  for await (const chunk of body) {
    signal.throwIfAborted();
    const bytes = Buffer.from(chunk);
    length += bytes.length;
    assert.ok(length <= maxBytes, "UNKNOWN: response size");
    chunks.push(bytes);
  }
  signal.throwIfAborted();
  return new TextDecoder("utf-8", { fatal: true }).decode(
    Buffer.concat(chunks),
  );
}
function parseIdentity(xml, expected) {
  assert.ok(Buffer.byteLength(xml) <= 16384, "UNKNOWN: identity size");
  assert.ok(
    !xml.includes("&") &&
      [...xml].every((c) => c.charCodeAt(0) >= 32 || "\t\r\n".includes(c)),
  );
  const envelope =
    /^(?:<\?xml version="1\.0" encoding="UTF-8"\?>\s*)?<GetCallerIdentityResponse xmlns="https:\/\/sts\.amazonaws\.com\/doc\/2011-06-15\/">\s*<GetCallerIdentityResult>([\s\S]*?)<\/GetCallerIdentityResult>\s*<ResponseMetadata>\s*<RequestId>([a-f0-9-]{36})<\/RequestId>\s*<\/ResponseMetadata>\s*<\/GetCallerIdentityResponse>\s*$/.exec(
      xml,
    );
  assert.ok(envelope, "UNKNOWN: identity envelope");
  const values = {};
  const content = envelope[1].replace(
    /\s*<(Arn|UserId|Account)>([^<>]+)<\/\1>\s*/g,
    (_, key, value) => {
      assert.ok(!Object.hasOwn(values, key), "UNKNOWN: duplicate identity");
      values[key] = value;
      return "";
    },
  );
  assert.equal(content, "");
  assert.deepEqual(Object.keys(values).sort(), ["Account", "Arn", "UserId"]);
  assert.equal(values.Account, expected.accountId);
  const session = expected.taskArn.split("/").at(-1);
  const role = expected.roleArn.split("/").at(-1);
  assert.equal(
    values.Arn,
    `arn:aws:sts::${expected.accountId}:assumed-role/${role}/${session}`,
  );
  assert.match(values.UserId, new RegExp("^AROA[A-Z0-9]+:" + session + "$"));
  return {
    accountId: values.Account,
    arn: values.Arn,
    userId: values.UserId,
    requestId: envelope[2],
  };
}
async function runProbe(client, sdk, probe, signal, deadlineMs) {
  checkDeadline(signal, deadlineMs);
  let errorName,
    requestId = null;
  try {
    await withinDeadline(
      client.send(new sdk[probe.action + "Command"](probe.request), {
        abortSignal: signal,
      }),
      signal,
    );
  } catch (error) {
    errorName = error.name;
    if (/^[A-Za-z0-9-]{1,128}$/.test(error.$metadata?.requestId ?? ""))
      requestId = error.$metadata.requestId;
  }
  checkDeadline(signal, deadlineMs);
  assert.ok(
    ["AccessDeniedException", "ConditionalCheckFailedException"].includes(
      errorName,
    ),
    "UNKNOWN: probe acknowledgment",
  );
  return {
    outcome:
      errorName === "AccessDeniedException"
        ? "iam_denied"
        : "condition_refused",
    requestId,
  };
}
async function collectPrincipal({
  sdk,
  version,
  region,
  expected,
  probes,
  signal,
  credentials,
  requestHandler,
  signingDate,
  deadlineMs = Date.now() + 60000,
}) {
  assert.equal(version, "3.1149.0", "UNKNOWN: SDK version");
  const options = {
    region,
    maxAttempts: 1,
    endpoint: `https://dynamodb.${region}.amazonaws.com`,
    ...(requestHandler ? { requestHandler } : {}),
    ...(credentials ? { credentials } : {}),
  };
  const resolver = new sdk.DynamoDBClient(options);
  let client;
  try {
    checkDeadline(signal, deadlineMs);
    const resolved = await withinDeadline(
      resolver.config.credentials(),
      signal,
    );
    checkDeadline(signal, deadlineMs);
    const snapshot = {
      accessKeyId: resolved.accessKeyId,
      secretAccessKey: resolved.secretAccessKey,
      ...(resolved.sessionToken ? { sessionToken: resolved.sessionToken } : {}),
    };
    assert.ok(
      snapshot.accessKeyId && snapshot.secretAccessKey && snapshot.sessionToken,
      "UNKNOWN: task credentials",
    );
    if (resolved.expiration)
      assert.ok(
        resolved.expiration.getTime() > Date.now() + 60000,
        "UNKNOWN: credential expiry",
      );
    client = new sdk.DynamoDBClient({ ...options, credentials: snapshot });
    const host = `sts.${region}.amazonaws.com`;
    const body = "Action=GetCallerIdentity&Version=2011-06-15";
    const signer = await withinDeadline(client.config.signer(), signal);
    const signed = await signer.sign(
      {
        protocol: "https:",
        hostname: host,
        method: "POST",
        path: "/",
        query: {},
        headers: {
          host,
          "content-type": "application/x-www-form-urlencoded",
          "content-length": String(Buffer.byteLength(body)),
        },
        body,
      },
      {
        signingService: "sts",
        signingRegion: region,
        ...(signingDate ? { signingDate } : {}),
      },
    );
    checkDeadline(signal, deadlineMs);
    const { response } = await withinDeadline(
      client.config.requestHandler.handle(signed, { abortSignal: signal }),
      signal,
    );
    assert.equal(response.statusCode, 200, "UNKNOWN: identity status");
    const identity = parseIdentity(
      await boundedBody(response.body, 16384, signal),
      expected,
    );
    const results = {};
    for (const [name, probe] of Object.entries(probes))
      results[name] = await runProbe(client, sdk, probe, signal, deadlineMs);
    return { identity, results };
  } finally {
    client?.destroy();
    resolver.destroy();
  }
}
module.exports = {
  checkDeadline,
  withinDeadline,
  readBody,
  boundedBody,
  parseIdentity,
  runProbe,
  collectPrincipal,
};
