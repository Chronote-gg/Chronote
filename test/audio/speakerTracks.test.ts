import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { removeGeneratedMeetingTemp } from "../fixtures/meetingTemp";
import { startProcessingSnippet } from "../../src/audio";
import {
  BYTES_PER_SAMPLE,
  CHANNELS,
  RECORD_SAMPLE_RATE,
} from "../../src/constants";
import type { MeetingData } from "../../src/types/meeting-data";

describe("speaker tracks", () => {
  test("inserts silence between snippets for the same speaker", async () => {
    const startTime = new Date(0);
    const meeting = {
      meetingId: `generated-${randomUUID()}`,
      guildId: "guild-1",
      channelId: "channel-1",
      startTime,
      audioData: {
        currentSnippets: new Map(),
        audioFiles: [],
      },
      participants: new Map(),
      creator: {} as MeetingData["creator"],
      guild: {} as MeetingData["guild"],
      voiceChannel: {} as MeetingData["voiceChannel"],
      textChannel: {} as MeetingData["textChannel"],
      finishing: false,
      finished: false,
      transcribeMeeting: false,
      generateNotes: false,
      isAutoRecording: false,
      isFinished: Promise.resolve(),
      setFinished: () => {},
    } as MeetingData;

    const bytesPerMs =
      (RECORD_SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE) / 1000;
    const snippetBytes = Math.round(bytesPerMs * 100);
    const buffer = Buffer.alloc(snippetBytes);

    try {
      meeting.audioData.currentSnippets.set("user-1", {
        userId: "user-1",
        timestamp: startTime.getTime(),
        chunks: [buffer],
      });
      startProcessingSnippet(meeting, "user-1");

      meeting.audioData.currentSnippets.set("user-1", {
        userId: "user-1",
        timestamp: startTime.getTime() + 1000,
        chunks: [buffer],
      });
      startProcessingSnippet(meeting, "user-1");

      const waitForTrack = async () => {
        for (let i = 0; i < 5; i += 1) {
          const candidate = meeting.audioData.speakerTracks?.get("user-1");
          if (candidate?.writePromise) return candidate;
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        return meeting.audioData.speakerTracks?.get("user-1");
      };

      const track = await waitForTrack();
      expect(track).toBeTruthy();
      await track?.writePromise;

      const stats = await fs.promises.stat(track!.filePath);
      const expectedBytes = Math.round(bytesPerMs * 1100);
      expect(stats.size).toBe(expectedBytes);
    } finally {
      await removeGeneratedMeetingTemp(meeting);
    }
  });
});
