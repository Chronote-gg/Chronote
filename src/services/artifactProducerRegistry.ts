import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  artifactOwnerSchema,
  artifactProvenanceSchema,
  type ArtifactOwner,
  type ArtifactProvenance,
  type RegisteredArtifact,
} from "../types/artifactCleanup";
import {
  localArtifactSchema,
  MAX_LOCAL_ARTIFACT_ENTRIES,
} from "../types/localArtifact";

function createProducer(directory: string, owner: ArtifactOwner) {
  const files = new Map<string, RegisteredArtifact>();
  let closed = false;
  let writes = 0;
  function relative(filename: string) {
    return localArtifactSchema.shape.path.parse(
      path
        .relative(directory, path.resolve(filename))
        .split(path.sep)
        .join("/"),
    );
  }
  function register(filename: string, provenance: ArtifactProvenance) {
    if (closed) throw new Error("Local artifact producer is closed");
    const key = relative(filename);
    const checked = artifactProvenanceSchema.parse(provenance);
    const previous = files.get(key);
    if (previous && !isDeepStrictEqual(previous.provenance, checked))
      throw new Error("Artifact provenance changed");
    if (!previous && files.size >= MAX_LOCAL_ARTIFACT_ENTRIES)
      throw new Error("Artifact producer exceeds its bound");
    if (!previous)
      files.set(key, { path: key, state: "known", provenance: checked });
    return key;
  }
  return {
    register,
    beginWrite(filename: string, provenance: ArtifactProvenance) {
      const key = register(filename, provenance);
      writes++;
      let active = true;
      return {
        settle(result: "known" | "uncertain") {
          if (!active) return;
          active = false;
          if (result === "uncertain") {
            const entry = files.get(key);
            if (entry) entry.state = "uncertain";
          }
          writes--;
        },
      };
    },
    freeze() {
      if (writes) throw new Error("Local artifact writes remain owned");
      closed = true;
      return {
        owner: { ...owner },
        files: Array.from(files.values(), (entry) => ({
          ...entry,
          provenance: { ...entry.provenance },
        })),
      };
    },
    get pendingWrites() {
      return writes;
    },
    get closed() {
      return closed;
    },
    get owner() {
      return { ...owner };
    },
  };
}
export type ArtifactProducer = ReturnType<typeof createProducer>;
export type ArtifactWriter = (
  filename: string,
) => ReturnType<ArtifactProducer["beginWrite"]>;

export function createArtifactProducerRegistry() {
  const producers = new Map<string, ArtifactProducer>();
  let sealed = false;
  return {
    claim(input: { directory: string; owner: ArtifactOwner }) {
      const directory = path.resolve(input.directory);
      const owner = artifactOwnerSchema.parse(input.owner);
      const previous = producers.get(directory);
      if (previous) {
        if (!isDeepStrictEqual(previous.owner, owner))
          throw new Error("Artifact producer ownership changed");
        return previous;
      }
      if (sealed) throw new Error("Artifact producer admission is sealed");
      const producer = createProducer(directory, owner);
      producers.set(directory, producer);
      return producer;
    },
    get(directory: string) {
      return producers.get(path.resolve(directory));
    },
    release(directory: string) {
      const key = path.resolve(directory);
      const producer = producers.get(key);
      if (producer && (!producer.closed || producer.pendingWrites))
        throw new Error("Cannot release an open artifact producer");
      producers.delete(key);
    },
    seal() {
      sealed = true;
      let ready = true;
      for (const producer of producers.values()) {
        if (producer.pendingWrites) ready = false;
        else producer.freeze();
      }
      return ready;
    },
    resume() {
      sealed = false;
    },
  };
}
