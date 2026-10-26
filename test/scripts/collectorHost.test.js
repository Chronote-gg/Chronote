/** @jest-environment node */
import process from "node:process";
import { Buffer } from "node:buffer";
import { test, expect } from "@jest/globals";
import {
  captureWindowsHost,
  verifyWindowsQuiescence,
} from "../../scripts/deployment/collector-host.cjs";
import { privateCaptureFixture } from "../fixtures/deployment/privateCapture.js";
import { createPreparationCapture } from "../../scripts/deployment/private-capture.cjs";
function fixture() {
  const f = privateCaptureFixture();
  const preparation = {
    kind: "production-introduction-preparation",
    operationId: f.options.m.binding.operationId,
    sourceSha: f.options.m.binding.sourceSha,
    evidenceStoreId: f.binding.storeId,
    validUntil: 5000,
  };
  const host = {
    hostName: "OPERATOR",
    readerSid: "S-1-5-21-1000",
    bootAt: "1970-01-01T00:00:01.000Z",
    window: {
      authorityId: "reviewed-window-1",
      notBefore: 900,
      validUntil: 1100,
    },
    writerExecutables: ["node.exe", "powershell.exe", "pwsh.exe", "cmd.exe"],
  };
  const raw = {
    hostName: host.hostName,
    readerSid: host.readerSid,
    bootAt: host.bootAt,
    readerPid: 90,
    processes: [
      {
        pid: 90,
        parentPid: process.pid,
        name: "powershell.exe",
        createdAt: "1970-01-01T00:16:39.000Z",
        commandLine: "native fixed reader",
      },
      {
        pid: process.pid,
        parentPid: 4,
        name: "node.exe",
        createdAt: "1970-01-01T00:16:38.000Z",
        commandLine: "fixed collector",
      },
      {
        pid: 4,
        parentPid: 0,
        name: "System",
        createdAt: null,
        commandLine: null,
      },
    ],
  };
  const options = {
    preparation,
    storageBinding: f.binding,
    s3: f.client,
    host,
    now: () => 1000,
    platform: "win32",
    readNative: async () => ({ stdout: JSON.stringify(raw) }),
  };
  return { f, preparation, host, raw, options };
}
test("fixed Windows producer retains a secret-free complete native inventory and verifier proves zero writers", async () => {
  const f = fixture();
  f.raw.processes[2].commandLine = "PROVIDER_SECRET_SENTINEL";
  const ref = await captureWindowsHost(f.options);
  const store = createPreparationCapture({
    ...f.f.options,
    preparation: f.preparation,
  });
  const capture = await store.readCapture(ref);
  expect(JSON.stringify(capture)).not.toContain("PROVIDER_SECRET_SENTINEL");
  expect(capture.processes).toHaveLength(3);
  expect(
    verifyWindowsQuiescence({
      preparation: f.preparation,
      host: f.host,
      capture,
      now: 1000,
      validUntil: 1050,
      maxAge: 60,
    }),
  ).toEqual({ hostName: "OPERATOR", writers: [] });
});
test.each([
  "foreign-host",
  "boot-change",
  "inaccessible",
  "active",
  "descendant",
  "unknown-command",
])(
  "native %s prevents a quiescence capture with safe errors",
  async (fault) => {
    const f = fixture();
    const secret = "PROVIDER_SECRET_SENTINEL";
    if (fault === "foreign-host") f.raw.hostName = "FOREIGN";
    if (fault === "boot-change") f.raw.bootAt = "1970-01-01T00:01:00.000Z";
    if (fault === "inaccessible")
      f.options.readNative = async () => {
        throw new Error(secret);
      };
    if (["active", "unknown-command", "descendant"].includes(fault))
      f.raw.processes.push({
        pid: 100,
        parentPid: fault === "descendant" ? process.pid : 4,
        name: fault === "descendant" ? "helper.exe" : "node.exe",
        createdAt: "1970-01-01T00:16:00.000Z",
        commandLine:
          fault === "active"
            ? "node scripts/publish-recovered-meeting.ts apply"
            : secret,
      });
    let failure;
    try {
      await captureWindowsHost(f.options);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeDefined();
    expect(String(failure)).not.toContain(secret);
    expect(
      f.f.calls.some((c) => c.constructor.name === "PutObjectCommand"),
    ).toBe(false);
  },
);
test.each([
  "stale",
  "foreign-source",
  "short-window",
  "missing-process",
  "pid-reuse",
])(
  "retained %s cannot substitute for current complete quiescence",
  async (fault) => {
    const f = fixture();
    const ref = await captureWindowsHost(f.options);
    const store = createPreparationCapture({
      ...f.f.options,
      preparation: f.preparation,
    });
    const capture = await store.readCapture(ref);
    if (fault === "stale") capture.observedAt = 900;
    if (fault === "foreign-source")
      capture.preparation.sourceSha = "e".repeat(40);
    if (fault === "short-window") f.host.window.validUntil = 1020;
    if (fault === "missing-process") capture.processes.pop();
    if (fault === "pid-reuse")
      capture.processes.push({
        ...capture.processes[0],
        createdAt: "1970-01-01T00:16:39.500Z",
      });
    expect(() =>
      verifyWindowsQuiescence({
        preparation: f.preparation,
        host: f.host,
        capture,
        now: 1000,
        validUntil: 1050,
        maxAge: 60,
      }),
    ).toThrow();
  },
);
test("cyclic process ancestry refuses even when every process name is outside the writer set", async () => {
  const f = fixture();
  f.raw.processes.push(
    {
      pid: 100,
      parentPid: 101,
      name: "helper.exe",
      createdAt: "1970-01-01T00:16:00.000Z",
      commandLine: null,
    },
    {
      pid: 101,
      parentPid: 100,
      name: "other.exe",
      createdAt: "1970-01-01T00:16:00.000Z",
      commandLine: null,
    },
  );
  await expect(captureWindowsHost(f.options)).rejects.toThrow(/UNKNOWN/);
});
test("invalid preparation identity refuses before native observation", async () => {
  const f = fixture();
  f.options.preparation = { ...f.preparation, namespace: "arbitrary" };
  let calls = 0;
  f.options.readNative = async () => {
    calls++;
    return { stdout: JSON.stringify(f.raw) };
  };
  await expect(captureWindowsHost(f.options)).rejects.toThrow(/UNKNOWN/);
  expect(calls).toBe(0);
});

test("fixed native reader requests only identity metadata, without command lines", async () => {
  const f = fixture();
  f.options.readNative = async (executable, args) => {
    expect(executable).toBe(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
    const script = Buffer.from(args.at(-1), "base64").toString("utf16le");
    expect(script).not.toContain("CommandLine");
    expect(script).toContain(
      "-Property ProcessId,ParentProcessId,Name,CreationDate",
    );
    return { stdout: JSON.stringify(f.raw) };
  };
  await captureWindowsHost(f.options);
});

test.each([
  ["at preparation expiry", 1020, 1050, false],
  ["after preparation expiry", 1021, 1050, false],
  ["past preparation expiry", 1000, 1021, false],
  ["ending exactly at preparation expiry", 1000, 1020, true],
])(
  "proof %s respects the complete preparation lifetime",
  async (_label, now, validUntil, accepted) => {
    const f = fixture();
    f.preparation.validUntil = 1020;
    const ref = await captureWindowsHost(f.options);
    const store = createPreparationCapture({
      ...f.f.options,
      preparation: f.preparation,
    });
    const capture = await store.readCapture(ref);
    const verify = () =>
      verifyWindowsQuiescence({
        preparation: f.preparation,
        host: f.host,
        capture,
        now,
        validUntil,
        maxAge: 60,
      });
    if (accepted)
      expect(verify()).toEqual({ hostName: "OPERATOR", writers: [] });
    else expect(verify).toThrow();
  },
);

test.each(["PutObjectCommand", "GetObjectCommand"])(
  "committed capture with lost %s response preserves safe reconciliation instructions",
  async (lostResponse) => {
    const f = fixture();
    const send = f.options.s3.send;
    const secret = "PROVIDER_SECRET_SENTINEL";
    f.options.s3.send = async (command) => {
      const result = await send(command);
      if (command.constructor.name === lostResponse) throw new Error(secret);
      return result;
    };
    let failure;
    try {
      await captureWindowsHost(f.options);
    } catch (error) {
      failure = error;
    }
    expect(failure?.message).toBe(
      "UNKNOWN: private capture acknowledgment; read-only reconciliation required; do not retry",
    );
    expect(String(failure)).not.toContain(secret);
    expect(f.f.objects.size).toBe(1);
    expect(
      f.f.calls.filter(
        (command) => command.constructor.name === "PutObjectCommand",
      ),
    ).toHaveLength(1);
  },
);
