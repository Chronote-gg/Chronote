/** @jest-environment node */
import { createHash } from "node:crypto";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { createCoordinator } from "../../scripts/deployment/coordinator.cjs";
import {
  fixture,
  env,
  counts,
} from "../deployment/fixtures/coordinatorFixture";

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const files = [
  { path: "m/meeting-a/chat.txt", bytes: 3, sha256: sha256("abc") },
  { path: "m/meeting-a/t/track.pcm", bytes: 5, sha256: sha256("audio") },
];
type Head = { ContentLength: number; ChecksumSHA256: string };

const manifestKey = "recovery/task-old/inventory.json";
function legacyFixture(key = manifestKey, source = "/app/tmp/meetings") {
  const f = fixture();
  f.state.artifacts.delete("old");
  f.state.artifactAutoSeal = false;
  const body = Buffer.from(
    JSON.stringify({
      source,
      capturedAt: new Date(900_000).toISOString(),
      layout: "files/<path>",
      files,
    }),
  );
  const objects = new Map<string, Head>(
    files.map((file) => [
      key.slice(0, key.lastIndexOf("/") + 1) + "files/" + file.path,
      {
        ContentLength: file.bytes,
        ChecksumSHA256: Buffer.from(file.sha256, "hex").toString("base64"),
      },
    ]),
  );
  const s3 = jest.fn(async (name: string, input: unknown) => {
    const { Key } = input as { Key: string };
    if (name === "GetObject" && Key === key)
      return { Body: { transformToByteArray: async () => body } };
    const head = objects.get(Key);
    if (name === "HeadObject" && head) return head;
    throw new Error("NoSuchKey");
  });
  f.state.s3 = s3;
  const writes = () =>
    f.calls.filter((call) => call.operation === "transact-write-items").length;
  const attest = () =>
    createCoordinator({
      ...f.options,
      env: { ...env, ATTESTATION_MANIFEST_URI: "s3://backup/" + key },
    }).attestPreservation();
  return { ...f, body, objects, s3, writes, attest };
}
async function stuckPreparation(f: ReturnType<typeof legacyFixture>) {
  await expect(f.coordinator.prepare()).rejects.toThrow(/capability/);
  expect(f.state.ctl.deployment?.phase).toBe("preparing");
  f.state.ctl.coordinatorExpiresAt = 0;
}

test("attests a verified backup of a legacy source with its provenance", async () => {
  const f = legacyFixture();
  f.state.leases.push(
    { ownerInstanceId: "old", createdAt: new Date(800_000).toISOString() },
    { ownerInstanceId: "new", createdAt: new Date(950_000).toISOString() },
  );
  await expect(f.coordinator.attestPreservation()).resolves.toEqual({
    kind: "attested",
    instanceId: "old",
    manifestSha256: sha256(f.body.toString()),
    fileCount: 2,
    byteLength: 8,
    expiresAt: 1000 + 6 * 60 * 60,
  });
  expect(f.state.artifacts.get("old")).toMatchObject({
    state: "attested_legacy",
    revision: 0,
    startup: { kind: "pending" },
    attestation: {
      kind: "operator_attested_legacy",
      operator: "operator",
      reason: "first introduction",
      manifestUri: env.ATTESTATION_MANIFEST_URI,
      capturedAt: 900,
      verifiedAt: 1000,
    },
  });
  expect(f.s3).toHaveBeenCalledWith("HeadObject", {
    Bucket: "backup",
    Key: "recovery/task-old/files/m/meeting-a/t/track.pcm",
    ChecksumMode: "ENABLED",
  });
});

test.each([
  ["size", /differs/],
  ["checksum", /differs/],
  ["missing", /missing/],
  ["recording", /recording/],
  ["newer lease", /after its backup/],
  ["meeting after backup", /not settled/],
  ["unsettled meeting", /not settled/],
  ["modern row", /runtime protocol/],
])("attestation refuses %s without writing", async (reason, message) => {
  const f = legacyFixture();
  const meeting = (timestamp: number, status: string) =>
    f.state.meetings.push({
      ownerInstanceId: "old",
      timestamp: new Date(timestamp).toISOString(),
      status,
      audioS3Key: "audio",
    });
  if (reason === "meeting after backup") meeting(950_000, "complete");
  if (reason === "unsettled meeting") meeting(850_000, "processing");
  const head = f.objects.get("recovery/task-old/files/" + files[1].path)!;
  if (reason === "size") head.ContentLength = 6;
  if (reason === "checksum") head.ChecksumSHA256 = "AAAA";
  if (reason === "missing")
    f.objects.delete("recovery/task-old/files/" + files[0].path);
  if (reason === "recording") f.state.rows.old.workCounts = counts(1);
  if (reason === "newer lease")
    f.state.leases.push({
      ownerInstanceId: "old",
      createdAt: new Date(950_000).toISOString(),
    });
  const modern = fixture().state.artifacts.get("old")!;
  if (reason === "modern row") f.state.artifacts.set("old", modern);
  await expect(f.coordinator.attestPreservation()).rejects.toThrow(message);
  expect(f.writes()).toBe(0);
  expect(f.state.artifacts.get("old")).toBe(
    reason === "modern row" ? modern : undefined,
  );
});

test("cancels a stuck legacy preparation and a later deploy seals from the attestation", async () => {
  const f = legacyFixture();
  await stuckPreparation(f);
  f.state.rows.old.workCounts = { ...counts(), finalization: 6 };
  await f.coordinator.attestPreservation();
  await expect(f.coordinator.cancelPreparation()).resolves.toEqual({
    kind: "cancelled",
  });
  expect(f.state.ctl.deployment?.phase).toBe("complete");
  expect(f.state.launched).toBe(false);
  expect(f.state.artifacts.get("old")).toMatchObject({
    state: "attested_legacy",
    revision: 1,
  });
  f.state.ctl.coordinatorExpiresAt = 0;
  f.refreshProofs();
  const later = createCoordinator({
    ...f.options,
    env: {
      ...env,
      DEPLOYMENT_RUN_TOKEN: "run-3",
      DEPLOYMENT_CANDIDATE_ID: "run-3",
      HANDOFF_QUIET_OVERRIDE: "1",
    },
    warn: () => undefined,
  });
  await expect(later.prepare()).resolves.toEqual({ kind: "warming" });
  expect(f.state.launched).toBe(true);
});

test("legacy prepare seals the attested inventory and consumes it with warming", async () => {
  const f = legacyFixture();
  await f.coordinator.attestPreservation();
  await expect(f.coordinator.prepare()).resolves.toEqual({ kind: "warming" });
  const row = f.state.artifacts.get("old")!;
  expect(row).toMatchObject({
    state: "consumed",
    proof: {
      snapshot: {
        inventoryDigest: sha256(f.body.toString()),
        fileCount: 2,
        byteLength: 8,
        authorities: [],
      },
    },
    attestation: { manifestSha256: sha256(f.body.toString()) },
  });
  expect(f.state.ctl.deployment?.phase).toBe("warming");
  expect(f.state.launched).toBe(true);
  expect(f.writes()).toBe(4);
});

test("legacy prepare refuses when a lease appeared after attestation", async () => {
  const f = legacyFixture();
  await f.coordinator.attestPreservation();
  f.state.leases.push({
    ownerInstanceId: "old",
    createdAt: new Date(1_000_000).toISOString(),
  });
  await expect(f.coordinator.prepare()).rejects.toThrow(/after its backup/);
  expect(f.state.launched).toBe(false);
  expect(f.state.artifacts.get("old")?.state).toBe("requested");
  await expect(f.coordinator.cancelPreparation()).resolves.toEqual({
    kind: "cancelled",
  });
  expect(f.state.artifacts.get("old")?.state).toBe("attested_legacy");
  expect(f.state.ctl.deployment?.phase).toBe("complete");
});

test("legacy prepare refuses a source that started recording after attestation", async () => {
  const f = legacyFixture();
  await f.coordinator.attestPreservation();
  f.state.rows.old.workCounts = counts(1);
  await expect(f.coordinator.prepare()).rejects.toThrow(/quiet/);
  expect(f.state.launched).toBe(false);
  expect(f.state.artifacts.get("old")?.state).toBe("attested_legacy");
});

test("legacy cancellation refuses once a candidate task exists", async () => {
  const f = legacyFixture();
  await stuckPreparation(f);
  await f.coordinator.attestPreservation();
  f.state.launched = true;
  await expect(f.coordinator.cancelPreparation()).rejects.toThrow(
    /candidate task/,
  );
  expect(f.state.ctl.deployment?.phase).toBe("preparing");
});

test("attestation binds the manifest to the source task path or instance id", async () => {
  await expect(
    legacyFixture("recovery/task-other/inventory.json").attest(),
  ).rejects.toThrow(/not bound/);
  await expect(
    legacyFixture("recovery/next/inventory.json", "old").attest(),
  ).resolves.toMatchObject({ kind: "attested" });
});

test("settled and pre-window meetings do not block attestation", async () => {
  const f = legacyFixture();
  f.state.meetings.push(
    {
      ownerInstanceId: "old",
      timestamp: new Date(850_000).toISOString(),
      status: "complete",
      audioS3Key: "audio",
    },
    {
      ownerInstanceId: "old",
      timestamp: new Date(900_000 - 7_300_000).toISOString(),
      status: "processing",
    },
  );
  await expect(f.coordinator.attestPreservation()).resolves.toMatchObject({
    kind: "attested",
  });
});

test("a fluctuating pending admission count is tolerated through launch", async () => {
  const f = legacyFixture();
  f.state.rows.old.workCounts = { ...counts(), pending_admission: 1 };
  await f.coordinator.attestPreservation();
  expect(f.state.artifacts.get("old")?.attestation?.pendingAdmission).toBe(1);
  f.state.rows.old.workCounts = { ...counts(), pending_admission: 0 };
  await expect(f.coordinator.prepare()).resolves.toEqual({ kind: "warming" });
});

test("attesting a source mid-preparation points at cancel-preparation", async () => {
  const f = legacyFixture();
  await f.coordinator.attestPreservation();
  f.state.leases.push({
    ownerInstanceId: "old",
    createdAt: new Date(1_000_000).toISOString(),
  });
  await expect(f.coordinator.prepare()).rejects.toThrow(/after its backup/);
  await expect(f.coordinator.attestPreservation()).rejects.toThrow(
    /run cancel-preparation first/,
  );
});

test("a manifest changed after attestation refuses the seal", async () => {
  const f = legacyFixture();
  await f.coordinator.attestPreservation();
  const original = f.s3.getMockImplementation()!;
  f.s3.mockImplementation(async (name, input) =>
    name === "GetObject"
      ? { Body: { transformToByteArray: async () => Buffer.from("{}") } }
      : original(name, input),
  );
  await expect(f.coordinator.prepare()).rejects.toThrow(/malformed|changed/);
  expect(f.state.artifacts.get("old")?.state).toBe("requested");
});

/** Fails the first consume write once and counts every consume attempt. */
function loseFirstConsume(f: ReturnType<typeof legacyFixture>) {
  const original = f.aws.getMockImplementation()!;
  const attempts = { consume: 0 };
  f.aws.mockImplementation(async (service, operation, input) => {
    const put = (input as { TransactItems?: Array<{ Put?: { Item: never } }> })
      .TransactItems?.[0]?.Put;
    if (put && unmarshall(put.Item).state === "consumed") {
      attempts.consume++;
      if (attempts.consume === 1) throw new Error("transient failure");
    }
    return original(service, operation, input);
  });
  return attempts;
}

test("a resumed unexpired attested seal rechecks the guard before consuming", async () => {
  const f = legacyFixture();
  await f.coordinator.attestPreservation();
  const attempts = loseFirstConsume(f);
  await expect(f.coordinator.prepare()).rejects.toThrow(/AWS operation failed/);
  expect(f.state.artifacts.get("old")?.state).toBe("sealed");
  f.state.leases.push({
    ownerInstanceId: "old",
    createdAt: new Date(1_000_000).toISOString(),
  });
  await expect(f.coordinator.prepare()).rejects.toThrow(/after its backup/);
  expect(f.state.artifacts.get("old")?.state).toBe("sealed");
  expect(attempts.consume).toBe(1);
});

test("a lapsed attested seal is renewed after a lost consume", async () => {
  const f = legacyFixture();
  await f.coordinator.attestPreservation();
  loseFirstConsume(f);
  await expect(f.coordinator.prepare()).rejects.toThrow(/AWS operation failed/);
  expect(f.state.artifacts.get("old")?.state).toBe("sealed");
  f.state.rows.old.heartbeatAt = 1100;
  const later = createCoordinator({ ...f.options, now: () => 1100 });
  await expect(later.prepare()).resolves.toEqual({ kind: "warming" });
  expect(f.state.artifacts.get("old")).toMatchObject({
    state: "consumed",
    proof: { provenAt: 1100 },
  });
});
