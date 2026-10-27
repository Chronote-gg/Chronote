/** @jest-environment node */
import process from "node:process";
import { Buffer } from "node:buffer";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect, jest, afterEach } from "@jest/globals";
import { privateCaptureFixture } from "../fixtures/deployment/privateCapture.js";
import { digest } from "../../scripts/deployment/collector-payload.cjs";
import { main } from "../../scripts/deployment/verify-production-bootstrap.cjs";

const mockState = {};
jest.mock(
  "../../scripts/deployment/bootstrap-verification-authority.cjs",
  () => ({
    verifyAuthority: (...args) => mockState.authority(...args),
  }),
);
jest.mock("@aws-sdk/client-sts", () => ({
  ...jest.requireActual("@aws-sdk/client-sts"),
  STSClient: class {
    constructor(config) {
      mockState.stsConfig = config;
      mockState.stsConfigs.push(config);
    }
    send(...args) {
      return mockState.sts(...args);
    }
  },
}));
jest.mock("@aws-sdk/client-s3", () => ({
  ...jest.requireActual("@aws-sdk/client-s3"),
  S3Client: class {
    constructor(config) {
      mockState.s3Config = config;
      this.config = mockState.fixture.client.config;
    }
    send(...args) {
      return mockState.s3(...args);
    }
  },
}));
const directories = [];
afterEach(() => {
  jest.restoreAllMocks();
  for (const directory of directories.splice(0)) {
    expect(directory.startsWith(join(tmpdir(), "bootstrap-cli-"))).toBe(true);
    rmSync(directory, { recursive: true, force: true });
  }
});
function fixture() {
  const f = privateCaptureFixture();
  f.binding.bucket = `meeting-notes-prod-private-evidence-${f.binding.accountId}`;
  f.binding.retentionUntil = Math.floor(Date.now() / 1000) + 100000;
  const directory = mkdtempSync(join(tmpdir(), "bootstrap-cli-"));
  directories.push(directory);
  const text = JSON.stringify({ environmentId: 77, binding: f.binding });
  const env = {
    GITHUB_REPOSITORY: "Chronote-gg/Chronote",
    GITHUB_REF: "refs/heads/master",
    GITHUB_SHA: "a".repeat(40),
    GITHUB_RUN_ID: "42",
    GITHUB_RUN_ATTEMPT: "1",
    VERIFICATION_SOURCE_SHA: "a".repeat(40),
    VERIFICATION_DEADLINE: new Date(Date.now() + 300000).toISOString(),
    BOOTSTRAP_VERIFICATION_STORAGE_JSON: text,
    VERIFICATION_STORAGE_SHA256: digest(text),
    RUNNER_TEMP: directory,
    GITHUB_OUTPUT: join(directory, "output"),
    GH_TOKEN: "private-token",
    ACTIONS_ID_TOKEN_REQUEST_URL:
      "https://pipelines.actions.githubusercontent.com/idtoken?api-version=2.0",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "private-oidc-request-token",
  };
  const proof = { environment: { id: 77 }, review: { state: "approved" } };
  const caller = {
    Account: f.binding.accountId,
    Arn: `arn:aws:sts::${f.binding.accountId}:assumed-role/meeting-notes-prod-github-terraform/bootstrap-verify-42-1`,
  };
  Object.assign(mockState, {
    fixture: f,
    stsConfig: null,
    stsConfigs: [],
    s3Config: null,
    authority: jest.fn(async () => proof),
    sts: jest.fn(async (command, options) => {
      options.abortSignal.throwIfAborted();
      return {
        ...(command.constructor.name === "AssumeRoleWithWebIdentityCommand"
          ? {
              Credentials: {
                AccessKeyId: "temporary-access-key",
                SecretAccessKey: "temporary-secret",
                SessionToken: "temporary-session-token",
                Expiration: new Date(Date.now() + 900000),
              },
            }
          : caller),
        $metadata: { httpStatusCode: 200, requestId: "sts-request" },
      };
    }),
    s3: jest.fn(async (command, options) => {
      options.abortSignal.throwIfAborted();
      const input = command.input;
      const put = command.constructor.name === "PutObjectCommand";
      const denied = put
        ? !input.IfNoneMatch || input.ServerSideEncryption === "AES256"
        : command.constructor.name === "GetObjectCommand" && !input.VersionId;
      const duplicate = put && f.objects.has(input.Key);
      if (denied || duplicate)
        throw Object.assign(new Error("synthetic denial"), {
          name: denied ? "AccessDenied" : "PreconditionFailed",
          $metadata: {
            httpStatusCode: denied ? 403 : 412,
            requestId: "probe-request",
          },
        });
      return {
        ...(await f.client.send(command)),
        $metadata: { httpStatusCode: 200, requestId: "s3-request" },
      };
    }),
  });
  jest.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
    expect(
      existsSync(join(directory, "bootstrap-verification", "attempt.json")),
    ).toBe(true);
    expect(mockState.authority).toHaveBeenCalledTimes(1);
    expect(new URL(url).searchParams.get("audience")).toBe("sts.amazonaws.com");
    expect(options).toMatchObject({
      headers: { Authorization: "Bearer private-oidc-request-token" },
      redirect: "error",
    });
    options.signal.throwIfAborted();
    return new Response(JSON.stringify({ value: "private.oidc.token" }), {
      status: 200,
    });
  });
  return {
    ...f,
    env,
    proof,
    caller,
    directory,
    privateDirectory: join(directory, "bootstrap-verification"),
  };
}

test("one process verifies approval and applies the restricted policy on its first AWS call", async () => {
  const f = fixture();
  jest.spyOn(process.stdout, "write").mockReturnValue(true);
  await main("run", f.env);
  expect(mockState.authority).toHaveBeenCalledWith(
    expect.any(Function),
    { runId: "42", sourceSha: f.env.GITHUB_SHA },
    77,
  );
  expect(
    JSON.parse(
      readFileSync(join(f.privateDirectory, "authority.json"), "utf8"),
    ),
  ).toMatchObject({
    proof: f.proof,
    identity: { runId: "42", sourceSha: f.env.GITHUB_SHA },
    storageSha256: f.env.VERIFICATION_STORAGE_SHA256,
    deadline: Date.parse(f.env.VERIFICATION_DEADLINE),
  });
  const assumption = mockState.sts.mock.calls[0][0];
  expect(assumption.constructor.name).toBe("AssumeRoleWithWebIdentityCommand");
  expect(assumption.input).toMatchObject({
    RoleArn: `arn:aws:iam::${f.binding.accountId}:role/meeting-notes-prod-github-terraform`,
    RoleSessionName: "bootstrap-verify-42-1",
    DurationSeconds: 900,
    WebIdentityToken: "private.oidc.token",
  });
  expect(Buffer.byteLength(assumption.input.Policy)).toBeLessThanOrEqual(2048);
  expect(JSON.parse(assumption.input.Policy).Statement[1].Action).toEqual([
    "s3:PutObject",
    "s3:GetObjectVersion",
  ]);
  expect(existsSync(f.env.GITHUB_OUTPUT)).toBe(false);
  await expect(mockState.stsConfigs[0].credentials()).rejects.toThrow(
    "ambient credentials refused",
  );
  expect(mockState.stsConfigs[1].credentials).toEqual(
    mockState.s3Config.credentials,
  );
});

test.each(["digest", "attempt", "source", "deadline", "ambient", "approval"])(
  "run refuses %s before OIDC or AWS transport",
  async (fault) => {
    const f = fixture();
    const edits = {
      digest: () => {
        f.env.VERIFICATION_STORAGE_SHA256 = "0".repeat(64);
      },
      attempt: () => {
        f.env.GITHUB_RUN_ATTEMPT = "2";
      },
      source: () => {
        f.env.VERIFICATION_SOURCE_SHA = "b".repeat(40);
      },
      deadline: () => {
        f.env.VERIFICATION_DEADLINE = new Date(Date.now() - 1000).toISOString();
      },
      ambient: () => {
        f.env.AWS_ACCESS_KEY_ID = "unapproved";
      },
      approval: () => {
        mockState.authority.mockRejectedValue(new Error("no approval"));
      },
    };
    edits[fault]();
    await expect(main("run", f.env)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    expect(mockState.sts).not.toHaveBeenCalled();
    expect(mockState.s3).not.toHaveBeenCalled();
    expect(existsSync(f.env.GITHUB_OUTPUT)).toBe(false);
  },
);

test("actual wrong STS caller refuses before S3", async () => {
  const f = fixture();
  const send = mockState.sts;
  mockState.sts = jest.fn(async (command, options) =>
    command.constructor.name === "GetCallerIdentityCommand"
      ? {
          Account: "000000000000",
          Arn: "foreign",
          $metadata: { httpStatusCode: 200, requestId: "foreign-request" },
        }
      : send(command, options),
  );
  await expect(main("run", f.env)).rejects.toThrow();
  expect(mockState.sts).toHaveBeenCalledTimes(2);
  expect(mockState.s3).not.toHaveBeenCalled();
  expect(mockState.stsConfig).toMatchObject({
    region: "us-east-1",
    endpoint: "https://sts.us-east-1.amazonaws.com",
    maxAttempts: 1,
  });
});

test("successful CLI retains caller and receipts privately, with only digests in public output", async () => {
  const f = fixture();
  const output = jest.spyOn(process.stdout, "write").mockReturnValue(true);
  await main("run", f.env);
  const reportEntry = [...f.objects.entries()].find(([key]) =>
    key.includes("/report/"),
  );
  const report = JSON.parse(reportEntry[1].toString());
  expect(report.caller).toEqual(f.caller);
  expect(report.receipts[2]).toMatchObject({
    operation: "GetCallerIdentityCommand",
    outcome: "received",
    status: 200,
  });
  expect(report.receiptsSha256).toBe(digest(JSON.stringify(report.receipts)));
  expect(report.receipts.some((receipt) => receipt.status === 412)).toBe(true);
  const journal = readFileSync(
    join(f.privateDirectory, "receipts.jsonl"),
    "utf8",
  )
    .trim()
    .split("\n")
    .map(JSON.parse);
  expect(journal[0].outcome).toBe("started");
  expect(journal[3].requestId).toBe("sts-request");
  expect(mockState.s3Config).toMatchObject({
    region: "us-east-1",
    endpoint: "https://s3.us-east-1.amazonaws.com",
    maxAttempts: 1,
    credentials: {
      accessKeyId: "temporary-access-key",
      secretAccessKey: "temporary-secret",
      sessionToken: "temporary-session-token",
    },
  });
  const printed = output.mock.calls.map(([text]) => text).join("");
  expect(printed).toContain("reportSha256");
  expect(printed).not.toMatch(
    /versionId|private-token|bucket|123456789012|kms|Arn|private\.oidc\.token|temporary-secret/,
  );
  expect(journal.map(JSON.stringify).join("\n")).not.toMatch(
    /private\.oidc\.token|temporary-secret|temporary-session-token/,
  );
  expect(Buffer.byteLength(reportEntry[1])).toBeLessThanOrEqual(65536);
});

test("lost write is journaled once and a second CLI run cannot replay it", async () => {
  const f = fixture();
  const send = mockState.s3;
  let writes = 0;
  mockState.s3 = jest.fn(async (command, options) => {
    if (command.constructor.name === "PutObjectCommand") {
      writes++;
      throw new Error("lost acknowledgment");
    }
    return send(command, options);
  });
  await expect(main("run", f.env)).rejects.toThrow();
  await expect(main("run", f.env)).rejects.toThrow();
  expect(writes).toBe(1);
  expect(mockState.sts).toHaveBeenCalledTimes(2);
  expect(fetch).toHaveBeenCalledTimes(1);
  const journal = readFileSync(
    join(f.privateDirectory, "receipts.jsonl"),
    "utf8",
  );
  expect(journal).toContain('"outcome":"failed"');
  expect(existsSync(join(f.privateDirectory, "result.json"))).toBe(false);
});

test.each(["approval", "token", "assumption", "identity"])(
  "expiry after %s stops the next request even before the abort timer runs",
  async (stage) => {
    const f = fixture();
    let clock = Date.now();
    jest.spyOn(Date, "now").mockImplementation(() => clock);
    const expire = () => {
      clock += 600000;
    };
    const authority = mockState.authority;
    mockState.authority = jest.fn(async (...args) => {
      const result = await authority(...args);
      if (stage === "approval") expire();
      return result;
    });
    const request = fetch.getMockImplementation();
    fetch.mockImplementation(async (...args) => {
      const response = await request(...args);
      if (stage === "token") expire();
      return response;
    });
    const send = mockState.sts;
    mockState.sts = jest.fn(async (command, options) => {
      const response = await send(command, options);
      if (
        (stage === "assumption" &&
          command.constructor.name === "AssumeRoleWithWebIdentityCommand") ||
        (stage === "identity" &&
          command.constructor.name === "GetCallerIdentityCommand")
      )
        expire();
      return response;
    });
    await expect(main("run", f.env)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(stage === "approval" ? 0 : 1);
    expect(mockState.sts).toHaveBeenCalledTimes(
      { approval: 0, token: 0, assumption: 1, identity: 2 }[stage],
    );
    expect(mockState.s3).not.toHaveBeenCalled();
  },
);

test.each([
  "http://pipelines.actions.githubusercontent.com/idtoken",
  "https://actions.githubusercontent.com.attacker.test/idtoken",
  "https://pipelines.actions.githubusercontent.com:444/idtoken",
  "https://user@pipelines.actions.githubusercontent.com/idtoken",
  "https://pipelines.actions.githubusercontent.com/idtoken#fragment",
])("refuses an untrusted OIDC URL before sending a token: %s", async (url) => {
  const f = fixture();
  f.env.ACTIONS_ID_TOKEN_REQUEST_URL = url;
  await expect(main("run", f.env)).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
  expect(mockState.sts).not.toHaveBeenCalled();
});

test.each(["redirect", "oversized", "malformed", "lost"])(
  "OIDC %s response refuses STS and cannot be replayed",
  async (fault) => {
    const f = fixture();
    fetch.mockImplementation(async () => {
      if (fault === "lost") throw new Error("lost token response");
      return new Response(
        fault === "oversized"
          ? "x".repeat(65537)
          : JSON.stringify({ value: "invalid" }),
        { status: fault === "redirect" ? 302 : 200 },
      );
    });
    await expect(main("run", f.env)).rejects.toThrow();
    await expect(main("run", f.env)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(mockState.sts).not.toHaveBeenCalled();
    expect(mockState.s3).not.toHaveBeenCalled();
  },
);

test.each([
  "AWS_PROFILE",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_SHARED_CREDENTIALS_FILE",
])("refuses the ambient credential route %s", async (key) => {
  const f = fixture();
  f.env[key] = "unapproved";
  await expect(main("run", f.env)).rejects.toThrow(
    "ambient credentials refused",
  );
  expect(fetch).not.toHaveBeenCalled();
  expect(mockState.sts).not.toHaveBeenCalled();
});

test.each(["lost", "missing", "expired"])(
  "an %s assumption cannot fall back or replay",
  async (fault) => {
    const f = fixture();
    mockState.sts.mockImplementation(async () => {
      if (fault === "lost") throw new Error("lost assumption response");
      return {
        Credentials:
          fault === "missing"
            ? {}
            : {
                AccessKeyId: "temporary-access-key",
                SecretAccessKey: "temporary-secret",
                SessionToken: "temporary-session-token",
                Expiration: new Date(Date.now() - 1000),
              },
        $metadata: { httpStatusCode: 200, requestId: "sts-request" },
      };
    });
    await expect(main("run", f.env)).rejects.toThrow();
    await expect(main("run", f.env)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(mockState.sts).toHaveBeenCalledTimes(1);
    expect(mockState.s3).not.toHaveBeenCalled();
  },
);
