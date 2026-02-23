import { describe, expect, jest, test } from "@jest/globals";
import type { MeetingData } from "../../src/types/meeting-data";
import type { AudioFileData } from "../../src/types/audio";
import { runTranscriptionFinalPass } from "../../src/services/transcriptionFinalPassService";

const buildAudioFile = (input: {
  userId: string;
  timestamp: number;
  transcript: string;
}): AudioFileData => ({
  userId: input.userId,
  timestamp: input.timestamp,
  transcript: input.transcript,
  processing: false,
  audioOnlyProcessing: false,
});

const buildMeeting = (): MeetingData => {
  const startTime = new Date("2025-01-01T00:00:00.000Z");
  const firstTimestamp = startTime.getTime() + 1_000;
  const secondTimestamp = startTime.getTime() + 3_000;

  return {
    meetingId: "meeting-1",
    guildId: "guild-1",
    channelId: "voice-1",
    startTime,
    endTime: new Date(startTime.getTime() + 120_000),
    creator: { id: "creator-1" },
    guild: { id: "guild-1", name: "Guild" },
    voiceChannel: { id: "voice-1", name: "Voice" },
    participants: new Map(),
    runtimeConfig: {
      transcription: {
        finalPassEnabled: true,
      },
    },
    audioData: {
      currentSnippets: new Map(),
      audioFiles: [
        buildAudioFile({
          userId: "user-1",
          timestamp: firstTimestamp,
          transcript: "first line",
        }),
        buildAudioFile({
          userId: "user-2",
          timestamp: secondTimestamp,
          transcript: "second line",
        }),
      ],
    },
  } as unknown as MeetingData;
};

const buildLongMeeting = (): MeetingData => {
  const startTime = new Date("2025-01-01T00:00:00.000Z");
  const firstTimestamp = startTime.getTime() + 1_000;
  const secondTimestamp = startTime.getTime() + 901_000;

  return {
    meetingId: "meeting-long",
    guildId: "guild-1",
    channelId: "voice-1",
    startTime,
    endTime: new Date(startTime.getTime() + 1_800_000),
    creator: { id: "creator-1" },
    guild: { id: "guild-1", name: "Guild" },
    voiceChannel: { id: "voice-1", name: "Voice" },
    participants: new Map(),
    runtimeConfig: {
      transcription: {
        finalPassEnabled: true,
      },
    },
    audioData: {
      currentSnippets: new Map(),
      audioFiles: [
        buildAudioFile({
          userId: "user-1",
          timestamp: firstTimestamp,
          transcript: "first long line",
        }),
        buildAudioFile({
          userId: "user-2",
          timestamp: secondTimestamp,
          transcript: "second long line",
        }),
      ],
    },
  } as unknown as MeetingData;
};

const buildBoundaryMeeting = (): MeetingData => {
  const startTime = new Date("2025-01-01T00:00:00.000Z");
  const nearBoundaryTimestamp = startTime.getTime() + 899_000;
  const secondChunkTimestamp = startTime.getTime() + 920_000;

  return {
    meetingId: "meeting-boundary",
    guildId: "guild-1",
    channelId: "voice-1",
    startTime,
    endTime: new Date(startTime.getTime() + 1_800_000),
    creator: { id: "creator-1" },
    guild: { id: "guild-1", name: "Guild" },
    voiceChannel: { id: "voice-1", name: "Voice" },
    participants: new Map(),
    runtimeConfig: {
      transcription: {
        finalPassEnabled: true,
      },
    },
    audioData: {
      currentSnippets: new Map(),
      audioFiles: [
        buildAudioFile({
          userId: "user-1",
          timestamp: nearBoundaryTimestamp,
          transcript: "boundary line",
        }),
        buildAudioFile({
          userId: "user-2",
          timestamp: secondChunkTimestamp,
          transcript: "second chunk line",
        }),
      ],
    },
  } as unknown as MeetingData;
};

const buildDependencies = () => ({
  ensureTempDir: jest.fn(async () => "C:\\temp"),
  getAudioDurationSeconds: jest.fn(async () => 120),
  renderAudioChunk: jest.fn(async () => undefined),
  transcribeChunk: jest.fn(async () => ({
    text: "first line second line",
    logprobs: [{ logprob: -0.2 }, { logprob: -0.4 }],
  })),
  reconcileBatch: jest.fn(
    async (input: {
      previousChunkTail: string;
      chunkIndex: number;
      baselineSegments: Array<{ segmentId: string }>;
    }) => {
      void input;
      return [] as Array<{
        segmentId: string;
        action: "replace" | "drop";
        text?: string;
        confidence: number;
      }>;
    },
  ),
  deleteTempFile: jest.fn(async () => undefined),
});

describe("transcriptionFinalPassService", () => {
  test("auto-applies high-confidence replacement edits", async () => {
    const meeting = buildMeeting();
    const dependencies = buildDependencies();
    dependencies.reconcileBatch.mockResolvedValue([
      {
        segmentId: "seg-1",
        action: "replace",
        text: "first line corrected",
        confidence: 0.95,
      },
      {
        segmentId: "seg-2",
        action: "drop",
        confidence: 0.2,
      },
    ]);

    const result = await runTranscriptionFinalPass(
      meeting,
      { audioFilePath: "recording.mp3" },
      dependencies,
    );

    expect(result.applied).toBe(true);
    expect(result.fallbackApplied).toBe(false);
    expect(result.acceptedEdits).toBe(1);
    expect(result.replacedSegments).toBe(1);
    expect(result.droppedSegments).toBe(0);
    expect(meeting.audioData.audioFiles[0].finalPassTranscript).toBe(
      "first line corrected",
    );
    expect(meeting.audioData.audioFiles[1].finalPassTranscript).toBeUndefined();
  });

  test("falls back when accepted edits exceed guardrail thresholds", async () => {
    const meeting = buildMeeting();
    const dependencies = buildDependencies();
    dependencies.reconcileBatch.mockResolvedValue([
      {
        segmentId: "seg-1",
        action: "drop",
        confidence: 0.95,
      },
      {
        segmentId: "seg-2",
        action: "drop",
        confidence: 0.95,
      },
    ]);

    const result = await runTranscriptionFinalPass(
      meeting,
      { audioFilePath: "recording.mp3" },
      dependencies,
    );

    expect(result.applied).toBe(false);
    expect(result.fallbackApplied).toBe(true);
    expect(result.fallbackReason).toBe("guardrail_threshold");
    expect(meeting.audioData.audioFiles[0].finalPassTranscript).toBeUndefined();
    expect(meeting.audioData.audioFiles[1].finalPassTranscript).toBeUndefined();
  });

  test("uses previous chunk tail for reconciliation continuity", async () => {
    const meeting = buildLongMeeting();
    const dependencies = buildDependencies();
    dependencies.getAudioDurationSeconds.mockResolvedValue(1_800);
    dependencies.transcribeChunk
      .mockResolvedValueOnce({
        text: "chunk one transcript",
        logprobs: [{ logprob: -0.1 }],
      })
      .mockResolvedValueOnce({
        text: "chunk two transcript",
        logprobs: [{ logprob: -0.1 }],
      });
    dependencies.reconcileBatch.mockResolvedValue([]);

    await runTranscriptionFinalPass(
      meeting,
      { audioFilePath: "recording.mp3" },
      dependencies,
    );

    expect(dependencies.reconcileBatch).toHaveBeenCalledTimes(2);
    const firstCall = dependencies.reconcileBatch.mock.calls[0];
    const secondCall = dependencies.reconcileBatch.mock.calls[1];
    if (!firstCall || !secondCall) {
      throw new Error("expected reconcileBatch calls to be defined");
    }
    expect(firstCall[0].previousChunkTail).toBe("");
    expect(secondCall[0].previousChunkTail).toBe("chunk one transcript");
  });

  test("reconciles boundary segments in the following chunk", async () => {
    const meeting = buildBoundaryMeeting();
    const dependencies = buildDependencies();
    dependencies.getAudioDurationSeconds.mockResolvedValue(1_800);
    dependencies.transcribeChunk
      .mockResolvedValueOnce({
        text: "boundary",
        logprobs: [{ logprob: -0.1 }],
      })
      .mockResolvedValueOnce({
        text: "boundary line second chunk line",
        logprobs: [{ logprob: -0.1 }],
      });
    dependencies.reconcileBatch.mockResolvedValue([]);

    await runTranscriptionFinalPass(
      meeting,
      { audioFilePath: "recording.mp3" },
      dependencies,
    );

    const hasBoundarySegmentInSecondChunk =
      dependencies.reconcileBatch.mock.calls.some((call) => {
        const input = call[0];
        return (
          input.chunkIndex === 2 &&
          input.baselineSegments.some(
            (segment) => segment.segmentId === "seg-1",
          )
        );
      });

    expect(hasBoundarySegmentInSecondChunk).toBe(true);
  });
});
