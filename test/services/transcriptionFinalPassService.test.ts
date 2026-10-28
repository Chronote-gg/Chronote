import { expectNoSpeechComparisonMetrics } from "../../src/testSupport/speechComparisonMetrics";
import { metricsRegistry } from "../../src/metrics";
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

expectNoSpeechComparisonMetrics(metricsRegistry);

describe("transcriptionFinalPassService", () => {
  test("reset cannot resurrect rejected files into the baseline", async () => {
    const meeting = buildMeeting();
    const dependencies = buildDependencies();
    const coverage = {
      pcmSha256: "synthetic",
      audioBytes: 4,
      policyFingerprint: "test",
    };
    for (const file of meeting.audioData.audioFiles) {
      file.finalSpeechRejection = coverage;
      file.finalPassTranscript = "late guess";
    }
    const result = await runTranscriptionFinalPass(
      meeting,
      { audioFilePath: "audio.mp3" },
      dependencies,
    );
    expect(result.totalSegments).toBe(0);
    expect(dependencies.transcribeChunk).not.toHaveBeenCalled();
    for (const file of meeting.audioData.audioFiles) {
      expect(file.finalSpeechRejection).toBe(coverage);
      expect(file.finalPassTranscript).toBeUndefined();
    }
  });
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

test("interruption waits the actual final-pass provider and prevents reconciliation dispatch", async () => {
  const { stopMeetingProcessing } =
    await import("../../src/services/meetingProcessingLifetime");
  const meeting = buildMeeting();
  const dependencies = buildDependencies();
  let entered!: () => void;
  const submitted = new Promise<void>((done) => {
    entered = done;
  });
  let release!: (value: { text: string }) => void;
  dependencies.transcribeChunk.mockImplementationOnce(async () => {
    entered();
    return new Promise((done) => {
      release = done;
    });
  });
  const actual = runTranscriptionFinalPass(
    meeting,
    { audioFilePath: "synthetic.mp3" },
    dependencies,
  );
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
  const heldBeforeRelease = !drained;
  release({ text: "late result" });
  await drain;
  expect(await outcome).toBe("cancelled");
  expect(heldBeforeRelease).toBe(true);
  expect(dependencies.reconcileBatch).not.toHaveBeenCalled();
});

test.each(["replace", "drop"] as const)(
  "accepted final-pass %s retains exact selected PCM disposition",
  async (action) => {
    const meeting = buildMeeting();
    const dependencies = buildDependencies();
    const receipt = {
      kind: "pcm" as const,
      spans: [
        { sourceId: "user:user-1", sequence: 0, startByte: 0, endByte: 3840 },
      ],
    };
    meeting.audioData.audioFiles[0].transcriptCorrespondence = receipt;
    // Keep one accepted edit below the existing deletion guardrail fraction.
    for (let i = 0; i < 8; i++)
      meeting.audioData.audioFiles.push(
        buildAudioFile({
          userId: `extra-${i}`,
          timestamp: meeting.startTime.getTime() + 5000 + i * 1000,
          transcript: `Independent conversation ${i}`,
        }),
      );
    dependencies.reconcileBatch.mockResolvedValue([
      {
        segmentId: "seg-1",
        action,
        text: action === "replace" ? "Corrected words" : undefined,
        confidence: 0.99,
      },
    ]);
    const result = await runTranscriptionFinalPass(
      meeting,
      { audioFilePath: "recording.mp3" },
      dependencies,
    );
    expect(result.applied).toBe(true);
    expect(meeting.audioData.audioFiles[0].finalPassTranscript).toBe(
      action === "replace" ? "Corrected words" : "",
    );
    expect(meeting.audioData.audioFiles[0].finalPassCorrespondence).toEqual(
      receipt,
    );
  },
);
