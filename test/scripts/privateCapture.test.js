/** @jest-environment node */
import { Buffer } from "node:buffer";
import { test, expect } from "@jest/globals";
import { createPrivateCapture } from "../../scripts/deployment/private-capture.cjs";
import { privateCaptureFixture as fixture } from "../fixtures/deployment/privateCapture.js";
import { digest } from "../../scripts/deployment/collector-payload.cjs";

const canonicalPolicy =
  '{"Statement":[{"Action":["s3:GetObject","s3:PutObject"],"Condition":{"Bool":{"aws:SecureTransport":"false"}},"Effect":"Deny","Principal":"*","Resource":"arn:aws:s3:::private-synthetic/*"}],"Version":"2012-10-17"}';

test("private capture accepts reordered nested policy object keys", async () => {
  const f = fixture(),
    send = f.client.send;
  f.binding.canonicalPolicySha256 = digest(canonicalPolicy);
  f.client.send = async (command) =>
    command.constructor.name === "GetBucketPolicyCommand"
      ? {
          Policy: JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Resource: "arn:aws:s3:::private-synthetic/*",
                Principal: "*",
                Effect: "Deny",
                Condition: { Bool: { "aws:SecureTransport": "false" } },
                Action: ["s3:GetObject", "s3:PutObject"],
              },
            ],
          }),
        }
      : send(command);
  await expect(
    createPrivateCapture(f.options).checkReady(),
  ).resolves.toBeUndefined();
});

test.each([
  ["changed permission", canonicalPolicy.replace('"Deny"', '"Allow"')],
  ["changed condition type", canonicalPolicy.replace('"false"', "false")],
  [
    "reordered array",
    canonicalPolicy.replace(
      '["s3:GetObject","s3:PutObject"]',
      '["s3:PutObject","s3:GetObject"]',
    ),
  ],
  ["malformed JSON", '{"Statement":'],
])("private capture refuses %s before writes", async (_, policy) => {
  const f = fixture(),
    send = f.client.send;
  f.binding.canonicalPolicySha256 = digest(canonicalPolicy);
  f.client.send = async (command) =>
    command.constructor.name === "GetBucketPolicyCommand"
      ? { Policy: policy }
      : send(command);
  await expect(
    createPrivateCapture(f.options).capture({ a: 1 }),
  ).rejects.toThrow("UNKNOWN");
  expect(f.calls.some((c) => c.constructor.name === "PutObjectCommand")).toBe(
    false,
  );
});

test.each([false, true])(
  "legacy raw policy hash binding refuses before transport (canonical field present: %s)",
  (keepCanonical) => {
    const f = fixture();
    f.binding.policySha256 = digest("{}");
    if (!keepCanonical) delete f.binding.canonicalPolicySha256;
    expect(() => createPrivateCapture(f.options)).toThrow();
    expect(f.calls).toHaveLength(0);
  },
);

test("private capture uses conditional one-attempt creation and exact version original-byte readback", async () => {
  const f = fixture(),
    store = createPrivateCapture(f.options),
    value = { z: "private", a: 1 };
  const ref = await store.capture(value);
  expect(ref.versionId).toBe("v1");
  expect(await store.readCapture(ref)).toEqual(value);
  const writes = f.calls.filter(
    (c) => c.constructor.name === "PutObjectCommand",
  );
  expect(writes).toHaveLength(1);
  expect(writes[0].input.IfNoneMatch).toBe("*");
  expect(writes[0].input.Body.toString()).toBe('{"z":"private","a":1}');
  expect(
    f.calls
      .filter((c) => c.constructor.name === "GetObjectCommand")
      .every((c) => c.input.VersionId === "v1"),
  ).toBe(true);
  expect(
    f.calls.every((c) => c.input.ExpectedBucketOwner === f.binding.accountId),
  ).toBe(true);
});
test.each([
  ["native SSE-C block", { EncryptionType: ["SSE-C"] }],
  ["undefined optional block", undefined],
])(
  "private capture readiness accepts %s",
  async (_, blockedEncryptionTypes) => {
    const f = fixture(),
      send = f.client.send;
    f.client.send = async (command) => {
      const result = await send(command);
      if (command.constructor.name === "GetBucketEncryptionCommand")
        result.ServerSideEncryptionConfiguration.Rules[0].BlockedEncryptionTypes =
          blockedEncryptionTypes;
      return result;
    };
    const store = createPrivateCapture(f.options);
    await expect(store.checkReady()).resolves.toBeUndefined();
    expect(f.calls.some((c) => c.constructor.name === "PutObjectCommand")).toBe(
      false,
    );
  },
);

test.each([
  [
    "wrong algorithm",
    (rules) => {
      rules[0].ApplyServerSideEncryptionByDefault.SSEAlgorithm = "AES256";
    },
  ],
  [
    "wrong KMS key",
    (rules) => {
      rules[0].ApplyServerSideEncryptionByDefault.KMSMasterKeyID = "wrong-key";
    },
  ],
  [
    "enabled bucket keys",
    (rules) => {
      rules[0].BucketKeyEnabled = true;
    },
  ],
  [
    "multiple rules",
    (rules) => {
      rules.push({ ...rules[0] });
    },
  ],
  [
    "unknown rule field",
    (rules) => {
      rules[0].Unsupported = true;
    },
  ],
  [
    "null blocked encryption",
    (rules) => {
      rules[0].BlockedEncryptionTypes = null;
    },
  ],
  [
    "empty blocked encryption",
    (rules) => {
      rules[0].BlockedEncryptionTypes = { EncryptionType: [] };
    },
  ],
  [
    "unsupported blocked encryption",
    (rules) => {
      rules[0].BlockedEncryptionTypes = { EncryptionType: ["aws:kms"] };
    },
  ],
  [
    "malformed blocked encryption",
    (rules) => {
      rules[0].BlockedEncryptionTypes = { EncryptionType: "SSE-C" };
    },
  ],
  [
    "unknown blocked encryption field",
    (rules) => {
      rules[0].BlockedEncryptionTypes = {
        EncryptionType: ["SSE-C"],
        Unsupported: true,
      };
    },
  ],
])("private capture readiness refuses %s before writes", async (_, mutate) => {
  const f = fixture(),
    send = f.client.send;
  f.client.send = async (command) => {
    const result = await send(command);
    if (command.constructor.name === "GetBucketEncryptionCommand")
      mutate(result.ServerSideEncryptionConfiguration.Rules);
    return result;
  };
  await expect(createPrivateCapture(f.options).checkReady()).rejects.toThrow(
    "UNKNOWN: encryption",
  );
  expect(f.calls.some((c) => c.constructor.name === "PutObjectCommand")).toBe(
    false,
  );
});

test("missing configuration refuses before any transport", () => {
  const f = fixture();
  expect(() =>
    createPrivateCapture({ ...f.options, binding: undefined }),
  ).toThrow();
  expect(f.calls).toHaveLength(0);
});
test.each([
  "unknown-write",
  "null-version",
  "changed-bytes",
  "changed-version",
  "public",
  "lifecycle",
  "retention",
])("rejects %s without retry or delete", async (fault) => {
  const f = fixture(),
    send = f.client.send;
  if (fault === "retention") f.binding.retentionUntil = 999;
  f.client.send = async (c) => {
    if (
      c.constructor.name === "PutObjectCommand" &&
      fault === "unknown-write"
    ) {
      await send(c);
      throw new Error("synthetic secret must not escape");
    }
    const result = await send(c);
    if (c.constructor.name === "PutObjectCommand" && fault === "null-version")
      result.VersionId = "null";
    if (c.constructor.name === "GetObjectCommand" && fault === "changed-bytes")
      result.Body = [Buffer.from("{}")];
    if (
      c.constructor.name === "GetObjectCommand" &&
      fault === "changed-version"
    )
      result.VersionId = "v2";
    if (
      c.constructor.name === "GetBucketPolicyStatusCommand" &&
      fault === "public"
    )
      result.PolicyStatus.IsPublic = true;
    return result;
  };
  if (fault === "lifecycle")
    f.client.send = async (c) =>
      c.constructor.name === "GetBucketLifecycleConfigurationCommand"
        ? { Rules: [{ Status: "Enabled", Expiration: { Days: 1 } }] }
        : send(c);
  await expect(async () => {
    const store = createPrivateCapture(f.options);
    await store.capture({ a: 1 });
  }).rejects.toThrow(/UNKNOWN|retention|privacy|lifecycle|version|bytes/);
  expect(
    f.calls.filter((c) => c.constructor.name === "PutObjectCommand").length,
  ).toBeLessThanOrEqual(1);
  expect(f.calls.some((c) => /Delete/.test(c.constructor.name))).toBe(false);
});

test("Terraform capture derives a separate strict invocation namespace and checks storage before provider work", async () => {
  const { createTerraformCapture } =
    await import("../../scripts/deployment/private-capture.cjs");
  const f = fixture();
  f.binding.retentionUntil = 40000;
  const invocation = {
    repository: "Chronote-gg/Chronote",
    sourceSha: "a".repeat(40),
    workflowPath: ".github/workflows/terraform-plan.yml",
    runId: "10",
    runAttempt: 1,
    environment: "production",
    workspace: "default",
    scope: "full",
  };
  const store = createTerraformCapture({
    invocation,
    binding: f.binding,
    client: f.client,
    now: () => 1000,
  });
  await store.checkReady();
  expect(f.calls.some((c) => c.constructor.name === "PutObjectCommand")).toBe(
    false,
  );
  const ref = await store.capture({ bytes: "AP8=" });
  expect(ref.namespace).toBe(
    "terraform/production/10/1/" + digest(JSON.stringify(invocation)),
  );
  expect(await store.readCapture(ref)).toEqual({ bytes: "AP8=" });
  expect(() =>
    createTerraformCapture({
      invocation: {
        ...invocation,
        namespace: "production-introduction/arbitrary",
      },
      binding: f.binding,
      client: f.client,
    }),
  ).toThrow();
  expect(() =>
    createTerraformCapture({
      invocation: { ...invocation, workspace: "sandbox" },
      binding: f.binding,
      client: f.client,
    }),
  ).toThrow();
});
