/** @jest-environment node */
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createCleanupReceipt,
  reconcileCleanupReceipt,
  CLEANUP_RECEIPT_FILENAME,
} from "../../src/services/artifactCleanupReceipt";
import { inventoryLocalArtifacts } from "../../src/services/localArtifactInventory";

let directory: string;
const owner = {
  guildId: "guild",
  meetingId: "meeting",
  ownerInstanceId: "worker",
  executionVersion: 1,
};
beforeEach(async () => {
  directory = await fs.mkdtemp(
    path.join(tmpdir(), "chronote-cleanup-receipt-"),
  );
  await fs.writeFile(path.join(directory, "audio.pcm"), "original");
});
afterEach(async () => {
  if (
    path.dirname(directory) !== path.resolve(tmpdir()) ||
    !path.basename(directory).startsWith("chronote-cleanup-receipt-")
  )
    throw new Error("Unexpected cleanup target");
  await fs.rm(directory, { recursive: true, force: true });
});

async function receipt() {
  const inventory = await inventoryLocalArtifacts(directory);
  return createCleanupReceipt(directory, {
    version: 1,
    owner,
    historyKey: "channel_timestamp",
    createdAt: "2026-11-03T12:00:00Z",
    files: inventory.files,
    producers: inventory.files.map((file) => ({
      path: file.path,
      state: "known",
      provenance: { kind: "stored_input" },
    })),
    storedArtifacts: [],
    checkpoint: null,
    decision: "complete",
  });
}

test("recreated reconciler verifies authority before deleting exact remaining files", async () => {
  await fs.writeFile(path.join(directory, "two"), "second");
  const saved = await receipt();
  await fs.unlink(path.join(directory, "two"));
  const authorize = jest.fn(async () => undefined);
  expect(await reconcileCleanupReceipt(directory, { authorize })).toEqual({
    kind: "cleaned",
    removed: 1,
    byteLength: 8,
  });
  expect(authorize).toHaveBeenCalledWith(saved, undefined);
  expect(await fs.readdir(directory)).toEqual([]);
});

test.each(["unknown", "changed", "authority"])(
  "%s refuses cleanup and preserves source bytes",
  async (reason) => {
    await receipt();
    if (reason === "unknown")
      await fs.writeFile(path.join(directory, "unknown"), "unknown");
    if (reason === "changed")
      await fs.writeFile(path.join(directory, "audio.pcm"), "tampered");
    const authorize = async () => {
      if (reason === "authority") throw new Error("Ownership changed");
    };
    expect((await reconcileCleanupReceipt(directory, { authorize })).kind).toBe(
      "blocked",
    );
    expect(await fs.readFile(path.join(directory, "audio.pcm"), "utf8")).toBe(
      reason === "changed" ? "tampered" : "original",
    );
    await expect(
      fs.access(path.join(directory, CLEANUP_RECEIPT_FILENAME)),
    ).resolves.toBeUndefined();
  },
);

test("receipt creation is exclusive and rejects a mismatched inventory", async () => {
  const saved = await receipt();
  await expect(createCleanupReceipt(directory, saved)).rejects.toThrow();
  await fs.unlink(path.join(directory, CLEANUP_RECEIPT_FILENAME));
  await fs.writeFile(path.join(directory, "unknown"), "unknown");
  await expect(createCleanupReceipt(directory, saved)).rejects.toThrow();
  await expect(
    fs.access(path.join(directory, CLEANUP_RECEIPT_FILENAME)),
  ).rejects.toThrow();
});

test("missing or truncated receipt never grants cleanup", async () => {
  const authorize = jest.fn(async () => undefined);
  expect((await reconcileCleanupReceipt(directory, { authorize })).kind).toBe(
    "blocked",
  );
  await fs.writeFile(path.join(directory, CLEANUP_RECEIPT_FILENAME), "{");
  expect((await reconcileCleanupReceipt(directory, { authorize })).kind).toBe(
    "blocked",
  );
  expect(authorize).not.toHaveBeenCalled();
  expect(await fs.readFile(path.join(directory, "audio.pcm"), "utf8")).toBe(
    "original",
  );
});

test("failed unlink retains the receipt and a fresh call retries remaining bytes", async () => {
  await fs.writeFile(path.join(directory, "z.pcm"), "second");
  await receipt();
  const unlink = fs.unlink.bind(fs);
  const failure = jest
    .spyOn(fs, "unlink")
    .mockImplementation(async (filename) => {
      if (filename === path.join(directory, "z.pcm"))
        throw new Error("Disk refused cleanup");
      await unlink(filename);
    });
  const authorize = jest.fn(async () => undefined);
  try {
    expect((await reconcileCleanupReceipt(directory, { authorize })).kind).toBe(
      "pending",
    );
    expect(await fs.readFile(path.join(directory, "z.pcm"), "utf8")).toBe(
      "second",
    );
    await fs.access(path.join(directory, CLEANUP_RECEIPT_FILENAME));
  } finally {
    failure.mockRestore();
  }
  expect(await reconcileCleanupReceipt(directory, { authorize })).toEqual({
    kind: "cleaned",
    removed: 1,
    byteLength: 6,
  });
  expect(authorize).toHaveBeenCalledTimes(2);
});

test("a symlink cannot replace a verified payload", async () => {
  await receipt();
  await fs.unlink(path.join(directory, "audio.pcm"));
  await fs.mkdir(path.join(directory, "target"));
  await fs.writeFile(path.join(directory, "target", "bytes"), "original");
  await fs.symlink(
    path.join(directory, "target"),
    path.join(directory, "audio.pcm"),
    "junction",
  );
  const authorize = jest.fn(async () => undefined);
  expect((await reconcileCleanupReceipt(directory, { authorize })).kind).toBe(
    "blocked",
  );
  expect(authorize).not.toHaveBeenCalled();
  expect(
    await fs.readFile(path.join(directory, "target", "bytes"), "utf8"),
  ).toBe("original");
});
