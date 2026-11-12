/** @jest-environment node */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MeetingData } from "../../src/types/meeting-data";

const buildMeeting = (): MeetingData =>
  ({
    guildId: "guild-1",
    channelId: "channel-1",
    meetingId: "meeting-1",
  }) as MeetingData;

const loadService = async (baseDir: string) => {
  process.env.MEETING_TEMP_DIR = baseDir;
  jest.resetModules();
  return await import("../../src/services/tempFileService");
};

async function removeTestDirectory(directory: string, prefix: string) {
  if (
    path.dirname(directory) !== path.resolve(os.tmpdir()) ||
    !path.basename(directory).startsWith(prefix)
  )
    throw new Error("Unexpected test cleanup target");
  await fs.promises.rm(directory, { recursive: true, force: true });
}

describe("tempFileService", () => {
  const originalEnv = process.env.MEETING_TEMP_DIR;

  afterEach(() => {
    process.env.MEETING_TEMP_DIR = originalEnv;
    jest.resetModules();
  });

  it("creates the meeting directory under the meeting root", async () => {
    const baseDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "chronote-clean-"),
    );
    const service = await loadService(baseDir);
    const meeting = buildMeeting();
    try {
      const dir = await service.ensureMeetingTempDir(meeting);
      expect(dir).toBe(service.getMeetingTempDir(meeting));
      expect(fs.existsSync(dir)).toBe(true);
    } finally {
      await removeTestDirectory(baseDir, "chronote-clean-");
    }
  });

  async function sweepFixture(prefix: string) {
    const baseDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
    const service = await loadService(baseDir);
    const { LIFECYCLE } = await import("../../src/services/lifecycleTiming");
    const old = (nowMs: number) =>
      new Date(nowMs - LIFECYCLE.localSweepAgeMs - 1000);
    const make = async (relative: string, mtime?: Date) => {
      const dir = path.join(service.getTempBaseDir(), relative);
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(path.join(dir, "piece.pcm"), "audio");
      if (mtime) await fs.promises.utimes(dir, mtime, mtime);
      return dir;
    };
    return { baseDir, service, LIFECYCLE, old, make };
  }

  it("the sweep removes old per-meeting directories that nothing in this process holds", async () => {
    const f = await sweepFixture("chronote-sweep-");
    const nowMs = Date.now();
    try {
      const removed = [
        await f.make("m/synthetic-abandoned", f.old(nowMs)),
        await f.make("recovery-mix-synthetic-abandoned-abc123", f.old(nowMs)),
        await f.make("r/0123456789abcdef-abc123", f.old(nowMs)),
        await f.make("processing-retry-abc123", f.old(nowMs)),
      ];
      const kept = [
        await f.make("m/synthetic-live", f.old(nowMs)),
        await f.make("recovery-mix-synthetic-live-abc123", f.old(nowMs)),
        await f.make("m/synthetic-recent"),
        await f.make("r/fedcba9876543210-abc123"),
        await f.make("personal-upload/synthetic-upload", f.old(nowMs)),
      ];
      await f.service.sweepLocalMeetingDirs(
        (meetingId) => meetingId === "synthetic-live",
        nowMs,
      );
      for (const dir of removed) expect(fs.existsSync(dir)).toBe(false);
      for (const dir of kept) expect(fs.existsSync(dir)).toBe(true);
    } finally {
      await removeTestDirectory(f.baseDir, "chronote-sweep-");
    }
  });

  it("a sweep root that is not a real directory is skipped and the others are still swept", async () => {
    const f = await sweepFixture("chronote-sweep-root-");
    const nowMs = Date.now();
    try {
      await fs.promises.mkdir(f.service.getTempBaseDir(), { recursive: true });
      await fs.promises.writeFile(
        path.join(f.service.getTempBaseDir(), "r"),
        "not a directory",
      );
      const abandoned = await f.make("m/synthetic-abandoned", f.old(nowMs));
      await f.service.sweepLocalMeetingDirs(() => false, nowMs);
      expect(fs.existsSync(abandoned)).toBe(false);
      expect(
        fs.statSync(path.join(f.service.getTempBaseDir(), "r")).isFile(),
      ).toBe(true);
    } finally {
      await removeTestDirectory(f.baseDir, "chronote-sweep-root-");
    }
  });

  it("the sweep runs every hour until it is stopped", async () => {
    const f = await sweepFixture("chronote-sweep-timer-");
    jest.useFakeTimers({ doNotFake: ["setImmediate", "nextTick"] });
    // The sweep's file system calls are real, so wait out a bounded number of turns for them.
    const removal = async (dir: string) => {
      for (let turn = 0; turn < 200 && fs.existsSync(dir); turn += 1)
        await new Promise((resolve) => setImmediate(resolve));
    };
    try {
      const stop = f.service.startLocalSweep(() => false);
      // Let the immediate sweep finish first, so only the hourly one can remove this.
      await f.service.sweepLocalMeetingDirs(() => false, Date.now());
      const dir = await f.make("m/synthetic-later", f.old(Date.now()));
      await jest.advanceTimersByTimeAsync(f.LIFECYCLE.localSweepMs);
      await removal(dir);
      expect(fs.existsSync(dir)).toBe(false);
      stop();
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
      await removeTestDirectory(f.baseDir, "chronote-sweep-timer-");
    }
  });
});
