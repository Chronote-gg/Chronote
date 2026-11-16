import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { ensureTempBaseDir } from "./tempFileService";

const SCOPE_PREFIX_LENGTH = 16;

/**
 * A private scratch directory for one recovery transcription. Everything in it
 * is derived from stored checkpoint objects, so it is removed when the work
 * ends; the local sweep catches a directory a crash leaves behind.
 */
export async function createRecoveryArtifactScope(meetingId: string) {
  const base = await ensureTempBaseDir();
  const root = path.join(base, "r");
  await fs.mkdir(root, { recursive: true });
  for (const filename of [base, root]) {
    const stat = await fs.lstat(filename);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("Recovery scratch root is not ordinary");
  }
  const prefix = createHash("sha256")
    .update(meetingId)
    .digest("hex")
    .slice(0, SCOPE_PREFIX_LENGTH);
  const directory = await fs.mkdtemp(path.join(root, `${prefix}-`));
  return {
    directory,
    async close(): Promise<void> {
      try {
        await fs.rm(directory, { recursive: true, force: true });
      } catch (error) {
        console.warn("Recovery scratch removal failed; the sweep retries", {
          error,
        });
      }
    },
  };
}
export type RecoveryArtifactScope = Awaited<
  ReturnType<typeof createRecoveryArtifactScope>
>;
