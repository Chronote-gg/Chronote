import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { storedArtifactSchema } from "../../../src/types/storedArtifact";
import type { StoredArtifact } from "../../../src/types/storedArtifact";
import type * as StorageService from "../../../src/services/storageService";
import type { WorkerGate } from "./world";

const SIGNED_URL_BASE = "https://scenario-storage.invalid/";

/** One object store shared by every worker, as S3 is in production. */
export class FakeStorage {
  readonly objects = new Map<string, Buffer>();
  private readonly versions = new Map<string, string>();
  private nextVersion = 1;
  /** While true every upload throws, as during an S3 outage; reads still work. */
  uploadsFailing = false;
  /** Uploads refused while `uploadsFailing` was set. */
  rejectedUploads = 0;

  /** The storageService exports a worker imports, each gated by that worker's liveness. */
  createModule(
    actual: typeof StorageService,
    gate: WorkerGate,
  ): typeof StorageService {
    const { StoredObjectMetadataError } = actual;
    const read = (key: string) => {
      gate.assertAlive();
      return this.objects.get(key);
    };
    const upload: typeof actual.uploadObjectToS3 = async (
      key,
      body,
      _contentType,
      options = {},
    ) => {
      gate.assertAlive();
      if (this.uploadsFailing) {
        this.rejectedUploads += 1;
        throw new Error("Scenario storage is rejecting uploads");
      }
      if (options.signal?.aborted) return undefined;
      if (options.immutable && this.objects.has(key)) return undefined;
      const versionId = `v${this.nextVersion++}`;
      this.objects.set(key, Buffer.from(body));
      this.versions.set(key, versionId);
      options.onAcknowledged?.({ key, versionId });
      return key;
    };
    const verify = async (reference: StoredArtifact, signal?: AbortSignal) => {
      storedArtifactSchema.parse(reference);
      signal?.throwIfAborted();
      const bytes = read(reference.key);
      if (!bytes)
        throw new StoredObjectMetadataError("Stored artifact is missing");
      if (
        reference.versionId &&
        this.versions.get(reference.key) !== reference.versionId
      )
        throw new StoredObjectMetadataError(
          "Stored artifact version is unavailable",
        );
      const checksumSha256 = createHash("sha256").update(bytes).digest("hex");
      if (
        bytes.byteLength !== reference.byteLength ||
        checksumSha256 !== reference.checksumSha256
      )
        throw new StoredObjectMetadataError(
          "Stored artifact checksum or length differs",
        );
    };
    return {
      ...actual,
      uploadObjectToS3: upload,
      verifyStoredArtifact: verify,
      async uploadVerifiedObjectToS3(key, body, contentType, options = {}) {
        let versionId: string | null = null;
        const uploaded = await upload(key, body, contentType, {
          ...options,
          onAcknowledged(receipt) {
            versionId = receipt.versionId;
            options.onAcknowledged?.(receipt);
          },
        });
        if (!uploaded) return undefined;
        const bytes = Buffer.from(body);
        const reference = storedArtifactSchema.parse({
          key,
          versionId,
          byteLength: bytes.byteLength,
          checksumSha256: createHash("sha256").update(bytes).digest("hex"),
        });
        await verify(reference, options.signal);
        return reference;
      },
      async fetchJsonFromS3(key, signal) {
        signal?.throwIfAborted();
        const bytes = read(key);
        return bytes && JSON.parse(bytes.toString("utf8"));
      },
      async fetchObjectBytesFromS3(key, signal) {
        signal?.throwIfAborted();
        const bytes = read(key);
        return bytes && Buffer.from(bytes);
      },
      async downloadObjectToFile(key, destinationPath, signal) {
        signal?.throwIfAborted();
        const bytes = read(key);
        if (!bytes) return false;
        await fs.writeFile(destinationPath, bytes);
        return true;
      },
      async getStoredObjectMetadata(key) {
        const bytes = read(key);
        return bytes && { contentLength: bytes.byteLength };
      },
      async getSignedObjectUrl(key) {
        gate.assertAlive();
        return SIGNED_URL_BASE + key;
      },
      async getSignedUploadUrl(key) {
        gate.assertAlive();
        return SIGNED_URL_BASE + key;
      },
      async getSignedUploadPost(key, contentType) {
        gate.assertAlive();
        return {
          url: SIGNED_URL_BASE,
          fields: { key, "Content-Type": contentType },
        };
      },
    };
  }
}
