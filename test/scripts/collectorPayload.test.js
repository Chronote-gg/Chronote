/** @jest-environment node */
import { Buffer } from "node:buffer";
import { test, expect, jest } from "@jest/globals";
import { runInNewContext } from "node:vm";
import { createRequire } from "node:module";
import process from "node:process";
import { Readable } from "node:stream";
import { STSClient } from "@aws-sdk/client-sts";
import { manifestFixture } from "../fixtures/deployment/productionIntroduction.js";
import { renderCollector } from "../../scripts/deployment/collector-command.cjs";
import { collectPrincipal } from "../../scripts/deployment/collector-principal.cjs";
import * as sdk from "@aws-sdk/client-dynamodb";
import { buildProbeRequests } from "../../scripts/deployment/maintenance-probe.cjs";
const nodeRequire = createRequire(process.cwd() + "/package.json");
test("the exact rendered loader rejects changed source or input bytes before payload execution", async () => {
  const m = manifestFixture(),
    rendered = renderCollector(m, {
      nonce: "nonce",
      validUntil: Date.now() / 1000 + 60,
      taskArn: m.legacyTaskArn,
    });
  for (const field of ["sourceSha256", "inputSha256"]) {
    const command = rendered.command.replace(
      rendered.request[field],
      "0".repeat(64),
    );
    expect(() =>
      runInNewContext(command.slice("/usr/local/bin/node -e '".length, -1), {
        require: nodeRequire,
        Buffer,
      }),
    ).toThrow("UNKNOWN");
  }
});
test("exact rendered loader emits only sanitized UNKNOWN when metadata is unavailable", async () => {
  const m = manifestFixture(),
    rendered = renderCollector(m, {
      nonce: "nonce",
      validUntil: Date.now() / 1000 + 60,
      taskArn: m.legacyTaskArn,
    });
  const output = [],
    fakeProcess = {
      env: {},
      stdout: { write: (s) => output.push(s) },
      exitCode: 0,
    };
  await runInNewContext(
    rendered.command.slice("/usr/local/bin/node -e '".length, -1),
    {
      require: nodeRequire,
      Buffer,
      AbortSignal,
      URL,
      TextDecoder,
      process: fakeProcess,
    },
  );
  expect(fakeProcess.exitCode).toBe(1);
  expect(output).toHaveLength(2);
  expect(JSON.parse(output[1]).value.status).toBe("UNKNOWN");
  expect(output.join("")).not.toMatch(/TypeError|metadata|stack/);
});
test("fixed-date structural STS signing equals the installed STS signer on the exact canonical request", async () => {
  const m = manifestFixture(),
    credentials = {
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "synthetic-secret",
      sessionToken: "synthetic-token",
    };
  const signingDate = new Date("2026-10-22T00:00:00Z"),
    expected = {
      accountId: m.binding.accountId,
      roleArn: m.binding.taskRoleArn,
      taskArn: m.legacyTaskArn,
    };
  const requests = [],
    handler = {
      destroy() {},
      handle: async (r) => {
        requests.push(r);
        throw new Error("offline refusal");
      },
    };
  await expect(
    collectPrincipal({
      sdk,
      version: "3.1149.0",
      region: m.binding.region,
      expected,
      probes: buildProbeRequests(m.binding),
      signal: AbortSignal.timeout(5000),
      credentials,
      requestHandler: handler,
      signingDate,
    }),
  ).rejects.toThrow();
  const sts = new STSClient({
    region: m.binding.region,
    credentials,
    maxAttempts: 1,
    requestHandler: handler,
  });
  const original = requests[0],
    headers = { ...original.headers };
  for (const key of [
    "authorization",
    "x-amz-date",
    "x-amz-security-token",
    "x-amz-content-sha256",
  ])
    delete headers[key];
  const signed = await (
    await sts.config.signer()
  ).sign(
    { ...original, headers },
    { signingDate, signingService: "sts", signingRegion: m.binding.region },
  );
  expect(signed.headers.authorization).toBe(original.headers.authorization);
  expect(requests).toHaveLength(1);
  sts.destroy();
});
test("a blocked STS response body is bounded by the invocation deadline", async () => {
  const m = manifestFixture(),
    handler = {
      destroy() {},
      handle: async () => ({
        response: {
          statusCode: 200,
          headers: {},
          body: new Readable({ read() {} }),
        },
      }),
    };
  const pending = collectPrincipal({
    sdk,
    version: "3.1149.0",
    region: m.binding.region,
    expected: {},
    probes: buildProbeRequests(m.binding),
    signal: AbortSignal.timeout(20),
    credentials: {
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "synthetic",
      sessionToken: "fake",
    },
    requestHandler: handler,
  });
  await expect(pending).rejects.toThrow();
}, 1000);

test("the actual embedded payload executes the six fixed commands with fake metadata and HTTP transport", async () => {
  const m = manifestFixture(),
    taskId = m.legacyTaskArn.split("/").at(-1),
    output = [];
  const identity =
    '<GetCallerIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><GetCallerIdentityResult><Account>' +
    m.binding.accountId +
    "</Account><Arn>arn:aws:sts::" +
    m.binding.accountId +
    ":assumed-role/chronote-app/" +
    taskId +
    "</Arn><UserId>AROAEXAMPLE:" +
    taskId +
    "</UserId></GetCallerIdentityResult><ResponseMetadata><RequestId>11111111-1111-4111-8111-111111111111</RequestId></ResponseMetadata></GetCallerIdentityResponse>";
  const requests = [],
    handler = {
      destroy() {},
      handle: async (r) => {
        requests.push(r);
        const sts = r.hostname.startsWith("sts.");
        return {
          response: {
            statusCode: sts ? 200 : 400,
            headers: { "content-type": "application/x-amz-json-1.0" },
            body: Readable.from([
              sts ? identity : '{"__type":"ConditionalCheckFailedException"}',
            ]),
          },
        };
      },
    };
  class OfflineClient extends sdk.DynamoDBClient {
    constructor(options) {
      super({
        ...options,
        credentials: options.credentials ?? {
          accessKeyId: "AKIDEXAMPLE",
          secretAccessKey: "synthetic",
          sessionToken: "fake",
        },
        requestHandler: handler,
      });
    }
  }
  const container = {
    Name: m.containerName,
    DockerId: "a".repeat(32),
    ImageID: "sha256:" + "c".repeat(64),
  };
  const task = {
    TaskARN: m.legacyTaskArn,
    Family: "chronote-bot",
    Revision: "1",
    Containers: [container],
  };
  const rendered = renderCollector(m, {
    nonce: "nonce",
    validUntil: Date.now() / 1000 + 60,
    taskArn: m.legacyTaskArn,
    taskDefinition: m.legacyTaskDefinition,
    roleArn: m.binding.taskRoleArn,
  });
  const fakeRequire = (name) =>
    name === "/app/node_modules/@aws-sdk/client-dynamodb"
      ? { ...sdk, DynamoDBClient: OfflineClient }
      : name === "/app/node_modules/@aws-sdk/client-dynamodb/package.json"
        ? { version: "3.1149.0" }
        : nodeRequire(name);
  await runInNewContext(
    rendered.command.slice("/usr/local/bin/node -e '".length, -1),
    {
      require: fakeRequire,
      Buffer,
      AbortSignal,
      URL,
      TextDecoder,
      process: {
        env: {
          ECS_CONTAINER_METADATA_URI_V4: "http://169.254.170.2/v4/synthetic",
        },
        stdout: { write: (s) => output.push(s) },
      },
      fetch: async (url) => ({
        status: 200,
        body: Readable.from([
          JSON.stringify(url.endsWith("/task") ? task : container),
        ]),
      }),
    },
  );
  expect(requests).toHaveLength(7);
  expect(output).toHaveLength(10);
  expect(JSON.parse(output.at(-1)).value.status).toBe("complete");
  expect(output.join("")).not.toContain("AKIDEXAMPLE");
  expect(output.join("")).not.toContain("synthetic");
});

test("expired embedded input emits UNKNOWN without metadata or credentials", async () => {
  const m = manifestFixture(),
    output = [],
    fetch = jest.fn();
  const rendered = renderCollector(m, {
    nonce: "nonce",
    validUntil: Date.now() / 1000 - 1,
  });
  const require = jest.fn(nodeRequire);
  await runInNewContext(
    rendered.command.slice("/usr/local/bin/node -e '".length, -1),
    {
      require,
      Buffer,
      AbortSignal,
      URL,
      TextDecoder,
      fetch,
      process: { env: {}, stdout: { write: (s) => output.push(s) } },
    },
  );
  expect(fetch).not.toHaveBeenCalled();
  expect(require.mock.calls.some(([name]) => name.startsWith("/app/"))).toBe(
    false,
  );
  expect(JSON.parse(output.at(-1)).value.status).toBe("UNKNOWN");
});
