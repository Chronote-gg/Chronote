import fs from "node:fs";
import path from "node:path";
import ffmpeg from "fluent-ffmpeg";
import { buildMixedAudio } from "../../src/audio";
import {
  cleanupMeetingTempDir,
  ensureMeetingTempDir,
} from "../../src/services/tempFileService";
import type { MeetingData } from "../../src/types/meeting-data";

jest.mock("fluent-ffmpeg", () => {
  const fs = jest.requireActual<typeof import("node:fs")>("node:fs");
  const ffmpegMock = jest.fn(() => {
    const handlers = new Map<string, () => void>();
    const chain = {
      input: jest.fn(() => chain),
      inputOptions: jest.fn(() => chain),
      audioCodec: jest.fn(() => chain),
      outputOptions: jest.fn(() => chain),
      toFormat: jest.fn(() => chain),
      on: jest.fn((event: string, callback: () => void) => {
        handlers.set(event, callback);
        return chain;
      }),
      save: jest.fn((outputPath: string) => {
        fs.writeFileSync(outputPath, Buffer.alloc(8));
        handlers.get("end")?.();
        return chain;
      }),
    };
    return chain;
  });
  return { __esModule: true, default: ffmpegMock };
});

describe("buildMixedAudio", () => {
  test("encodes a single speaker track", async () => {
    const meeting = {
      meetingId: "meeting-1",
      audioData: {
        currentSnippets: new Map(),
        audioFiles: [],
        speakerTracks: new Map(),
      },
    } as MeetingData;

    const tempDir = await ensureMeetingTempDir(meeting);
    const trackDir = path.join(tempDir, "t");
    await fs.promises.mkdir(trackDir, { recursive: true });
    const trackPath = path.join(trackDir, "t_user-1.pcm");
    await fs.promises.writeFile(trackPath, Buffer.alloc(20));

    meeting.audioData.speakerTracks?.set("user-1", {
      userId: "user-1",
      filePath: trackPath,
      lastEndMs: 20,
      source: "voice",
    });

    try {
      const output = await buildMixedAudio(meeting);
      expect(output).toBe(path.join(tempDir, "recording_mixed.mp3"));
      expect(fs.existsSync(output!)).toBe(true);
      expect(
        jest.mocked(ffmpeg).mock.results[0].value.input,
      ).toHaveBeenCalledWith(trackPath);
    } finally {
      await cleanupMeetingTempDir(meeting);
    }
  });
});

test.each([1, 2])(
  "interruption cancels %s-speaker encoder but waits actual terminal event",
  async (count) => {
    const { stopMeetingProcessing } =
      await import("../../src/services/meetingProcessingLifetime");
    const meeting = {
      meetingId: `synthetic-mix-${count}`,
      audioData: {
        speakerTracks: new Map(),
        currentSnippets: new Map(),
        audioFiles: [],
      },
    } as unknown as MeetingData;
    const directory = await ensureMeetingTempDir(meeting);
    for (let index = 0; index < count; index++) {
      const filePath = path.join(directory, `${index}.pcm`);
      await fs.promises.writeFile(filePath, Buffer.alloc(8));
      meeting.audioData.speakerTracks!.set(String(index), {
        userId: String(index),
        filePath,
        lastEndMs: 1,
        source: "voice",
      });
    }
    const handlers = new Map<string, () => void>();
    let entered!: () => void;
    const submitted = new Promise<void>((done) => {
      entered = done;
    });
    const command = {
      input: jest.fn(() => command),
      inputOptions: jest.fn(() => command),
      audioCodec: jest.fn(() => command),
      outputOptions: jest.fn(() => command),
      toFormat: jest.fn(() => command),
      complexFilter: jest.fn(() => command),
      kill: jest.fn(),
      on: jest.fn((name: string, fn: () => void) => {
        handlers.set(name, fn);
        return command;
      }),
      save: jest.fn(() => {
        entered();
        return command;
      }),
    };
    jest.mocked(ffmpeg).mockReturnValueOnce(command as never);
    try {
      const actual = buildMixedAudio(meeting);
      const outcome = actual.then(
        () => "success",
        () => "cancelled",
      );
      await submitted;
      let drained = false;
      const drain = stopMeetingProcessing(meeting).then(() => {
        drained = true;
      });
      await Promise.resolve();
      const heldBeforeEnd = !drained;
      handlers.get("end")!();
      await drain;
      expect(await outcome).toBe("cancelled");
      expect(heldBeforeEnd).toBe(true);
      expect(command.kill).toHaveBeenCalledWith("SIGTERM");
    } finally {
      await cleanupMeetingTempDir(meeting);
    }
  },
);
