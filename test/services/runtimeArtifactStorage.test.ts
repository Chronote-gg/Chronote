/** @jest-environment node */
import { promises as fs } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { createRuntimeArtifactStorage } from "../../src/services/runtimeArtifactStorage";
import { createArtifactProducerRegistry } from "../../src/services/artifactProducerRegistry";
import { createCleanupReceipt } from "../../src/services/artifactCleanupReceipt";
import { inventoryLocalArtifacts } from "../../src/services/localArtifactInventory";
import type {
  ArtifactAuthority,
  ArtifactCleanupReceipt,
} from "../../src/types/artifactCleanup";

let directory: string;
const owner = {
  guildId: "guild",
  meetingId: "meeting",
  ownerInstanceId: "worker",
  executionVersion: 1,
};
const authority: ArtifactAuthority = {
  owner,
  historyKey: "channel_time",
  checkpoint: null,
  status: "complete",
  completionDecision: "proceed",
  audioS3Key: "stored",
  chatS3Key: null,
  transcriptS3Key: null,
};
beforeEach(async () => {
  directory = await fs.mkdtemp(
    path.join(tmpdir(), "chronote-runtime-artifacts-"),
  );
});
afterEach(async () => {
  if (
    path.dirname(directory) !== path.resolve(tmpdir()) ||
    !path.basename(directory).startsWith("chronote-runtime-artifacts-")
  )
    throw new Error("Unexpected cleanup target");
  await fs.rm(directory, { recursive: true, force: true });
});
function fixture() {
  const roots = {
    working: path.join(directory, "working"),
    retained: path.join(directory, "retained"),
  };
  const producers = createArtifactProducerRegistry();
  const cleanup = { seal: jest.fn(async () => {}), resume: jest.fn() };
  const authorize = jest.fn(async () => authority);
  const storage = createRuntimeArtifactStorage({
    roots,
    producers,
    cleanup,
    authorize,
  });
  return { roots, producers, cleanup, authorize, storage };
}
async function preservedReceipt(root: string) {
  const meetingDirectory = path.join(root, "m", "meeting");
  await fs.mkdir(meetingDirectory, { recursive: true });
  await fs.writeFile(path.join(meetingDirectory, "input"), "stored bytes");
  const inventory = await inventoryLocalArtifacts(meetingDirectory);
  const receipt: ArtifactCleanupReceipt = {
    version: 1,
    owner,
    historyKey: authority.historyKey,
    createdAt: "2026-11-03T12:00:00Z",
    files: inventory.files,
    producers: [
      { path: "input", state: "known", provenance: { kind: "stored_input" } },
    ],
    storedArtifacts: inventory.files.map(({ checksumSha256, byteLength }) => ({
      key: "stored",
      checksumSha256,
      byteLength,
      versionId: "v1",
    })),
    checkpoint: null,
    decision: "complete",
  };
  await createCleanupReceipt(meetingDirectory, receipt);
  return meetingDirectory;
}
test("empty roots yield a sealed exact proof and explicit resume restores producer admission", async () => {
  const f = fixture();
  const proof = await f.storage.seal();
  expect(proof).toMatchObject({
    fileCount: 0,
    byteLength: 0,
    pendingDirectories: 0,
    authorities: [],
  });
  expect(f.cleanup.seal).toHaveBeenCalled();
  expect(() => f.producers.claim({ directory, owner })).toThrow("sealed");
  f.storage.resume();
  expect(f.cleanup.resume).toHaveBeenCalled();
  expect(f.producers.claim({ directory, owner })).toBeDefined();
});
test("unknown files refuse a proof and remain untouched", async () => {
  const f = fixture();
  await fs.mkdir(f.roots.retained);
  const filename = path.join(f.roots.retained, "unknown.pcm");
  await fs.writeFile(filename, "only copy");
  await expect(f.storage.seal()).rejects.toThrow();
  expect(await fs.readFile(filename, "utf8")).toBe("only copy");
});
test("verified deletion obligations can be safe without falsely reporting local deletion", async () => {
  const f = fixture();
  const meetingDirectory = await preservedReceipt(f.roots.working);
  const proof = await f.storage.seal();
  expect(proof).toMatchObject({
    fileCount: 2,
    pendingDirectories: 1,
    authorities: [authority],
  });
  expect(await fs.readFile(path.join(meetingDirectory, "input"), "utf8")).toBe(
    "stored bytes",
  );
  await expect(f.storage.recheck(proof)).resolves.toEqual(proof);
  await fs.writeFile(
    path.join(meetingDirectory, "new.pcm"),
    "new unique bytes",
  );
  await expect(f.storage.recheck(proof)).rejects.toThrow();
});
test("a writer still owning actual I/O cannot produce a seal", async () => {
  const f = fixture();
  const producer = f.producers.claim({ directory: f.roots.working, owner });
  const write = producer.beginWrite(path.join(f.roots.working, "input"), {
    kind: "stored_input",
  });
  await expect(f.storage.seal()).rejects.toThrow();
  expect(f.cleanup.seal).not.toHaveBeenCalled();
  write.settle("known");
});

test("a cancelled preparation cannot finish sealing after admission has explicitly resumed", async () => {
  const f = fixture();
  let finish!: () => void;
  f.cleanup.seal.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const preparation = f.storage.seal();
  await Promise.resolve();
  f.storage.resume();
  const producer = f.producers.claim({ directory: f.roots.working, owner });
  const write = producer.beginWrite(path.join(f.roots.working, "future"), {
    kind: "stored_input",
  });
  const rejected = expect(preparation).rejects.toThrow();
  finish();
  await rejected;
  write.settle("known");
});
