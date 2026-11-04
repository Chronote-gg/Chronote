import path from "node:path";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { createArtifactProducerRegistry } from "./artifactProducerRegistry";
import type { createCleanupAuthorization } from "./artifactCleanupAuthorization";
import { verifyCleanupReceipt } from "./artifactCleanupReceipt";
import { inventoryLocalArtifacts } from "./localArtifactInventory";
import {
  artifactAuthoritySchema,
  type ArtifactAuthority,
} from "../types/artifactCleanup";
import {
  artifactStorageSnapshotSchema,
  MAX_ARTIFACT_AUTHORITIES,
  type ArtifactStorageSnapshot,
} from "../types/artifactSafety";

type Root = { label: "working" | "retained"; directory: string };
function groupDirectory(root: Root, relative: string) {
  const parts = relative.split("/");
  const prefix = root.label === "working" ? 2 : 1;
  if (
    parts.length <= prefix ||
    (root.label === "working" && !["m", "r"].includes(parts[0]))
  )
    throw new Error("Unknown files outside managed artifact directories");
  return path.join(root.directory, ...parts.slice(0, prefix));
}

function addAuthority(
  authorities: Map<string, ArtifactAuthority>,
  input: ArtifactAuthority,
) {
  const authority = artifactAuthoritySchema.parse(input);
  const key = JSON.stringify([authority.owner.guildId, authority.historyKey]);
  const previous = authorities.get(key);
  if (previous && !isDeepStrictEqual(previous, authority))
    throw new Error("Artifact history authority changed");
  authorities.set(key, authority);
}

export function createRuntimeArtifactStorage(dependencies: {
  roots: { working: string; retained: string };
  producers: Pick<
    ReturnType<typeof createArtifactProducerRegistry>,
    "seal" | "resume"
  >;
  cleanup: { seal(): Promise<void>; resume(): void };
  authorize: ReturnType<typeof createCleanupAuthorization>;
}) {
  let sealed = false;
  let generation = 0;
  const roots: Root[] = [
    { label: "working", directory: dependencies.roots.working },
    { label: "retained", directory: dependencies.roots.retained },
  ];
  async function inventory(signal?: AbortSignal) {
    const result = [];
    for (const root of roots)
      result.push({
        ...root,
        ...(await inventoryLocalArtifacts(root.directory, signal)),
      });
    return result;
  }
  function digest(records: Awaited<ReturnType<typeof inventory>>) {
    return createHash("sha256")
      .update(
        JSON.stringify(records.map(({ label, files }) => ({ label, files }))),
      )
      .digest("hex");
  }
  function requireSeal(expected: number, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (!sealed || expected !== generation)
      throw new Error("Artifact storage seal changed");
  }
  async function inspect(
    expected: number,
    signal?: AbortSignal,
  ): Promise<ArtifactStorageSnapshot> {
    requireSeal(expected, signal);
    const before = await inventory(signal);
    const directories = new Set<string>();
    for (const root of before)
      for (const file of root.files)
        directories.add(groupDirectory(root, file.path));
    if (directories.size > MAX_ARTIFACT_AUTHORITIES)
      throw new Error("Artifact proof exceeds its bounded authority set");
    const authorities = new Map<string, ArtifactAuthority>();
    for (const directory of directories) {
      const verified = await verifyCleanupReceipt(
        directory,
        { authorize: dependencies.authorize },
        signal,
      );
      addAuthority(authorities, verified.authority);
    }
    const after = await inventory(signal);
    requireSeal(expected, signal);
    if (digest(before) !== digest(after))
      throw new Error("Artifact inventory changed during verification");
    return artifactStorageSnapshotSchema.parse({
      inventoryDigest: digest(after),
      fileCount: after.reduce((sum, root) => sum + root.files.length, 0),
      byteLength: after.reduce((sum, root) => sum + root.byteLength, 0),
      pendingDirectories: directories.size,
      authorities: Array.from(authorities.entries())
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([, authority]) => authority),
    });
  }
  return {
    async seal(signal?: AbortSignal) {
      const expected = ++generation;
      sealed = false;
      if (!dependencies.producers.seal())
        throw new Error("Artifact writer still owns actual I/O");
      await dependencies.cleanup.seal();
      signal?.throwIfAborted();
      if (expected !== generation)
        throw new Error("Artifact preparation was cancelled");
      sealed = true;
      return inspect(expected, signal);
    },
    async recheck(expected: ArtifactStorageSnapshot, signal?: AbortSignal) {
      const current = await inspect(generation, signal);
      if (
        !isDeepStrictEqual(
          current,
          artifactStorageSnapshotSchema.parse(expected),
        )
      )
        throw new Error("Artifact storage proof changed");
      return current;
    },
    resume() {
      generation++;
      sealed = false;
      dependencies.producers.resume();
      dependencies.cleanup.resume();
    },
  };
}
export type RuntimeArtifactStorage = ReturnType<
  typeof createRuntimeArtifactStorage
>;
