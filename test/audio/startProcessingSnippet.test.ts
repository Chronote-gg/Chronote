import type { MeetingData } from "../../src/types/meeting-data";
import type { AudioFileData, AudioSnippet } from "../../src/types/audio";
import { startProcessingSnippet } from "../../src/audio";
import { transcribeSnippet } from "../../src/services/transcriptionService";

jest.mock("../../src/liveVoice", () => ({
  maybeRespondLive: jest.fn(),
}));

jest.mock("../../src/services/transcriptionService", () => ({
  transcribeSnippet: jest.fn(),
  coalesceTranscription: jest.fn(),
  cleanupTranscription: jest.fn(),
}));

describe("startProcessingSnippet", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const buildMeeting = (snippet: AudioSnippet, fileData: AudioFileData) =>
    ({
      guildId: "guild-1",
      channelId: "channel-1",
      meetingId: "meeting-1",
      startTime: new Date("2025-01-01T00:00:00.000Z"),
      audioData: {
        currentSnippets: new Map([[snippet.userId, snippet]]),
        audioFiles: [fileData],
      },
      runtimeConfig: {
        transcription: {
          fastSilenceMs: 400,
          slowSilenceMs: 2000,
          minSnippetSeconds: 0.3,
          maxSnippetMs: 60000,
          suppressionEnabled: true,
          suppressionHardSilenceDbfs: -60,
          suppressionRateMaxSeconds: 3,
          suppressionRateMinWords: 4,
          suppressionRateMinSyllables: 8,
          suppressionRateMaxSyllablesPerSecond: 7,
          promptEchoEnabled: true,
          voteEnabled: true,
          fastFinalizationEnabled: true,
          interjectionEnabled: false,
          interjectionMinSpeakerSeconds: 0.3,
          noiseGate: {
            enabled: false,
            windowMs: 20,
            peakDbfs: -45,
            minActiveWindows: 2,
            minPeakAboveNoiseDb: 15,
            applyToFast: true,
            applyToSlow: true,
          },
          finalPassEnabled: false,
        },
        premiumTranscription: {
          enabled: false,
          cleanupEnabled: false,
          coalesceModel: "gpt-5-mini",
        },
        dictionary: {
          maxEntries: 0,
          maxCharsTranscription: 0,
          maxCharsContext: 0,
        },
      },
    }) as unknown as MeetingData;

  it("skips slow transcription when fast covers the snippet", () => {
    const snippet: AudioSnippet = {
      userId: "user-1",
      timestamp: Date.now(),
      chunks: [Buffer.alloc(10)],
      audioBytes: 10,
      fastRevision: 1,
      fastTranscribed: true,
      lastFastTranscriptBytes: 10,
    };
    const audioFileData: AudioFileData = {
      userId: snippet.userId,
      timestamp: snippet.timestamp,
      source: "voice",
      processing: true,
      audioOnlyProcessing: false,
      fastTranscripts: [
        {
          revision: 1,
          text: "hello there",
          createdAt: "2025-01-01T00:00:00.000Z",
        },
      ],
    };
    snippet.audioFileData = audioFileData;

    const meeting = buildMeeting(snippet, audioFileData);

    startProcessingSnippet(meeting, snippet.userId);

    expect(transcribeSnippet).not.toHaveBeenCalled();
    expect(audioFileData.transcript).toBe("hello there");
    expect(meeting.audioData.currentSnippets.has(snippet.userId)).toBe(false);
  });

  it("runs slow transcription when fast does not cover the snippet", () => {
    const snippet: AudioSnippet = {
      userId: "user-1",
      timestamp: Date.now(),
      chunks: [Buffer.alloc(10)],
      audioBytes: 60000,
      fastRevision: 1,
      fastTranscribed: true,
      lastFastTranscriptBytes: 10,
    };
    const audioFileData: AudioFileData = {
      userId: snippet.userId,
      timestamp: snippet.timestamp,
      source: "voice",
      processing: true,
      audioOnlyProcessing: false,
      fastTranscripts: [
        {
          revision: 1,
          text: "hello there",
          createdAt: "2025-01-01T00:00:00.000Z",
        },
      ],
    };
    snippet.audioFileData = audioFileData;

    const meeting = buildMeeting(snippet, audioFileData);
    (transcribeSnippet as jest.Mock).mockResolvedValue("slow text");

    startProcessingSnippet(meeting, snippet.userId);

    expect(transcribeSnippet).toHaveBeenCalledTimes(1);
  });
});
