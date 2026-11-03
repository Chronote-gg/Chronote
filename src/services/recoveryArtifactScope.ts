import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  recoveryArtifactBindingSchema,
  type RecoveryArtifactBinding,
  type ArtifactCleanupReceipt,
} from "../types/artifactCleanup";
import {
  checkpointObjectSchema,
  type CheckpointObject,
} from "../types/recordingCheckpoint";
import { ensureTempBaseDir } from "./tempFileService";
import { meetingArtifactProducers } from "./meetingArtifactProducer";
import { inventoryLocalArtifacts } from "./localArtifactInventory";
import {
  createCleanupReceipt,
  type CleanupReceiptResult,
} from "./artifactCleanupReceipt";
import {
  createLocalArtifactCleanupAuthorization,
  localArtifactCleanup,
  removeEmptyArtifactDirectories,
} from "./meetingArtifactCleanupService";

export async function createRecoveryArtifactScope(
  input: RecoveryArtifactBinding,
  sources: CheckpointObject[],
) {
  const binding = recoveryArtifactBindingSchema.parse(input);
  const inputs = checkpointObjectSchema
    .array()
    .min(1)
    .max(10_000)
    .parse(sources);
  const base = await ensureTempBaseDir();
  const root = path.join(base, "r");
  await fs.mkdir(root, { recursive: true });
  for (const filename of [base, root]) {
    const stat = await fs.lstat(filename);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("Recovery scratch root is not ordinary");
  }
  const prefix = createHash("sha256")
    .update(binding.owner.meetingId)
    .digest("hex")
    .slice(0, 16);
  const directory = await fs.mkdtemp(path.join(root, `${prefix}-`));
  const producer = meetingArtifactProducers.claim({
    directory,
    owner: binding.owner,
  });
  return {
    directory,
    beginWrite: (filename: string) =>
      producer.beginWrite(filename, { kind: "stored_derivative", inputs }),
    async close(): Promise<CleanupReceiptResult> {
      try {
        const snapshot = producer.freeze();
        const inventory = await inventoryLocalArtifacts(directory);
        if (!inventory.files.length) {
          await removeEmptyArtifactDirectories(directory);
          meetingArtifactProducers.release(directory);
          return { kind: "cleaned", removed: 0, byteLength: 0 };
        }
        const receipt: ArtifactCleanupReceipt = {
          version: 1,
          ...binding,
          createdAt: new Date().toISOString(),
          files: inventory.files,
          producers: snapshot.files,
          storedArtifacts: inputs.map((object) => ({
            ...object,
            versionId: null,
          })),
          decision: "scratch",
        };
        await createLocalArtifactCleanupAuthorization()(receipt);
        await createCleanupReceipt(directory, receipt);
        return await localArtifactCleanup.enqueue(directory);
      } catch (error) {
        return { kind: "blocked", error };
      }
    },
  };
}
export type RecoveryArtifactScope = Awaited<
  ReturnType<typeof createRecoveryArtifactScope>
>;
