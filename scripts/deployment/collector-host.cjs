"use strict";
const assert = require("node:assert/strict");
const process = require("node:process");
const { z } = require("zod");
const { executeChild } = require("./owned-child.cjs");
const { createPreparationCapture } = require("./private-capture.cjs");
const { metadataDigest } = require("./production-work.cjs");
const writerExecutables = ["cmd.exe", "node.exe", "powershell.exe", "pwsh.exe"];
const hostSchema = z
  .object({
    hostName: z.string().regex(/^[A-Za-z0-9-]{1,63}$/),
    readerSid: z.string().regex(/^S-1-[0-9-]+$/),
    bootAt: z.string().datetime(),
    window: z
      .object({
        authorityId: z.string().regex(/^[A-Za-z0-9-]{1,128}$/),
        notBefore: z.number().nonnegative(),
        validUntil: z.number().positive(),
      })
      .strict(),
    writerExecutables: z.array(z.enum(writerExecutables)).length(4),
  })
  .strict();
const rowSchema = z
  .object({
    pid: z.number().int().nonnegative(),
    parentPid: z.number().int().nonnegative(),
    name: z.string().regex(/^[A-Za-z0-9_. -]{1,256}$/),
    createdAt: z.string().datetime().nullable(),
  })
  .strict();
const nativeScript = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$os = Get-CimInstance -ClassName Win32_OperatingSystem
$rows = @(Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,Name,CreationDate | ForEach-Object {
  [ordered]@{ pid=[int]$_.ProcessId; parentPid=[int]$_.ParentProcessId; name=$_.Name;
    createdAt=$(if ($null -ne $_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { $null });
  }
})
[ordered]@{ hostName=$os.CSName; bootAt=$os.LastBootUpTime.ToUniversalTime().ToString('o');
  readerSid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;
  readerPid=$PID; processes=$rows } | ConvertTo-Json -Depth 5 -Compress
`;
function hostBinding(host) {
  const parsed = hostSchema.parse(host);
  assert.deepEqual([...parsed.writerExecutables].sort(), writerExecutables);
  return parsed;
}
function processRows(raw) {
  assert.ok(Array.isArray(raw.processes) && raw.processes.length <= 100000);
  return raw.processes.map((row) =>
    rowSchema.parse({
      pid: row.pid,
      parentPid: row.parentPid,
      name: row.name,
      createdAt: row.createdAt,
    }),
  );
}
function assertAncestry(index) {
  const resolved = new Set([0, 4]);
  for (const row of index.values()) {
    const chain = new Set();
    let pid = row.pid;
    while (!resolved.has(pid)) {
      assert.ok(!chain.has(pid), "UNKNOWN: cyclic process ancestry");
      chain.add(pid);
      const current = index.get(pid);
      assert.ok(current, "UNKNOWN: orphan process ancestry");
      pid = current.parentPid;
    }
    for (const ancestor of chain) resolved.add(ancestor);
  }
}
function assertProcessTree(rows, readerPid, collectorPid) {
  const index = new Map(rows.map((row) => [row.pid, row]));
  assert.equal(index.size, rows.length);
  assertAncestry(index);
  assert.notEqual(readerPid, collectorPid);
  const reader = index.get(readerPid),
    collector = index.get(collectorPid);
  assert.equal(reader?.parentPid, collectorPid);
  assert.equal(reader?.name.toLowerCase(), "powershell.exe");
  assert.equal(collector?.name.toLowerCase(), "node.exe");
  for (const row of rows) {
    if ([0, 4].includes(row.pid)) continue;
    const parent = index.get(row.parentPid);
    assert.ok(parent, "UNKNOWN: orphan process ancestry");
    assert.ok(row.createdAt);
    if (parent.createdAt)
      assert.ok(Date.parse(parent.createdAt) <= Date.parse(row.createdAt));
    if (row.pid === readerPid || row.pid === collectorPid) continue;
    assert.ok(
      !writerExecutables.includes(row.name.toLowerCase()),
      "UNKNOWN: active or opaque script host",
    );
    assert.ok(
      ![readerPid, collectorPid].includes(row.parentPid),
      "UNKNOWN: collector descendant",
    );
  }
}
function verifyWindowsQuiescence({
  preparation,
  host,
  capture,
  now,
  validUntil,
  maxAge,
}) {
  const selected = hostBinding(host);
  assert.equal(capture.kind, "windows-cim-zero-writers-v1");
  assert.deepEqual(capture.preparation, preparation);
  assert.ok(now < preparation.validUntil);
  assert.ok(validUntil <= preparation.validUntil);
  assert.equal(capture.hostSha256, metadataDigest(selected));
  assert.equal(capture.hostName, selected.hostName);
  assert.equal(capture.readerSid, selected.readerSid);
  assert.equal(capture.bootAt, selected.bootAt);
  assert.ok(capture.observedAt <= now && now - capture.observedAt <= maxAge);
  assert.ok(
    selected.window.notBefore <= capture.startedAt &&
      capture.startedAt <= capture.observedAt,
  );
  assert.ok(selected.window.validUntil >= validUntil && validUntil > now);
  assert.equal(capture.processCount, capture.processes.length);
  const rows = capture.processes.map((row) => rowSchema.parse(row));
  assertProcessTree(rows, capture.readerPid, capture.collectorPid);
  assert.equal(capture.projectionSha256, metadataDigest(rows));
  return { hostName: selected.hostName, writers: [] };
}
async function captureWindowsHost(options) {
  const { preparation, storageBinding, s3, host } = options;
  const now = options.now ?? (() => Date.now() / 1000);
  const startedAt = now();
  let store, capture;
  try {
    assert.equal(options.platform ?? process.platform, "win32");
    const selected = hostBinding(host);
    store = createPreparationCapture({
      preparation,
      binding: storageBinding,
      client: s3,
      now,
    });
    assert.ok(
      selected.window.notBefore <= startedAt &&
        startedAt < selected.window.validUntil,
    );
    const remaining =
      Math.min(preparation.validUntil, selected.window.validUntil) * 1000 -
      startedAt * 1000;
    assert.ok(remaining > 0);
    const result = await (options.readNative ?? executeChild)(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(nativeScript, "utf16le").toString("base64"),
      ],
      {
        windowsHide: true,
        maxBuffer: 16777216,
        signal: AbortSignal.timeout(Math.min(30000, Math.ceil(remaining))),
        killSignal: "SIGKILL",
      },
    );
    const raw = JSON.parse(result.stdout),
      rows = processRows(raw);
    capture = {
      kind: "windows-cim-zero-writers-v1",
      preparation,
      hostSha256: metadataDigest(selected),
      hostName: raw.hostName,
      readerSid: raw.readerSid,
      bootAt: raw.bootAt,
      readerPid: raw.readerPid,
      collectorPid: process.pid,
      startedAt,
      observedAt: now(),
      processCount: rows.length,
      projectionSha256: metadataDigest(rows),
      processes: rows,
    };
    verifyWindowsQuiescence({
      preparation,
      host: selected,
      capture,
      now: now(),
      validUntil: Math.min(preparation.validUntil, selected.window.validUntil),
      maxAge: 30,
    });
  } catch {
    throw new Error(
      "UNKNOWN: fixed Windows native quiescence prerequisite unavailable",
    );
  }
  return store.capture(capture);
}
module.exports = { captureWindowsHost, verifyWindowsQuiescence };
