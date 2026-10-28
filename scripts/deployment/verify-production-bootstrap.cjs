"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { join } = require("node:path");
const { S3Client } = require("@aws-sdk/client-s3");
const {
  STSClient,
  GetCallerIdentityCommand,
  AssumeRoleWithWebIdentityCommand,
} = require("@aws-sdk/client-sts");
const { boundedBody, checkDeadline } = require("./collector-principal.cjs");
const { nativeGitHub } = require("./terraform-native.cjs");
const { digest } = require("./collector-payload.cjs");
const { verifyAuthority } = require("./bootstrap-verification-authority.cjs");
const {
  verificationIdentity,
  verificationConfiguration,
  verificationPolicy,
  runStorageVerification,
} = require("./bootstrap-verification.cjs");
async function main(mode, env = process.env) {
  assert.equal(mode, "run");
  assert.ok(
    !Object.entries(env).some(
      ([key, value]) => key.startsWith("AWS_ENDPOINT_URL") && value,
    ),
  );
  assert.ok(
    !Object.entries(env).some(
      ([key, value]) =>
        value &&
        /^(AWS_(ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN|PROFILE|DEFAULT_PROFILE|SHARED_CREDENTIALS_FILE|CONFIG_FILE|WEB_IDENTITY_TOKEN_FILE|ROLE_ARN)|AWS_CONTAINER_CREDENTIALS_.*)$/.test(
          key,
        ),
    ),
    "ambient credentials refused",
  );
  const bindingText = env.BOOTSTRAP_VERIFICATION_STORAGE_JSON;
  assert.equal(digest(bindingText), env.VERIFICATION_STORAGE_SHA256);
  const configuration = verificationConfiguration(bindingText),
    binding = configuration.binding,
    now = () => Math.floor(Date.now() / 1000);
  const identity = verificationIdentity(env, binding, now());
  const deadline = Math.min(
    Date.parse(env.VERIFICATION_DEADLINE),
    Date.now() + 900000,
  );
  const signal = AbortSignal.timeout(deadline - Date.now());
  const check = () => checkDeadline(signal, deadline);
  const get = nativeGitHub(env.GH_TOKEN, (url, options) => {
    check();
    return fetch(url, {
      ...options,
      signal: AbortSignal.any([signal, options.signal]),
    });
  });
  const authority = () =>
    verifyAuthority(get, identity, configuration.environmentId);
  const proof = await authority();
  const directory = join(env.RUNNER_TEMP, "bootstrap-verification");
  const policy = verificationPolicy(binding, identity);
  const intent = {
    proof,
    identity,
    storageSha256: digest(bindingText),
    policySha256: digest(policy),
    deadline,
  };
  fs.mkdirSync(directory, { mode: 0o700 });
  fs.writeFileSync(join(directory, "authority.json"), JSON.stringify(intent), {
    flag: "wx",
    mode: 0o600,
  });
  check();
  fs.writeFileSync(join(directory, "attempt.json"), JSON.stringify(intent), {
    flag: "wx",
    mode: 0o600,
  });
  const receipts = [];
  const record = async (operation, input, request) => {
    check();
    const receipt = {
      index: receipts.length,
      operation,
      requestSha256: digest(JSON.stringify(input)),
      outcome: "started",
    };
    fs.appendFileSync(
      join(directory, "receipts.jsonl"),
      JSON.stringify(receipt) + "\n",
      { mode: 0o600 },
    );
    try {
      check();
      const response = await request();
      check();
      assert.equal(
        response.$metadata?.httpStatusCode,
        200,
        "unknown API receipt",
      );
      if (operation !== "GitHubOidcToken")
        assert.ok(
          typeof response.$metadata.requestId === "string" &&
            response.$metadata.requestId.length > 0,
          "unknown API request ID",
        );
      Object.assign(receipt, {
        outcome: "received",
        status: response.$metadata?.httpStatusCode ?? null,
        requestId: response.$metadata?.requestId ?? null,
      });
      return response;
    } catch (error) {
      Object.assign(receipt, {
        outcome: "failed",
        status: error.$metadata?.httpStatusCode ?? null,
        requestId: error.$metadata?.requestId ?? null,
        name: error.name,
      });
      throw error;
    } finally {
      receipts.push(receipt);
      fs.appendFileSync(
        join(directory, "receipts.jsonl"),
        JSON.stringify(receipt) + "\n",
        { mode: 0o600 },
      );
    }
  };
  const send = (client, command, options = {}) =>
    record(
      command.constructor.name,
      {
        ...command.input,
        WebIdentityToken: undefined,
      },
      () =>
        client.send(command, {
          ...options,
          abortSignal: options.abortSignal
            ? AbortSignal.any([signal, options.abortSignal])
            : signal,
        }),
    );
  const oidcUrl = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
  assert.equal(oidcUrl.protocol, "https:");
  assert.match(
    oidcUrl.hostname,
    /^[a-z0-9-]+\.actions\.githubusercontent\.com$/,
  );
  assert.equal(
    oidcUrl.port + oidcUrl.username + oidcUrl.password + oidcUrl.hash,
    "",
  );
  assert.ok(
    typeof env.ACTIONS_ID_TOKEN_REQUEST_TOKEN === "string" &&
      env.ACTIONS_ID_TOKEN_REQUEST_TOKEN.length > 0,
  );
  oidcUrl.searchParams.set("audience", "sts.amazonaws.com");
  let token;
  await record("GitHubOidcToken", { url: oidcUrl.href }, async () => {
    const response = await fetch(oidcUrl, {
      headers: {
        Authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}`,
      },
      redirect: "error",
      signal,
    });
    assert.equal(response.status, 200);
    token = JSON.parse(await boundedBody(response.body, 65536, signal)).value;
    assert.ok(typeof token === "string");
    assert.match(token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    return {
      $metadata: {
        httpStatusCode: 200,
        requestId: response.headers.get("x-github-request-id"),
      },
    };
  });
  const stsConfig = {
    region: binding.region,
    endpoint: `https://sts.${binding.region}.amazonaws.com`,
    maxAttempts: 1,
  };
  const unsigned = new STSClient({
    ...stsConfig,
    credentials: async () => {
      throw new Error("ambient credentials refused");
    },
  });
  const session = await send(
    unsigned,
    new AssumeRoleWithWebIdentityCommand({
      RoleArn: `arn:aws:iam::${binding.accountId}:role/meeting-notes-prod-github-terraform`,
      RoleSessionName: `bootstrap-verify-${identity.runId}-1`,
      DurationSeconds: 900,
      Policy: policy,
      WebIdentityToken: token,
    }),
  );
  token = undefined;
  const c = session.Credentials;
  assert.ok(c && c.AccessKeyId && c.SecretAccessKey && c.SessionToken);
  assert.ok(
    c.Expiration instanceof Date && c.Expiration.getTime() > Date.now(),
  );
  const credentials = {
    accessKeyId: c.AccessKeyId,
    secretAccessKey: c.SecretAccessKey,
    sessionToken: c.SessionToken,
    expiration: c.Expiration,
  };
  const sts = new STSClient({ ...stsConfig, credentials });
  const caller = await send(sts, new GetCallerIdentityCommand({}), {
    abortSignal: signal,
  });
  assert.equal(caller.Account, binding.accountId);
  assert.equal(
    caller.Arn,
    `arn:aws:sts::${binding.accountId}:assumed-role/meeting-notes-prod-github-terraform/bootstrap-verify-${identity.runId}-1`,
  );
  const native = new S3Client({
    region: binding.region,
    endpoint: `https://s3.${binding.region}.amazonaws.com`,
    maxAttempts: 1,
    credentials,
  });
  const client = {
    config: native.config,
    send: (command, options) => send(native, command, options),
  };
  const result = await runStorageVerification({
    binding,
    identity,
    client,
    now,
    authority,
    signal,
    caller: { Account: caller.Account, Arn: caller.Arn },
    receipts,
  });
  fs.writeFileSync(join(directory, "result.json"), JSON.stringify(result), {
    flag: "wx",
    mode: 0o600,
  });
  process.stdout.write(
    JSON.stringify({
      outcome: result.outcome,
      reportSha256: result.reportReference.sha256,
      payloadSha256: result.reference.sha256,
    }) + "\n",
  );
}
if (require.main === module)
  (process.argv.length === 3
    ? main(process.argv[2])
    : Promise.reject(new Error("Invalid arguments"))
  ).catch(() => {
    process.stderr.write(
      "UNKNOWN: bootstrap verification incomplete; preserve private evidence, do not rerun or clean up.\n",
    );
    process.exitCode = 1;
  });
module.exports = { main };
