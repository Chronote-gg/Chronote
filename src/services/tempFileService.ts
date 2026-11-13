import path from "node:path";
import { mkdirSync, promises as fs } from "node:fs";
import type { MeetingData } from "../types/meeting-data";
import { config } from "./configService";
import { LIFECYCLE } from "./lifecycleTiming";

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

// Not `instanceof Error`: file system errors can come from another realm under the test runner.
function isMissing(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

const RECOVERY_MIX_PREFIX = "recovery-mix-";
// mkdtemp appends a dash-free six character suffix after the prefix's trailing dash.
const MKDTEMP_SUFFIX_LENGTH = 7;
const PROCESSING_RETRY_PREFIX = "processing-retry-";

type SweepCandidate = { dir: string; meetingId?: string };

/** The names under `root`, or none when it is missing or not a real directory (a symlink is never followed). */
async function listDirs(root: string): Promise<string[]> {
  try {
    const stat = await fs.lstat(root);
    if (!stat.isDirectory()) return [];
    return await fs.readdir(root);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

/**
 * Every per-meeting directory this code creates under the temp base. Only
 * directories named by meeting id can be checked against live work; the
 * recovery scopes under `r/` and the processing retry directories belong to
 * one finish or retry attempt, which ends long before the sweep age.
 */
async function sweepCandidates(): Promise<SweepCandidate[]> {
  const meetings = (await listDirs(path.join(BASE_TEMP_DIR, "m"))).map(
    (meetingId) => ({
      dir: path.join(BASE_TEMP_DIR, "m", meetingId),
      meetingId,
    }),
  );
  const scopes = (await listDirs(path.join(BASE_TEMP_DIR, "r"))).map(
    (name) => ({ dir: path.join(BASE_TEMP_DIR, "r", name) }),
  );
  const top = (await listDirs(BASE_TEMP_DIR)).flatMap(
    (name): SweepCandidate[] => {
      const dir = path.join(BASE_TEMP_DIR, name);
      if (name.startsWith(RECOVERY_MIX_PREFIX))
        return [
          {
            dir,
            meetingId: name.slice(
              RECOVERY_MIX_PREFIX.length,
              -MKDTEMP_SUFFIX_LENGTH,
            ),
          },
        ];
      return name.startsWith(PROCESSING_RETRY_PREFIX) ? [{ dir }] : [];
    },
  );
  return [...meetings, ...scopes, ...top];
}

/** Removes per-meeting directories older than `localSweepAgeMs` that no capture or finish in this process holds. */
export async function sweepLocalMeetingDirs(
  isLive: (meetingId: string) => boolean,
  nowMs: number,
): Promise<void> {
  const live = (candidate: SweepCandidate) =>
    candidate.meetingId !== undefined && isLive(candidate.meetingId);
  for (const candidate of await sweepCandidates()) {
    if (live(candidate)) continue;
    try {
      const stat = await fs.lstat(candidate.dir);
      if (!stat.isDirectory()) continue;
      if (nowMs - stat.mtimeMs <= LIFECYCLE.localSweepAgeMs) continue;
      // Checked again just before removal: a finish may have started during the scan.
      if (live(candidate)) continue;
      await fs.rm(candidate.dir, { recursive: true, force: true });
    } catch (error) {
      if (!isMissing(error))
        console.warn("Local meeting directory sweep failed", {
          dir: candidate.dir,
          error,
        });
    }
  }
}

/** Sweeps now and then every `localSweepMs`; returns the stop function. */
export function startLocalSweep(
  isLive: (meetingId: string) => boolean,
): () => void {
  const sweep = () => {
    void sweepLocalMeetingDirs(isLive, Date.now()).catch((error: unknown) =>
      console.warn("Local meeting directory sweep failed", error),
    );
  };
  sweep();
  const timer = setInterval(sweep, LIFECYCLE.localSweepMs);
  timer.unref();
  return () => clearInterval(timer);
}
