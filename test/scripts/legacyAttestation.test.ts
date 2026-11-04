/** @jest-environment node */
import { createHash } from "node:crypto";
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

function legacyFixture() {
  const f = fixture();
  f.state.artifacts.delete("old");
  f.state.artifactAutoSeal = false;
  const body = Buffer.from(
    JSON.stringify({
      source: "/app/tmp/meetings",
      capturedAt: new Date(900_000).toISOString(),
      layout: "files/<path>",
      files,
    }),
  );
  const objects = new Map<string, Head>(
    files.map((file) => [
      "recovery/files/" + file.path,
      {
        ContentLength: file.bytes,
        ChecksumSHA256: Buffer.from(file.sha256, "hex").toString("base64"),
      },
    ]),
  );
  const s3 = jest.fn(async (name: string, input: unknown) => {
    const { Key } = input as { Key: string };
    if (name === "GetObject" && Key === "recovery/inventory.json")
      return { Body: { transformToByteArray: async () => body } };
    const head = objects.get(Key);
    if (name === "HeadObject" && head) return head;
    throw new Error("NoSuchKey");
  });
  f.state.s3 = s3;
  const writes = () =>
    f.calls.filter((call) => call.operation === "transact-write-items").length;
  return { ...f, body, objects, s3, writes };
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
    Key: "recovery/files/m/meeting-a/t/track.pcm",
    ChecksumMode: "ENABLED",
  });
});

test.each([
  ["size", /differs/],
  ["checksum", /differs/],
  ["missing", /missing/],
  ["recording", /recording/],
  ["pending_admission", /admitting/],
  ["newer lease", /after its backup/],
  ["modern row", /runtime protocol/],
])("attestation refuses %s without writing", async (reason, message) => {
  const f = legacyFixture();
  const head = f.objects.get("recovery/files/" + files[1].path)!;
  if (reason === "size") head.ContentLength = 6;
  if (reason === "checksum") head.ChecksumSHA256 = "AAAA";
  if (reason === "missing") f.objects.delete("recovery/files/" + files[0].path);
  if (reason === "recording") f.state.rows.old.workCounts = counts(1);
  if (reason === "pending_admission")
    f.state.rows.old.workCounts = { ...counts(), pending_admission: 1 };
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

test.each([
  ["pending_admission", /quiet serving runtime/, "attested_legacy"],
  ["lease", /after its backup/, "requested"],
])(
  "legacy prepare refuses when %s changed after attestation",
  async (change, message, state) => {
    const f = legacyFixture();
    await f.coordinator.attestPreservation();
    if (change === "lease")
      f.state.leases.push({
        ownerInstanceId: "old",
        createdAt: new Date(1_000_000).toISOString(),
      });
    else f.state.rows.old.workCounts = { ...counts(), pending_admission: 1 };
    await expect(f.coordinator.prepare()).rejects.toThrow(message);
    expect(f.state.launched).toBe(false);
    expect(f.state.artifacts.get("old")?.state).toBe(state);
    await expect(f.coordinator.cancelPreparation()).resolves.toEqual({
      kind: "cancelled",
    });
    expect(f.state.artifacts.get("old")?.state).toBe("attested_legacy");
    expect(f.state.ctl.deployment?.phase).toBe("complete");
  },
);

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
