/** @jest-environment node */
import { Buffer } from "node:buffer";
import { test, expect } from "@jest/globals";
import { createVerificationCapture } from "../../scripts/deployment/private-capture.cjs";
import { privateCaptureFixture } from "../fixtures/deployment/privateCapture.js";
import {
  verificationIdentity,
  verificationPolicy,
  runStorageVerification,
} from "../../scripts/deployment/bootstrap-verification.cjs";

function fixture() {
  const f = privateCaptureFixture();
  const identity = { runId: "42", sourceSha: "a".repeat(40) };
  const send = f.client.send;
  f.client.send = async (command) => {
    const i = command.input;
    const failure = (name, status) =>
      Object.assign(new Error("synthetic"), {
        name,
        $metadata: { httpStatusCode: status, requestId: "request" },
      });
    if (command.constructor.name === "PutObjectCommand") {
      if (!i.IfNoneMatch || i.ServerSideEncryption !== "aws:kms")
        throw failure("AccessDenied", 403);
      if (f.objects.has(i.Key)) throw failure("PreconditionFailed", 412);
    }
    if (command.constructor.name === "GetObjectCommand" && !i.VersionId)
      throw failure("AccessDenied", 403);
    return send(command);
  };
  return { ...f, identity, now: () => 1000 };
}

test("verification capture has its own real content-addressed namespace", async () => {
  const f = fixture();
  const store = createVerificationCapture({ ...f, purpose: "payload" });
  const ref = await store.capture({ synthetic: true });
  expect(ref.namespace).toBe(
    `terraform/production/verification/42/1/${"a".repeat(40)}/payload`,
  );
  expect(await store.readCapture(ref)).toEqual({ synthetic: true });
});

test.each(["runId", "sourceSha", "purpose"])(
  "verification constructor rejects invalid %s before transport",
  (field) => {
    const f = fixture();
    const options = { ...f, purpose: "payload" };
    if (field === "purpose") options.purpose = "terraform-plan";
    else options.identity = { ...f.identity, [field]: "../escape" };
    expect(() => createVerificationCapture(options)).toThrow();
    expect(f.calls).toHaveLength(0);
  },
);

test("finite storage verification retains exactly payload and report and expected denials", async () => {
  const f = fixture();
  const result = await runStorageVerification(f);
  expect(result.outcome).toBe(
    "storage-probes-passed-reviewer-readback-pending",
  );
  expect(f.objects.size).toBe(2);
  expect(result.probes.map((p) => p.status)).toEqual([412, 403, 403, 403]);
  expect(
    f.calls.every((c) => !/Delete|List|Update/.test(c.constructor.name)),
  ).toBe(true);
});

test.each([
  "duplicate",
  "missing-condition",
  "wrong-encryption",
  "latest-read",
])(
  "unexpected success at %s stops without a report or replay",
  async (fault) => {
    const f = fixture();
    const send = f.client.send;
    let injected = false;
    f.client.send = async (command, options) => {
      const i = command.input;
      const selected = {
        duplicate:
          i.IfNoneMatch &&
          f.objects.has(i.Key) &&
          command.constructor.name === "PutObjectCommand",
        "missing-condition": i.Key?.endsWith("negative/missing-condition"),
        "wrong-encryption": i.Key?.endsWith("negative/wrong-encryption"),
        "latest-read":
          command.constructor.name === "GetObjectCommand" && !i.VersionId,
      };
      if (!injected && selected[fault]) {
        injected = true;
        return { Body: { destroy() {} } };
      }
      return send(command, options);
    };
    await expect(runStorageVerification(f)).rejects.toThrow();
    expect(injected).toBe(true);
    expect([...f.objects.keys()].some((key) => key.includes("/report/"))).toBe(
      false,
    );
  },
);

test("session policy fits STS and contains only finite synthetic resources and KMS context", () => {
  const f = fixture();
  const text = verificationPolicy(f.binding, f.identity);
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(2048);
  const policy = JSON.parse(text);
  expect(policy.Statement).toHaveLength(3);
  expect(policy.Statement[1].Resource).toHaveLength(4);
  expect(
    policy.Statement[1].Resource.filter((r) => r.endsWith("*")),
  ).toHaveLength(1);
  expect(text).not.toMatch(
    /dynamodb:|ecs:|iam:|terraform-state|DeleteObject|s3:GetObject"/,
  );
});

test("identity parsing binds exact source, first attempt, account, storage and deadline", () => {
  const f = fixture();
  const env = {
    GITHUB_REPOSITORY: "Chronote-gg/Chronote",
    GITHUB_REF: "refs/heads/master",
    GITHUB_SHA: f.identity.sourceSha,
    GITHUB_RUN_ID: "42",
    GITHUB_RUN_ATTEMPT: "1",
    VERIFICATION_SOURCE_SHA: f.identity.sourceSha,
    VERIFICATION_DEADLINE: new Date(1100 * 1000).toISOString(),
  };
  f.binding.bucket = `meeting-notes-prod-private-evidence-${f.binding.accountId}`;
  f.binding.retentionUntil = 100000;
  expect(verificationIdentity(env, f.binding, 1000).runId).toBe("42");
  for (const [key, value] of Object.entries({
    GITHUB_RUN_ATTEMPT: "2",
    GITHUB_REF: "refs/heads/other",
    VERIFICATION_SOURCE_SHA: "b".repeat(40),
    VERIFICATION_DEADLINE: new Date(999000).toISOString(),
  })) {
    expect(() =>
      verificationIdentity({ ...env, [key]: value }, f.binding, 1000),
    ).toThrow();
  }
});

test.each([
  "lost-write",
  "version",
  "bytes",
  "encryption",
  "report",
  "authority",
  "expired",
])("refuses %s and never replays a capture", async (fault) => {
  const f = fixture(),
    send = f.client.send;
  let writes = 0;
  f.client.send = async (command, options) => {
    if (command.constructor.name === "PutObjectCommand") {
      writes++;
      if (
        fault === "lost-write" ||
        (fault === "report" && command.input.Key.includes("/report/"))
      )
        throw new Error("lost");
    }
    const result = await send(command, options);
    if (command.constructor.name === "GetObjectCommand") {
      if (fault === "version") result.VersionId = "other";
      if (fault === "bytes") result.Body = [Buffer.from("different")];
      if (fault === "encryption") result.ServerSideEncryption = "AES256";
    }
    return result;
  };
  let reads = 0;
  const authority = async () => ({
    revision: fault === "authority" ? reads++ : 1,
  });
  const signal =
    fault === "expired" ? AbortSignal.abort() : new AbortController().signal;
  await expect(
    runStorageVerification({ ...f, authority, signal }),
  ).rejects.toThrow();
  expect(writes).toBeLessThanOrEqual(
    fault === "report" ? 5 : fault === "authority" ? 4 : 1,
  );
});
