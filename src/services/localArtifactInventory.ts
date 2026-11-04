import { constants, promises as fs, type Stats } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  localArtifactSchema,
  localArtifactsSchema,
  MAX_LOCAL_ARTIFACT_ENTRIES,
  type LocalArtifact,
  type LocalArtifactInventory,
} from "../types/localArtifact";

function missing(error: unknown) {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function fileIdentity(
  stat: Pick<Stats, "dev" | "ino" | "size" | "mtimeMs" | "ctimeMs">,
) {
  const { dev, ino, size, mtimeMs, ctimeMs } = stat;
  return { dev, ino, size, mtimeMs, ctimeMs };
}

async function requireManagedDirectory(directory: string) {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("Artifact directory is not an ordinary directory");
}

async function verifyParents(
  directory: string,
  relative: string,
  signal?: AbortSignal,
) {
  let parent = path.resolve(directory);
  for (const part of ["", ...relative.split("/").slice(0, -1)]) {
    signal?.throwIfAborted();
    parent = path.join(parent, part);
    await requireManagedDirectory(parent);
  }
}

export async function hashLocalArtifact(
  directory: string,
  relative: string,
  signal?: AbortSignal,
  maxByteLength = Number.MAX_SAFE_INTEGER,
): Promise<LocalArtifact> {
  const checked = localArtifactSchema.shape.path.parse(relative);
  await verifyParents(directory, checked, signal);
  const filename = path.join(directory, ...checked.split("/"));
  signal?.throwIfAborted();
  const named = await fs.lstat(filename);
  if (!named.isFile() || named.isSymbolicLink())
    throw new Error("Artifact is not an ordinary file");
  const handle = await fs.open(
    filename,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      !Number.isSafeInteger(before.size) ||
      before.size > maxByteLength
    )
      throw new Error("Invalid artifact size or type");
    const hash = createHash("sha256");
    let byteLength = 0;
    for await (const chunk of handle.createReadStream({
      autoClose: false,
      signal,
    })) {
      signal?.throwIfAborted();
      byteLength += chunk.byteLength;
      if (byteLength > before.size)
        throw new Error("Artifact grew during verification");
      hash.update(chunk);
    }
    const after = await handle.stat();
    const current = await fs.lstat(filename);
    const unchanged = [named, after, current].every(
      (stat) =>
        stat.isFile() &&
        !stat.isSymbolicLink() &&
        isDeepStrictEqual(fileIdentity(before), fileIdentity(stat)),
    );
    if (byteLength !== before.size || !unchanged)
      throw new Error("Artifact changed during verification");
    signal?.throwIfAborted();
    return { path: checked, byteLength, checksumSha256: hash.digest("hex") };
  } finally {
    await handle.close();
  }
}

async function scan(
  directory: string,
  relative: string,
  state: { entries: number; files: LocalArtifact[] },
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const current = path.join(directory, relative);
  await requireManagedDirectory(current);
  for await (const entry of await fs.opendir(current)) {
    if (++state.entries > MAX_LOCAL_ARTIFACT_ENTRIES)
      throw new Error("Artifact inventory exceeds its bound");
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    localArtifactSchema.shape.path.parse(child);
    if (entry.isDirectory()) await scan(directory, child, state, signal);
    else state.files.push(await hashLocalArtifact(directory, child, signal));
  }
}

export async function inventoryLocalArtifacts(
  directory: string,
  signal?: AbortSignal,
): Promise<LocalArtifactInventory> {
  signal?.throwIfAborted();
  let present = true;
  try {
    await fs.lstat(directory);
  } catch (error) {
    if (!missing(error)) throw error;
    present = false;
  }
  const state: { entries: number; files: LocalArtifact[] } = {
    entries: 0,
    files: [],
  };
  if (present) await scan(directory, "", state, signal);
  state.files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const byteLength = state.files.reduce(
    (sum, file) => sum + file.byteLength,
    0,
  );
  if (!Number.isSafeInteger(byteLength))
    throw new Error("Invalid inventory byte count");
  return {
    files: state.files,
    byteLength,
    digest: createHash("sha256")
      .update(JSON.stringify(state.files))
      .digest("hex"),
  };
}

export async function verifyLocalArtifactSubset(
  directory: string,
  expected: LocalArtifact[],
  signal?: AbortSignal,
): Promise<LocalArtifactInventory> {
  const original = new Map(
    localArtifactsSchema.parse(expected).map((file) => [file.path, file]),
  );
  const current = await inventoryLocalArtifacts(directory, signal);
  for (const file of current.files) {
    const previous = original.get(file.path);
    if (
      !previous ||
      previous.byteLength !== file.byteLength ||
      previous.checksumSha256 !== file.checksumSha256
    )
      throw new Error("Local artifact has no unchanged verified reference");
  }
  return current;
}
