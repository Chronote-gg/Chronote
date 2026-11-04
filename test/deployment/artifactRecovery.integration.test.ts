import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import { pipeline } from "node:stream/promises";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCleanupAuthorization } from "../../src/services/artifactCleanupAuthorization";
import {
  createCleanupReceipt,
  reconcileCleanupReceipt,
} from "../../src/services/artifactCleanupReceipt";
import { inventoryLocalArtifacts } from "../../src/services/localArtifactInventory";
import { createRuntimeArtifactStorage } from "../../src/services/runtimeArtifactStorage";
import { createArtifactProducerRegistry } from "../../src/services/artifactProducerRegistry";
import { history } from "./controlFixtures";

// This disk-backed loopback server exercises real SDK transport, not AWS IAM or S3's implementation.
let root: string;
let storage: typeof import("../../src/services/storageService");
const server = createServer((request, response) => {
  void serve(request, response).catch(() => {
    response.writeHead(500);
    response.end();
  });
});
function objectPath(url: string) {
  return path.join(
    root,
    "objects",
    createHash("sha256")
      .update(new URL(url, "http://localhost").pathname)
      .digest("hex"),
  );
}
async function serve(request: IncomingMessage, response: ServerResponse) {
  const filename = objectPath(request.url!);
  if (request.method === "PUT") {
    await pipeline(request, createWriteStream(filename, { flags: "wx" }));
    response.writeHead(200, { "x-amz-version-id": "v1" });
    response.end();
    return;
  }
  try {
    await fs.access(filename);
  } catch {
    response.writeHead(404, { "content-type": "application/xml" });
    response.end("<Error><Code>NoSuchKey</Code></Error>");
    return;
  }
  response.writeHead(200, {
    "content-length": (await fs.stat(filename)).size,
    "x-amz-version-id": "v1",
  });
  await pipeline(createReadStream(filename, { highWaterMark: 4096 }), response);
}
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), "chronote-replacement-"));
  await fs.mkdir(path.join(root, "objects"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Loopback listener missing");
  Object.assign(process.env, {
    STORAGE_ENDPOINT: `http://127.0.0.1:${address.port}`,
    STORAGE_FORCE_PATH_STYLE: "true",
    STORAGE_ACCESS_KEY_ID: "dummy",
    STORAGE_SECRET_ACCESS_KEY: "dummy",
    TRANSCRIPTS_BUCKET: "fixture",
  });
  storage = await import("../../src/services/storageService");
});
afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
  if (
    path.dirname(root) !== path.resolve(tmpdir()) ||
    !path.basename(root).startsWith("chronote-replacement-")
  )
    throw new Error("Unexpected fixture root");
  await fs.rm(root, { recursive: true, force: true });
});
async function fixture() {
  const roots = {
    working: path.join(root, randomUUID()),
    retained: path.join(root, randomUUID()),
  };
  const directory = path.join(roots.working, "m", "meeting");
  await fs.mkdir(directory, { recursive: true });
  const bytes = Buffer.alloc(96_000);
  for (let i = 0; i < bytes.length / 2; i++)
    bytes.writeInt16LE(
      Math.round(Math.sin((i * 2 * Math.PI * 440) / 48_000) * 5000),
      i * 2,
    );
  const key = randomUUID() + "/audio.pcm";
  const saved = {
    ...history,
    status: "complete" satisfies "complete",
    audioS3Key: key,
  };
  const reference = await storage.uploadVerifiedObjectToS3(
    key,
    bytes,
    "application/octet-stream",
    { immutable: true },
  );
  if (!reference) throw new Error("Generated artifact was not acknowledged");
  const filename = path.join(directory, "audio.pcm");
  await fs.writeFile(filename, bytes);
  const inventory = await inventoryLocalArtifacts(directory);
  await createCleanupReceipt(directory, {
    version: 1,
    owner: {
      guildId: saved.guildId,
      meetingId: saved.meetingId,
      ownerInstanceId: "old",
      executionVersion: 1,
    },
    historyKey: saved.channelId_timestamp,
    createdAt: new Date().toISOString(),
    files: inventory.files,
    producers: [
      {
        path: "audio.pcm",
        state: "known",
        provenance: { kind: "stored_input" },
      },
    ],
    storedArtifacts: [reference],
    checkpoint: null,
    decision: "complete",
  });
  const authorize = createCleanupAuthorization({
    repository: { getMeetingHistory: async () => ({ ...saved }) },
    checkpoints: {
      read: async () => {
        throw new Error("Unexpected legacy checkpoint");
      },
    },
    verifyStoredArtifact: storage.verifyStoredArtifact,
  });
  const runtimeStorage = createRuntimeArtifactStorage({
    roots,
    producers: createArtifactProducerRegistry(),
    cleanup: { seal: async () => undefined, resume: () => undefined },
    authorize,
  });
  return {
    directory,
    filename,
    bytes,
    key,
    reference,
    authorize,
    runtimeStorage,
  };
}
test("generated bytes remain recoverable after the source directory is removed", async () => {
  const f = await fixture();
  const proof = await f.runtimeStorage.seal();
  expect(proof.pendingDirectories).toBe(1);
  await f.runtimeStorage.recheck(proof);
  if (!f.directory.startsWith(root + path.sep))
    throw new Error("Unexpected source fixture");
  await fs.rm(f.directory, { recursive: true });
  const recovered = await storage.fetchObjectBytesFromS3(f.key);
  expect(recovered && Buffer.from(recovered).equals(f.bytes)).toBe(true);
  await expect(
    storage.verifyStoredArtifact(f.reference),
  ).resolves.toBeUndefined();
});
test("failed deletion remains safe, and a fresh cleanup retries the exact retained bytes", async () => {
  const f = await fixture();
  const unlink = fs.unlink.bind(fs);
  const failure = jest
    .spyOn(fs, "unlink")
    .mockImplementation(async (filename) => {
      if (filename === f.filename) throw new Error("Injected disk refusal");
      await unlink(filename);
    });
  try {
    expect(
      (await reconcileCleanupReceipt(f.directory, { authorize: f.authorize }))
        .kind,
    ).toBe("pending");
  } finally {
    failure.mockRestore();
  }
  expect((await f.runtimeStorage.seal()).pendingDirectories).toBe(1);
  expect(
    (await reconcileCleanupReceipt(f.directory, { authorize: f.authorize }))
      .kind,
  ).toBe("cleaned");
  expect(await fs.readdir(f.directory)).toEqual([]);
});
test.each(["missing_object", "corrupt_object", "changed_local"])(
  "%s blocks replacement and preserves local input",
  async (reason) => {
    const f = await fixture();
    if (reason === "missing_object")
      await fs.unlink(objectPath("/fixture/" + f.key));
    if (reason === "corrupt_object")
      await fs.writeFile(objectPath("/fixture/" + f.key), "corrupt");
    if (reason === "changed_local")
      await fs.appendFile(f.filename, "new unique bytes");
    await expect(f.runtimeStorage.seal()).rejects.toThrow();
    await expect(fs.access(f.filename)).resolves.toBeUndefined();
  },
);
