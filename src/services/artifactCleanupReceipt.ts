import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import {
  artifactCleanupReceiptSchema,
  type ArtifactCleanupReceipt,
} from "../types/artifactCleanup";
import { type LocalArtifact } from "../types/localArtifact";
import {
  hashLocalArtifact,
  inventoryLocalArtifacts,
} from "./localArtifactInventory";

export const CLEANUP_RECEIPT_FILENAME = ".chronote-cleanup.json";
const MAX_RECEIPT_BYTES = 8 * 1024 * 1024;

function requireSubset(current: LocalArtifact[], original: LocalArtifact[]) {
  const expected = new Map(original.map((file) => [file.path, file]));
  for (const file of current) {
    if (!isDeepStrictEqual(file, expected.get(file.path)))
      throw new Error("Cleanup inventory changed");
  }
}

export async function createCleanupReceipt(
  directory: string,
  input: ArtifactCleanupReceipt,
): Promise<ArtifactCleanupReceipt> {
  const receipt = artifactCleanupReceiptSchema.parse(input);
  if (receipt.files.some((file) => file.path === CLEANUP_RECEIPT_FILENAME))
    throw new Error("Cleanup receipt cannot authorize its own deletion");
  const inventory = await inventoryLocalArtifacts(directory);
  requireSubset(inventory.files, receipt.files);
  if (inventory.files.length !== receipt.files.length)
    throw new Error("Cleanup receipt requires the exact original inventory");
  const bytes = Buffer.from(JSON.stringify(receipt));
  if (bytes.length > MAX_RECEIPT_BYTES)
    throw new Error("Cleanup receipt exceeds its bound");
  const handle = await fs.open(
    path.join(directory, CLEANUP_RECEIPT_FILENAME),
    "wx",
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return receipt;
}

async function readReceipt(directory: string) {
  const before = await hashLocalArtifact(
    directory,
    CLEANUP_RECEIPT_FILENAME,
    undefined,
    MAX_RECEIPT_BYTES,
  );
  if (before.byteLength > MAX_RECEIPT_BYTES)
    throw new Error("Cleanup receipt exceeds its bound");
  const handle = await fs.open(
    path.join(directory, CLEANUP_RECEIPT_FILENAME),
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  let bytes: Buffer;
  try {
    bytes = Buffer.alloc(before.byteLength + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (!result.bytesRead) break;
      offset += result.bytesRead;
    }
    if (offset !== before.byteLength)
      throw new Error("Cleanup receipt changed");
    bytes = bytes.subarray(0, offset);
  } finally {
    await handle.close();
  }
  const after = await hashLocalArtifact(
    directory,
    CLEANUP_RECEIPT_FILENAME,
    undefined,
    MAX_RECEIPT_BYTES,
  );
  if (
    !isDeepStrictEqual(before, after) ||
    createHash("sha256").update(bytes).digest("hex") !== before.checksumSha256
  )
    throw new Error("Cleanup receipt changed");
  return {
    reference: before,
    receipt: artifactCleanupReceiptSchema.parse(
      JSON.parse(bytes.toString("utf8")),
    ),
  };
}

export type CleanupReceiptResult =
  | { kind: "cleaned"; removed: number; byteLength: number }
  | {
      kind: "pending";
      removed: number;
      byteLength: number;
      error: unknown;
      createdAt: string;
      remainingBytes: number;
      remainingFiles: number;
    }
  | { kind: "blocked"; error: unknown };

export async function verifyCleanupReceipt<T>(
  directory: string,
  dependencies: {
    authorize(
      receipt: ArtifactCleanupReceipt,
      signal?: AbortSignal,
    ): Promise<T>;
  },
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const { receipt, reference } = await readReceipt(directory);
  const inventory = await inventoryLocalArtifacts(directory, signal);
  const files = inventory.files.filter(
    (file) => file.path !== CLEANUP_RECEIPT_FILENAME,
  );
  requireSubset(files, receipt.files);
  const authority = await dependencies.authorize(receipt, signal);
  return { receipt, reference, inventory, files, authority };
}

export async function reconcileCleanupReceipt(
  directory: string,
  dependencies: {
    authorize(
      receipt: ArtifactCleanupReceipt,
      signal?: AbortSignal,
    ): Promise<unknown>;
  },
  signal?: AbortSignal,
): Promise<CleanupReceiptResult> {
  let removed = 0;
  let byteLength = 0;
  try {
    const { receipt, reference, inventory, files } = await verifyCleanupReceipt(
      directory,
      dependencies,
      signal,
    );
    const pending = (error: unknown): CleanupReceiptResult => ({
      kind: "pending",
      removed,
      byteLength,
      error,
      createdAt: receipt.createdAt,
      remainingBytes: inventory.byteLength - byteLength,
      remainingFiles: files.length - removed + 1,
    });
    // The caller must close producers and retain exclusive cleanup ownership throughout.
    for (const file of files) {
      signal?.throwIfAborted();
      const current = await hashLocalArtifact(directory, file.path, signal);
      if (!isDeepStrictEqual(current, file))
        throw new Error("Cleanup artifact changed");
      try {
        await fs.unlink(path.join(directory, ...file.path.split("/")));
      } catch (error) {
        return pending(error);
      }
      removed++;
      byteLength += file.byteLength;
    }
    const remaining = await inventoryLocalArtifacts(directory, signal);
    if (!isDeepStrictEqual(remaining.files, [reference]))
      throw new Error("Cleanup inventory changed before receipt removal");
    try {
      await fs.unlink(path.join(directory, CLEANUP_RECEIPT_FILENAME));
    } catch (error) {
      return pending(error);
    }
    return { kind: "cleaned", removed, byteLength };
  } catch (error) {
    return { kind: "blocked", error };
  }
}
