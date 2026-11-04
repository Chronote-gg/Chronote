/** @jest-environment node */
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  inventoryLocalArtifacts,
  verifyLocalArtifactSubset,
  hashLocalArtifact,
} from "../../src/services/localArtifactInventory";

let directory: string;
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(tmpdir(), "chronote-artifact-proof-"));
});
afterEach(async () => {
  if (
    path.dirname(path.resolve(directory)) !== path.resolve(tmpdir()) ||
    !path.basename(directory).startsWith("chronote-artifact-proof-")
  )
    throw new Error("Unexpected test cleanup target");
  await fs.rm(directory, { recursive: true, force: true });
});

test("inventory hashes actual bytes and relative paths in stable order", async () => {
  await fs.mkdir(path.join(directory, "nested"));
  await fs.writeFile(path.join(directory, "z.txt"), "last");
  await fs.writeFile(path.join(directory, "nested", "first.pcm"), "first");
  const result = await inventoryLocalArtifacts(directory);
  expect(result.files).toEqual([
    {
      path: "nested/first.pcm",
      byteLength: 5,
      checksumSha256: createHash("sha256").update("first").digest("hex"),
    },
    {
      path: "z.txt",
      byteLength: 4,
      checksumSha256: createHash("sha256").update("last").digest("hex"),
    },
  ]);
  expect(result.byteLength).toBe(9);
  expect((await inventoryLocalArtifacts(directory)).digest).toBe(result.digest);
});

test("cleanup retries accept only an unchanged remaining subset", async () => {
  await fs.writeFile(path.join(directory, "one"), "original one");
  await fs.writeFile(path.join(directory, "two"), "original two");
  const original = await inventoryLocalArtifacts(directory);
  await fs.unlink(path.join(directory, "one"));
  const remaining = await verifyLocalArtifactSubset(directory, original.files);
  expect(remaining.files.map((file) => file.path)).toEqual(["two"]);
});

test("same-length changed bytes refuse the original proof", async () => {
  await fs.writeFile(path.join(directory, "audio"), "source");
  const original = await inventoryLocalArtifacts(directory);
  await fs.writeFile(path.join(directory, "audio"), "tamper");
  await expect(
    verifyLocalArtifactSubset(directory, original.files),
  ).rejects.toThrow();
  expect(await fs.readFile(path.join(directory, "audio"), "utf8")).toBe(
    "tamper",
  );
});

test("an unknown added file refuses proof without deleting either file", async () => {
  await fs.writeFile(path.join(directory, "known"), "known");
  const original = await inventoryLocalArtifacts(directory);
  await fs.writeFile(path.join(directory, "unknown"), "retain");
  await expect(
    verifyLocalArtifactSubset(directory, original.files),
  ).rejects.toThrow();
  expect((await fs.readdir(directory)).sort()).toEqual(["known", "unknown"]);
});

test("directory links cannot extend an inventory outside its managed root", async () => {
  const managed = path.join(directory, "managed");
  const outside = path.join(directory, "outside");
  await fs.mkdir(managed);
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "private"), "retain");
  await fs.symlink(outside, path.join(managed, "linked"), "junction");
  await expect(hashLocalArtifact(managed, "linked/private")).rejects.toThrow();
  await expect(inventoryLocalArtifacts(managed)).rejects.toThrow();
  expect(await fs.readFile(path.join(outside, "private"), "utf8")).toBe(
    "retain",
  );
});

test("receipt traversal and duplicate paths cannot authorize cleanup", async () => {
  await fs.writeFile(path.join(directory, "known"), "known");
  const original = await inventoryLocalArtifacts(directory);
  const first = original.files[0];
  await expect(
    verifyLocalArtifactSubset(directory, [{ ...first, path: "../outside" }]),
  ).rejects.toThrow();
  await expect(
    verifyLocalArtifactSubset(directory, [first, first]),
  ).rejects.toThrow();
});

test("a missing new-container directory has a stable empty inventory", async () => {
  const missing = path.join(directory, "new");
  const result = await inventoryLocalArtifacts(missing);
  expect(result.files).toEqual([]);
  expect(result.byteLength).toBe(0);
  expect((await inventoryLocalArtifacts(missing)).digest).toBe(result.digest);
});

test("aborted verification never supplies a proof", async () => {
  const controller = new AbortController();
  controller.abort(new Error("stop"));
  await expect(
    inventoryLocalArtifacts(directory, controller.signal),
  ).rejects.toThrow("stop");
});
