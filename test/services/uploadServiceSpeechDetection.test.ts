import {
  uploadMeetingArtifacts,
  getVerifiedMeetingArtifacts,
} from "../../src/services/uploadService";
import { uploadVerifiedObjectToS3 } from "../../src/services/storageService";
import type { MeetingData } from "../../src/types/meeting-data";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
jest.mock("../../src/services/storageService", () => ({
  uploadObjectToS3: jest.fn(async () => "key"),
  uploadVerifiedObjectToS3: jest.fn(async () => ({
    key: "key",
    versionId: null,
    byteLength: 0,
    checksumSha256: "a".repeat(64),
  })),
}));
jest.mock("../../src/services/configService", () => ({
  config: { storage: { transcriptBucket: "test", transcriptPrefix: "" } },
}));
function uploadFixture(): MeetingData {
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
    chatLog: [],
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
  return meeting;
}

test("upload suppresses rejected guesses while retaining unmarked nullish fallback and offsets", async () => {
  const meeting = uploadFixture();
  await uploadMeetingArtifacts(meeting, { transcriptText: "valid words" });
  const payload = jest.mocked(uploadVerifiedObjectToS3).mock.calls[0][1];
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

test("an unverified final transcript does not become a saved artifact key", async () => {
  jest.mocked(uploadVerifiedObjectToS3).mockResolvedValueOnce(undefined);
  const meeting = uploadFixture();
  const result = await uploadMeetingArtifacts(meeting, {
    transcriptText: "generated transcript",
  });
  expect(result.transcriptS3Key).toBeUndefined();
  expect(meeting.transcriptS3Key).toBeUndefined();
  expect(getVerifiedMeetingArtifacts(meeting)).toEqual([]);
});

test("final audio, both chat representations and transcript all require verified receipts", async () => {
  const directory = await fs.mkdtemp(
    path.join(tmpdir(), "chronote-upload-receipts-"),
  );
  const audioFilePath = path.join(directory, "audio.mp3");
  const chatFilePath = path.join(directory, "chat.txt");
  try {
    await fs.writeFile(audioFilePath, "generated audio");
    await fs.writeFile(chatFilePath, "generated chat");
    jest
      .mocked(uploadVerifiedObjectToS3)
      .mockImplementation(async (key, body) => ({
        key,
        versionId: "verified-version",
        byteLength: Buffer.byteLength(body),
        checksumSha256: createHash("sha256").update(body).digest("hex"),
      }));
    const meeting = uploadFixture();
    const result = await uploadMeetingArtifacts(meeting, {
      audioFilePath,
      chatFilePath,
      transcriptText: "generated transcript",
    });
    expect(result).toMatchObject({
      audioUploadExpected: true,
      chatUploadExpected: true,
      transcriptUploadExpected: true,
      audioS3Key: expect.stringMatching(/audio_combined\.mp3$/),
      chatS3Key: expect.stringMatching(/chat\.json$/),
      transcriptS3Key: expect.stringMatching(/transcript\.json$/),
    });
    expect(
      getVerifiedMeetingArtifacts(meeting)
        .map((r) => r.key.split("/").at(-1))
        .sort(),
    ).toEqual([
      "audio_combined.mp3",
      "chat.json",
      "chat.txt",
      "transcript.json",
    ]);
  } finally {
    await fs.rm(audioFilePath, { force: true });
    await fs.rm(chatFilePath, { force: true });
    await fs.rmdir(directory);
  }
});
