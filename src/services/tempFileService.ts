import path from "node:path";
import { mkdirSync, promises as fs } from "node:fs";
import type { MeetingData } from "../types/meeting-data";
import { config } from "./configService";

const BASE_TEMP_DIR = path.resolve(config.paths.meetingTempDir);
const RETAINED_TEMP_DIR = path.join(
  path.dirname(BASE_TEMP_DIR),
  "retained-meetings",
);

export function getTempBaseDir(): string {
  return BASE_TEMP_DIR;
}
export function getRetainedTempBaseDir(): string {
  return RETAINED_TEMP_DIR;
}

export async function ensureTempBaseDir(): Promise<string> {
  await fs.mkdir(BASE_TEMP_DIR, { recursive: true });
  return BASE_TEMP_DIR;
}

export function getMeetingTempDir(
  meeting: Pick<MeetingData, "meetingId">,
): string {
  return path.join(BASE_TEMP_DIR, "m", meeting.meetingId);
}

export function getRetainedMeetingTempDir(
  meeting: Pick<MeetingData, "meetingId">,
): string {
  return path.join(RETAINED_TEMP_DIR, meeting.meetingId);
}

export async function ensureMeetingTempDir(
  meeting: Pick<MeetingData, "meetingId">,
): Promise<string> {
  const dir = getMeetingTempDir(meeting);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export function ensureMeetingTempDirSync(
  meeting: Pick<MeetingData, "meetingId">,
): string {
  const dir = getMeetingTempDir(meeting);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export async function cleanupTempBaseDir(): Promise<void> {
  const { localArtifactCleanup, removeEmptyArtifactDirectories } =
    await import("./meetingArtifactCleanupService");
  for (const root of [
    path.join(BASE_TEMP_DIR, "m"),
    path.join(BASE_TEMP_DIR, "r"),
    RETAINED_TEMP_DIR,
  ]) {
    try {
      const stat = await fs.lstat(root);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error("Artifact root is not ordinary");
      for await (const entry of await fs.opendir(root)) {
        if (entry.isDirectory() && !entry.isSymbolicLink())
          await localArtifactCleanup.enqueue(path.join(root, entry.name));
      }
    } catch (error) {
      if (!(
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ))
        console.warn(
          "Local artifact reconciliation could not inspect a root",
          error,
        );
    }
  }
  await removeEmptyArtifactDirectories(BASE_TEMP_DIR);
}

export async function cleanupMeetingTempDir(
  meeting: import("./meetingArtifactCleanupService").CleanupMeeting,
): Promise<void> {
  const { localArtifactCleanup } =
    await import("./meetingArtifactCleanupService");
  const result = await localArtifactCleanup.enqueue(
    getMeetingTempDir(meeting),
    meeting,
  );
  if (result.kind !== "cleaned")
    console.warn("Local meeting files retained for reconciliation", {
      kind: result.kind,
    });
}

export async function retainMeetingTempDir(
  meeting: Pick<MeetingData, "meetingId" | "guildId" | "channelId">,
  reason: string,
): Promise<string | undefined> {
  const sourceDir = getMeetingTempDir(meeting);
  const retainedDir = getRetainedMeetingTempDir(meeting);
  let lock: Awaited<ReturnType<typeof fs.open>> | undefined;
  const lockDir = path.join(path.dirname(BASE_TEMP_DIR), "retention-locks");
  const lockPath = path.join(lockDir, `${meeting.meetingId}.lock`);
  try {
    const source = await fs.lstat(sourceDir);
    if (!source.isDirectory() || source.isSymbolicLink())
      throw new Error("Retention source is not ordinary");
    await fs.mkdir(RETAINED_TEMP_DIR, { recursive: true });
    await fs.mkdir(lockDir, { recursive: true });
    lock = await fs.open(lockPath, "wx");
    try {
      await fs.lstat(retainedDir);
      throw new Error("Retained meeting already exists");
    } catch (error) {
      if (!(
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ))
        throw error;
    }
    await fs.writeFile(
      path.join(sourceDir, "retention.json"),
      JSON.stringify(
        {
          retainedAt: new Date().toISOString(),
          reason,
          meetingId: meeting.meetingId,
          guildId: meeting.guildId,
          channelId: meeting.channelId,
        },
        null,
        2,
      ),
      { flag: "wx" },
    );
    await fs.rename(sourceDir, retainedDir);
    return retainedDir;
  } catch (error) {
    console.error("Failed to retain meeting temp directory", {
      meetingId: meeting.meetingId,
      sourceDir,
      retainedDir,
      reason,
      error,
    });
    return undefined;
  } finally {
    if (lock) {
      await lock.close();
      await fs.unlink(lockPath);
    }
  }
}
