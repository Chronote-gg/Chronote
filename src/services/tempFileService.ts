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

export async function ensureTempBaseDir(): Promise<string> {
  await fs.mkdir(BASE_TEMP_DIR, { recursive: true });
  return BASE_TEMP_DIR;
}

export function getMeetingTempDir(meeting: MeetingData): string {
  return path.join(BASE_TEMP_DIR, "m", meeting.meetingId);
}

export function getRetainedMeetingTempDir(meeting: MeetingData): string {
  return path.join(RETAINED_TEMP_DIR, meeting.meetingId);
}

export async function ensureMeetingTempDir(
  meeting: MeetingData,
): Promise<string> {
  const dir = getMeetingTempDir(meeting);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export function ensureMeetingTempDirSync(meeting: MeetingData): string {
  const dir = getMeetingTempDir(meeting);
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function safeRemove(dir: string, label: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch (error) {
    console.warn(`Failed to clean ${label} temp directory: ${dir}`, error);
  }
}

export async function cleanupTempBaseDir(): Promise<void> {
  await safeRemove(BASE_TEMP_DIR, "base");
}

export async function cleanupMeetingTempDir(
  meeting: MeetingData,
): Promise<void> {
  await safeRemove(getMeetingTempDir(meeting), "meeting");
}

export async function retainMeetingTempDir(
  meeting: MeetingData,
  reason: string,
): Promise<string | undefined> {
  const sourceDir = getMeetingTempDir(meeting);
  const retainedDir = getRetainedMeetingTempDir(meeting);
  try {
    await fs.access(sourceDir);
    await fs.mkdir(RETAINED_TEMP_DIR, { recursive: true });
    await fs.rm(retainedDir, { recursive: true, force: true });
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
    );
    try {
      await fs.rename(sourceDir, retainedDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EXDEV") {
        throw error;
      }
      await fs.cp(sourceDir, retainedDir, { recursive: true });
      await fs.rm(sourceDir, { recursive: true, force: true });
    }
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
  }
}
