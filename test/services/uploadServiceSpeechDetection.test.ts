import { uploadMeetingArtifacts } from "../../src/services/uploadService";
import { uploadObjectToS3 } from "../../src/services/storageService";
import type { MeetingData } from "../../src/types/meeting-data";
jest.mock("../../src/services/storageService", () => ({
  uploadObjectToS3: jest.fn(async () => "key"),
}));
jest.mock("../../src/services/configService", () => ({
  config: { storage: { transcriptBucket: "test", transcriptPrefix: "" } },
}));
test("upload suppresses rejected guesses while retaining unmarked nullish fallback and offsets", async () => {
  const base = {
    userId: "u",
    timestamp: 1000,
    processing: false,
    audioOnlyProcessing: false,
  };
  const meeting = {
    guildId: "g",
    channelId: "c",
    meetingId: "m",
    voiceChannel: { id: "c" },
    startTime: new Date(0),
    participants: new Map([["u", { id: "u", username: "user" }]]),
    audioData: {
      currentSnippets: new Map(),
      audioFiles: [
        {
          ...base,
          transcript: "rejected guess",
          slowTranscript: "",
          coalescedTranscript: "old guess",
          finalPassTranscript: "late guess",
          finalSpeechRejection: {
            pcmSha256: "synthetic",
            audioBytes: 4,
            policyFingerprint: "test",
          },
        },
        {
          ...base,
          timestamp: 2000,
          transcript: "fallback must not win",
          slowTranscript: "",
        },
        { ...base, timestamp: 3000, transcript: "valid words" },
      ],
    },
  } as unknown as MeetingData;
  await uploadMeetingArtifacts(meeting, { transcriptText: "valid words" });
  const payload = jest.mocked(uploadObjectToS3).mock.calls[0][1];
  expect(typeof payload).toBe("string");
  const parsed = JSON.parse(String(payload));
  expect(
    parsed.segments.map((segment: { text: string }) => segment.text),
  ).toEqual(["", "", "valid words"]);
  expect(
    parsed.segments.map((segment: { startedAt: string }) => segment.startedAt),
  ).toEqual([
    "1970-01-01T00:00:01.000Z",
    "1970-01-01T00:00:02.000Z",
    "1970-01-01T00:00:03.000Z",
  ]);
});
