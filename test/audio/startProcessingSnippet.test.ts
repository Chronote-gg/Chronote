/** @jest-environment node */
import type { Client } from "discord.js";
import type { SnippetTranscriptionResult } from "../../src/types/audio";
import {
  createSpeechCoverage,
  DEFAULT_SPEECH_POLICY,
} from "../../src/services/speechDetectionPolicy";
import { resolveAudioFileText } from "../../src/utils/audioTranscript";
import fs from "node:fs";
import { Writable } from "node:stream";
import { maybeRespondLive } from "../../src/liveVoice";
jest.mock("dotenv", () => ({ config: jest.fn() }));
import { stopMeetingProcessing } from "../../src/services/meetingProcessingLifetime";
import type { MeetingData } from "../../src/types/meeting-data";
import type { AudioFileData, AudioSnippet } from "../../src/types/audio";
import {
  startProcessingSnippet,
  userStopTalking,
  clearSnippetTimer,
} from "../../src/audio";
import { compileTranscriptions } from "../../src/services/transcriptCompilationService";
import {
  coalesceTranscription,
  transcribeSnippet,
} from "../../src/services/transcriptionService";

jest.mock("../../src/liveVoice", () => ({
  maybeRespondLive: jest.fn(),
}));

jest.mock("../../src/services/transcriptionService", () => ({
  transcribeSnippet: jest.fn(),
  coalesceTranscription: jest.fn(),
}));

describe("startProcessingSnippet", () => {
  it("final rejection defeats a same-length fast guess and preserves captured bytes and offsets", async () => {
    const pcm = Buffer.alloc(192000, 1);
    const snippet: AudioSnippet = {
      userId: "u",
      timestamp: Date.parse("2025-01-01T00:00:01Z"),
      chunks: [pcm],
      audioBytes: pcm.length,
      lastFastTranscriptBytes: pcm.length,
    };
    const file: AudioFileData = {
      userId: "u",
      timestamp: snippet.timestamp,
      processing: true,
      audioOnlyProcessing: false,
      transcript: "old guess",
      fastTranscripts: [
        { revision: 1, text: "old guess", createdAt: "2025-01-01T00:00:01Z" },
      ],
    };
    snippet.audioFileData = file;
    const meeting = buildMeeting(snippet, file);
    meeting.runtimeConfig!.transcription.speechDetectionMode = "enforce";
    const coverage = {
      pcmSha256: "synthetic",
      audioBytes: pcm.length,
      policyFingerprint: "test",
    };
    jest
      .mocked(transcribeSnippet)
      .mockResolvedValue({ status: "skipped", reason: "non_speech", coverage });
    startProcessingSnippet(meeting, "u");
    await waitForSnippetWork(meeting, file);
    expect(file.finalSpeechRejection).toEqual(coverage);
    expect(file.transcriptionFailed).toBe(false);
    expect(resolveAudioFileText(file)).toBe("");
    expect(snippet.chunks[0]).toEqual(Buffer.alloc(192000, 1));
    expect(file.timestamp).toBe(Date.parse("2025-01-01T00:00:01Z"));
  });

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

  const waitForSnippetWork = async (
    meeting: MeetingData,
    fileData: AudioFileData,
  ) => {
    await fileData.processingPromise;
    await meeting.audioData.speakerTracks?.get(fileData.userId)?.writePromise;
  };

  it("passes explicit speech detection bypass for a pending forced live command", async () => {
    const snippet: AudioSnippet = {
      userId: "user-1",
      timestamp: new Date("2025-01-01T00:00:01.000Z").getTime(),
      chunks: [Buffer.alloc(100)],
    };
    const fileData: AudioFileData = {
      userId: snippet.userId,
      timestamp: snippet.timestamp,
      processing: true,
      audioOnlyProcessing: false,
    };
    snippet.audioFileData = fileData;
    const meeting = buildMeeting(snippet, fileData);
    meeting.liveVoiceCommandPending = {
      type: "end_meeting",
      userId: snippet.userId,
      requestedAt: Date.now(),
      expiresAt: Date.now() + 10000,
    };
    jest.mocked(transcribeSnippet).mockResolvedValue({
      status: "succeeded",
      text: "command",
      admission: { kind: "not_enforced", reason: "forced" },
    });
    userStopTalking(meeting, snippet.userId);
    await waitForSnippetWork(meeting, fileData);
    expect(transcribeSnippet).toHaveBeenCalledWith(
      meeting,
      snippet,
      expect.objectContaining({
        speechDetectionBypass: true,
        noiseGateEnabledOverride: false,
        suppressionEnabledOverride: false,
      }),
    );
  });

  it("skips slow transcription when fast covers the snippet", async () => {
    const snippet: AudioSnippet = {
      userId: "user-1",
      timestamp: new Date("2025-01-01T00:00:01.000Z").getTime(),
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
    await waitForSnippetWork(meeting, audioFileData);

    expect(transcribeSnippet).not.toHaveBeenCalled();
    expect(audioFileData.transcript).toBe("hello there");
    expect(meeting.audioData.currentSnippets.has(snippet.userId)).toBe(false);
  });

  it("records successful slow transcription when fast does not cover the snippet", async () => {
    const snippet: AudioSnippet = {
      userId: "user-1",
      timestamp: new Date("2025-01-01T00:00:01.000Z").getTime(),
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
    (transcribeSnippet as jest.Mock).mockResolvedValue({
      status: "succeeded",
      admission: { kind: "not_enforced", reason: "off" },
      text: "slow text",
    });

    startProcessingSnippet(meeting, snippet.userId);
    await waitForSnippetWork(meeting, audioFileData);

    expect(transcribeSnippet).toHaveBeenCalledTimes(1);
    expect(audioFileData.transcript).toBe("slow text");
    expect(audioFileData.transcriptionFailed).toBe(false);
    expect(audioFileData.processing).toBe(false);
  });

  it("records one terminal slow transcription failure without placeholder text", async () => {
    const snippet: AudioSnippet = {
      userId: "user-1",
      timestamp: new Date("2025-01-01T00:00:01.000Z").getTime(),
      chunks: [Buffer.alloc(60_000)],
      audioBytes: 60_000,
    };
    const audioFileData: AudioFileData = {
      userId: snippet.userId,
      timestamp: snippet.timestamp,
      source: "voice",
      processing: true,
      audioOnlyProcessing: false,
    };
    snippet.audioFileData = audioFileData;
    const meeting = buildMeeting(snippet, audioFileData);
    (transcribeSnippet as jest.Mock).mockResolvedValue({
      status: "failed",
      reason: "transcription_error",
    });

    startProcessingSnippet(meeting, snippet.userId);
    await waitForSnippetWork(meeting, audioFileData);

    expect(audioFileData.transcriptionFailed).toBe(true);
    expect(audioFileData.transcript ?? "").not.toContain(
      "[Transcription failed]",
    );
    expect(audioFileData.processing).toBe(false);
  });

  it("treats a successful empty slow response as resolved work", async () => {
    const snippet: AudioSnippet = {
      userId: "user-1",
      timestamp: new Date("2025-01-01T00:00:01.000Z").getTime(),
      chunks: [Buffer.alloc(60_000)],
      audioBytes: 60_000,
    };
    const audioFileData: AudioFileData = {
      userId: snippet.userId,
      timestamp: snippet.timestamp,
      source: "voice",
      processing: true,
      audioOnlyProcessing: false,
      transcriptionFailed: true,
    };
    snippet.audioFileData = audioFileData;
    const meeting = buildMeeting(snippet, audioFileData);
    (transcribeSnippet as jest.Mock).mockResolvedValue({
      status: "succeeded",
      admission: { kind: "not_enforced", reason: "off" },
      text: "",
    });

    startProcessingSnippet(meeting, snippet.userId);
    await waitForSnippetWork(meeting, audioFileData);

    expect(audioFileData.slowTranscript).toBe("");
    expect(audioFileData.transcriptionFailed).toBe(false);
  });

  it("ignores a stale fast revision after slow transcription succeeds", async () => {
    jest.useFakeTimers();
    let resolveFast!: (value: {
      status: "succeeded";
      text: string;
      admission: { kind: "not_enforced"; reason: "off" };
    }) => void;
    const fastResult = new Promise<{
      status: "succeeded";
      text: string;
      admission: { kind: "not_enforced"; reason: "off" };
    }>((resolve) => {
      resolveFast = resolve;
    });
    const snippet: AudioSnippet = {
      userId: "user-1",
      timestamp: new Date("2025-01-01T00:00:01.000Z").getTime(),
      chunks: [Buffer.alloc(60_000)],
      audioBytes: 60_000,
    };
    const audioFileData: AudioFileData = {
      userId: snippet.userId,
      timestamp: snippet.timestamp,
      source: "voice",
      processing: true,
      audioOnlyProcessing: false,
    };
    snippet.audioFileData = audioFileData;
    const meeting = buildMeeting(snippet, audioFileData);
    (transcribeSnippet as jest.Mock)
      .mockReturnValueOnce(fastResult)
      .mockResolvedValueOnce({
        status: "succeeded",
        text: "slow complete",
        admission: { kind: "not_enforced", reason: "off" },
      });

    userStopTalking(meeting, snippet.userId);
    jest.advanceTimersByTime(400);
    startProcessingSnippet(meeting, snippet.userId);
    await waitForSnippetWork(meeting, audioFileData);
    resolveFast({
      status: "succeeded",
      text: "stale prefix",
      admission: { kind: "not_enforced", reason: "off" },
    });
    await Promise.resolve();

    expect(audioFileData.transcript).toBe("slow complete");
    expect(audioFileData.fastTranscripts).toBeUndefined();
    jest.useRealTimers();
  });

  it("retains a partial fast prefix when the required slow pass fails", async () => {
    const snippet: AudioSnippet = {
      userId: "user-1",
      timestamp: new Date("2025-01-01T00:00:01.000Z").getTime(),
      chunks: [Buffer.alloc(60_000)],
      audioBytes: 60_000,
      lastFastTranscriptBytes: 10,
    };
    const audioFileData: AudioFileData = {
      userId: snippet.userId,
      timestamp: snippet.timestamp,
      source: "voice",
      processing: true,
      audioOnlyProcessing: false,
      transcript: "usable prefix",
      fastTranscripts: [
        {
          revision: 1,
          text: "usable prefix",
          createdAt: new Date().toISOString(),
        },
      ],
    };
    snippet.audioFileData = audioFileData;
    const meeting = buildMeeting(snippet, audioFileData);
    (transcribeSnippet as jest.Mock).mockResolvedValue({
      status: "failed",
      reason: "transcription_error",
    });

    startProcessingSnippet(meeting, snippet.userId);
    await waitForSnippetWork(meeting, audioFileData);

    expect(audioFileData.transcript).toBe("usable prefix");
    expect(audioFileData.transcriptionFailed).toBe(true);
  });

  it("retains successful slow text when optional coalescing fails", async () => {
    const snippet: AudioSnippet = {
      userId: "user-1",
      timestamp: new Date("2025-01-01T00:00:01.000Z").getTime(),
      chunks: [Buffer.alloc(60_000)],
      audioBytes: 60_000,
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
          text: "fast draft",
          createdAt: new Date().toISOString(),
        },
      ],
    };
    snippet.audioFileData = audioFileData;
    const meeting = buildMeeting(snippet, audioFileData);
    meeting.runtimeConfig!.premiumTranscription.enabled = true;
    (transcribeSnippet as jest.Mock).mockResolvedValue({
      status: "succeeded",
      admission: { kind: "not_enforced", reason: "off" },
      text: "slow baseline",
    });
    (coalesceTranscription as jest.Mock).mockRejectedValue(
      new Error("optional refinement failed"),
    );
    const diagnostic = jest
      .spyOn(console, "error")
      .mockImplementation(() => {});

    startProcessingSnippet(meeting, snippet.userId);
    await waitForSnippetWork(meeting, audioFileData);

    expect(audioFileData.transcript).toBe("slow baseline");
    expect(audioFileData.transcriptionFailed).toBe(false);
    expect(audioFileData.coalescedTranscript).toBeUndefined();
    expect(diagnostic).toHaveBeenCalledWith(
      expect.stringContaining("coalesc"),
      expect.any(Error),
    );
    diagnostic.mockRestore();
  });
  it("retains an issued slow provider and refuses its late transcript after processing stop", async () => {
    const snippet: AudioSnippet = {
      userId: "synthetic",
      timestamp: new Date("2025-01-01T00:00:01.000Z").getTime(),
      chunks: [Buffer.alloc(10)],
      audioBytes: 60000,
    };
    const fileData: AudioFileData = {
      userId: snippet.userId,
      timestamp: snippet.timestamp,
      processing: false,
      audioOnlyProcessing: false,
    };
    snippet.audioFileData = fileData;
    const meeting = buildMeeting(snippet, fileData);
    let finish!: (value: { status: "succeeded"; text: string }) => void;
    jest.mocked(transcribeSnippet).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    startProcessingSnippet(meeting, snippet.userId);
    let settled = false;
    const drain = stopMeetingProcessing(meeting).then(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    finish({ status: "succeeded", text: "late synthetic text" });
    await drain;
    expect(fileData.transcript).toBeUndefined();
  });

  it.each([false, true])(
    "speaker-track ownership waits for actual close, including a preceding error: %s",
    async (failBeforeClose) => {
      const diagnostic = jest
        .spyOn(console, "error")
        .mockImplementation(() => {});
      const snippet: AudioSnippet = {
        userId: "held-close",
        timestamp: new Date("2025-01-01T00:00:01.000Z").getTime(),
        chunks: [Buffer.alloc(60000)],
        audioBytes: 60000,
      };
      const file: AudioFileData = {
        userId: snippet.userId,
        timestamp: snippet.timestamp,
        processing: false,
        audioOnlyProcessing: false,
      };
      snippet.audioFileData = file;
      const meeting = buildMeeting(snippet, file);
      let close!: () => void;
      const stream = new Writable({
        write(_chunk, _encoding, done) {
          done();
        },
        destroy(_error, done) {
          close = () => done();
        },
      });
      const mkdir = jest
        .spyOn(fs.promises, "mkdir")
        .mockResolvedValue(undefined);
      const output = jest
        .spyOn(fs, "createWriteStream")
        .mockReturnValue(stream as fs.WriteStream);
      jest
        .mocked(transcribeSnippet)
        .mockResolvedValueOnce({ status: "succeeded", text: "" });
      startProcessingSnippet(meeting, snippet.userId);
      for (let i = 0; i < 20; i++)
        await new Promise((done) => setImmediate(done));
      expect(stream.writableFinished).toBe(true);
      expect(stream.closed).toBe(false);
      if (failBeforeClose)
        stream.emit("error", new Error("synthetic late file failure"));
      let settled = false;
      const drain = stopMeetingProcessing(meeting).then(() => {
        settled = true;
      });
      for (let i = 0; i < 10; i++)
        await new Promise((done) => setImmediate(done));
      expect(settled).toBe(false);
      close();
      await drain;
      expect(stream.closed).toBe(true);
      if (failBeforeClose)
        expect(diagnostic).toHaveBeenCalledWith(
          expect.stringContaining("Failed to persist speaker track"),
          expect.any(Error),
        );
      diagnostic.mockRestore();
      mkdir.mockRestore();
      output.mockRestore();
    },
  );

  it("fast transcription retains its separately dispatched live response", async () => {
    jest.useFakeTimers();
    const snippet: AudioSnippet = {
      userId: "held-live",
      timestamp: new Date("2025-01-01T00:00:01.000Z").getTime(),
      chunks: [Buffer.alloc(60000)],
      audioBytes: 60000,
    };
    const file: AudioFileData = {
      userId: snippet.userId,
      timestamp: snippet.timestamp,
      processing: false,
      audioOnlyProcessing: false,
    };
    snippet.audioFileData = file;
    const meeting = buildMeeting(snippet, file);
    let release!: () => void;
    jest.mocked(maybeRespondLive).mockImplementationOnce(
      () =>
        new Promise<void>((done) => {
          release = done;
        }),
    );
    jest.mocked(transcribeSnippet).mockResolvedValueOnce({
      status: "succeeded",
      text: "synthetic live request",
      admission: { kind: "not_enforced", reason: "off" },
    });
    userStopTalking(meeting, snippet.userId);
    await jest.advanceTimersByTimeAsync(400);
    expect(maybeRespondLive).toHaveBeenCalledTimes(1);
    let settled = false;
    const drain = stopMeetingProcessing(meeting).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await drain;
    jest.clearAllTimers();
    jest.useRealTimers();
  });
  it.each(["coalesced", "slow-fallback"] as const)(
    "selected %s text keeps exact complete input receipt",
    async (mode) => {
      const spans = [
        { sourceId: "user:user-1", sequence: 0, startByte: 0, endByte: 60000 },
      ];
      const snippet: AudioSnippet = {
        userId: "user-1",
        timestamp: 1000,
        chunks: [Buffer.alloc(60000)],
        audioBytes: 60000,
        pcmSpans: spans,
      };
      const file: AudioFileData = {
        userId: "user-1",
        timestamp: 1000,
        processing: false,
        audioOnlyProcessing: false,
        fastTranscripts: [
          {
            revision: 1,
            text: "fast",
            createdAt: new Date().toISOString(),
            correspondence: {
              kind: "pcm",
              spans: [{ ...spans[0], endByte: 10000 }],
            },
          },
        ],
      };
      snippet.audioFileData = file;
      const meeting = buildMeeting(snippet, file);
      meeting.runtimeConfig!.premiumTranscription.enabled = true;
      jest
        .mocked(transcribeSnippet)
        .mockResolvedValueOnce({ status: "succeeded", text: "slow" });
      if (mode === "coalesced")
        jest.mocked(coalesceTranscription).mockResolvedValueOnce("merged");
      else
        jest
          .mocked(coalesceTranscription)
          .mockRejectedValueOnce(new Error("optional failed"));
      const error = jest.spyOn(console, "error").mockImplementation(() => {});
      try {
        startProcessingSnippet(meeting, "user-1");
        await waitForSnippetWork(meeting, file);
        const { resolveAudioFileTranscript } =
          await import("../../src/utils/audioTranscript");
        expect(resolveAudioFileTranscript(file)).toEqual({
          text: mode === "coalesced" ? "merged" : "slow",
          correspondence: { kind: "pcm", spans },
        });
      } finally {
        error.mockRestore();
      }
    },
  );
  it.each(["minimum", "gate", "empty", "empty-with-prefix"] as const)(
    "terminal %s does not claim unselected input",
    async (mode) => {
      jest.mocked(transcribeSnippet).mockReset();
      const bytes = mode === "minimum" ? 3840 : 60000;
      const spans = [
        { sourceId: "user:user-1", sequence: 0, startByte: 0, endByte: bytes },
      ];
      const prefix = {
        kind: "pcm" as const,
        spans: [{ ...spans[0], endByte: 3840 }],
      };
      const snippet: AudioSnippet = {
        userId: "user-1",
        timestamp: 1000,
        chunks: [Buffer.alloc(bytes)],
        audioBytes: bytes,
        pcmSpans: spans,
      };
      const file: AudioFileData = {
        userId: "user-1",
        timestamp: 1000,
        processing: false,
        audioOnlyProcessing: false,
        ...(mode === "empty-with-prefix"
          ? {
              fastTranscripts: [
                {
                  revision: 1,
                  text: "prefix",
                  createdAt: new Date().toISOString(),
                  correspondence: prefix,
                },
              ],
            }
          : {}),
      };
      snippet.audioFileData = file;
      const meeting = buildMeeting(snippet, file);
      if (mode === "gate")
        meeting.runtimeConfig!.transcription.noiseGate.enabled = true;
      jest
        .mocked(transcribeSnippet)
        .mockResolvedValueOnce({ status: "succeeded", text: "" });
      startProcessingSnippet(meeting, "user-1");
      await waitForSnippetWork(meeting, file);
      const { resolveAudioFileTranscript } =
        await import("../../src/utils/audioTranscript");
      expect(resolveAudioFileTranscript(file)).toEqual({
        text: mode === "empty-with-prefix" ? "prefix" : "",
        correspondence:
          mode === "empty-with-prefix" ? prefix : { kind: "pcm", spans },
      });
      if (mode === "gate" || mode === "minimum")
        expect(transcribeSnippet).not.toHaveBeenCalled();
    },
  );
  it("late stale fast result cannot replace slow selected text or correspondence", async () => {
    jest.useFakeTimers();
    jest.mocked(transcribeSnippet).mockReset();
    const spans = [
      { sourceId: "user:user-1", sequence: 0, startByte: 0, endByte: 60000 },
    ];
    const snippet: AudioSnippet = {
      userId: "user-1",
      timestamp: 1000,
      chunks: [Buffer.alloc(60000)],
      audioBytes: 60000,
      pcmSpans: spans,
    };
    const file: AudioFileData = {
      userId: "user-1",
      timestamp: 1000,
      processing: false,
      audioOnlyProcessing: false,
    };
    snippet.audioFileData = file;
    const meeting = buildMeeting(snippet, file);
    let complete!: (result: { status: "succeeded"; text: string }) => void;
    jest
      .mocked(transcribeSnippet)
      .mockReturnValueOnce(
        new Promise((resolve) => {
          complete = resolve;
        }),
      )
      .mockResolvedValueOnce({ status: "succeeded", text: "settled slow" });
    try {
      userStopTalking(meeting, "user-1");
      await jest.advanceTimersByTimeAsync(400);
      startProcessingSnippet(meeting, "user-1");
      await waitForSnippetWork(meeting, file);
      complete({ status: "succeeded", text: "stale fast" });
      await jest.advanceTimersByTimeAsync(0);
      expect(file.fastTranscripts).toBeUndefined();
      expect(file.slowCorrespondence).toEqual({ kind: "pcm", spans });
      expect(file.transcript).toBe("settled slow");
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });
  const fastFixture = () => {
    const snippet: AudioSnippet = {
      userId: "u",
      timestamp: Date.parse("2025-01-01T00:00:01Z"),
      chunks: [Buffer.alloc(192000, 1)],
      audioBytes: 192000,
    };
    const file: AudioFileData = {
      userId: "u",
      timestamp: snippet.timestamp,
      processing: true,
      audioOnlyProcessing: false,
    };
    snippet.audioFileData = file;
    const meeting = buildMeeting(snippet, file);
    meeting.runtimeConfig!.transcription.speechDetectionMode = "enforce";
    const coverage = createSpeechCoverage(
      snippet.chunks[0],
      DEFAULT_SPEECH_POLICY.policyFingerprint,
    );
    return { snippet, file, meeting, coverage };
  };
  it.each(["speech", "uncertain", "empty", "trivial"])(
    "records reusable coverage only for current usable speech: %s",
    async (kind) => {
      jest.useFakeTimers();
      try {
        const { snippet, file, meeting, coverage } = fastFixture();
        snippet.lastFastSpeechCoverage = coverage;
        jest.mocked(transcribeSnippet).mockResolvedValue({
          status: "succeeded",
          text:
            kind === "empty" ? "" : kind === "trivial" ? "..." : "usable words",
          admission: {
            kind: "assessed",
            coverage,
            assessment: {
              kind: kind === "uncertain" ? "uncertain" : "speech",
              policyFingerprint: coverage.policyFingerprint,
              metrics: {
                peakSpeechProbability: 0.8,
                maxConsecutiveSpeechFrames: 2,
                scannedFrames: 2,
                totalFrames: 32,
                gain: 1,
              },
            },
          },
        });
        userStopTalking(meeting, "u");
        await jest.advanceTimersByTimeAsync(400);
        expect(snippet.lastFastSpeechCoverage).toEqual(
          kind === "speech" ? coverage : undefined,
        );
        expect(file.finalSpeechRejection).toBeUndefined();
        clearSnippetTimer(meeting, "u");
      } finally {
        jest.useRealTimers();
      }
    },
  );
  it("a later fast rejection invalidates reusable proof without rejecting the full file", async () => {
    jest.useFakeTimers();
    try {
      const { snippet, file, meeting, coverage } = fastFixture();
      snippet.lastFastSpeechCoverage = coverage;
      file.transcript = "prior usable text";
      jest.mocked(transcribeSnippet).mockResolvedValue({
        status: "skipped",
        reason: "non_speech",
        coverage,
      });
      userStopTalking(meeting, "u");
      await jest.advanceTimersByTimeAsync(400);
      expect(snippet.lastFastSpeechCoverage).toBeUndefined();
      expect(file.finalSpeechRejection).toBeUndefined();
      expect(resolveAudioFileText(file)).toBe("prior usable text");
      clearSnippetTimer(meeting, "u");
    } finally {
      jest.useRealTimers();
    }
  });
  it.each(["finalized", "restarted"])(
    "late fast reply after %s cannot restore rejected text or reusable proof",
    async (state) => {
      jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
      try {
        const { snippet, file, meeting, coverage } = fastFixture();
        let reply!: (result: SnippetTranscriptionResult) => void;
        jest.mocked(transcribeSnippet).mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              reply = resolve;
            }),
        );
        userStopTalking(meeting, "u");
        await jest.advanceTimersByTimeAsync(400);
        clearSnippetTimer(meeting, "u");
        if (state === "finalized") {
          jest.mocked(transcribeSnippet).mockResolvedValue({
            status: "skipped",
            reason: "non_speech",
            coverage,
          });
          startProcessingSnippet(meeting, "u");
          await waitForSnippetWork(meeting, file);
        } else {
          meeting.audioData.currentSnippets.set("u", {
            ...snippet,
            chunks: [Buffer.alloc(192000, 2)],
            audioFileData: undefined,
          });
        }
        reply({
          status: "succeeded",
          text: "late old-worker guess",
          admission: {
            kind: "assessed",
            coverage,
            assessment: {
              kind: "speech",
              policyFingerprint: coverage.policyFingerprint,
              metrics: {
                peakSpeechProbability: 0.8,
                maxConsecutiveSpeechFrames: 2,
                scannedFrames: 2,
                totalFrames: 32,
                gain: 1,
              },
            },
          },
        });
        await Promise.resolve();
        expect(resolveAudioFileText(file)).toBe("");
        expect(snippet.lastFastSpeechCoverage).toBeUndefined();
        expect(await compileTranscriptions({} as Client, meeting)).toBe("");
      } finally {
        jest.useRealTimers();
      }
    },
  );
  it.each(["changed contents", "changed policy", "forced"])(
    "owner refuses an earlier fast proof after %s",
    async (change) => {
      const { snippet, file, meeting, coverage } = fastFixture();
      snippet.lastFastSpeechCoverage = {
        ...coverage,
        policyFingerprint:
          change === "changed policy"
            ? "old-policy"
            : coverage.policyFingerprint,
      };
      snippet.lastFastTranscriptBytes = 192000;
      file.transcript = "earlier guess";
      file.fastTranscripts = [
        {
          revision: 1,
          text: "earlier guess",
          createdAt: "2025-01-01T00:00:01Z",
        },
      ];
      if (change === "changed contents")
        snippet.chunks = [Buffer.alloc(192000, 2)];
      jest.mocked(transcribeSnippet).mockResolvedValue(
        change === "forced"
          ? {
              status: "succeeded",
              text: "fresh forced words",
              admission: { kind: "not_enforced", reason: "forced" },
            }
          : { status: "skipped", reason: "non_speech", coverage },
      );
      startProcessingSnippet(meeting, "u", {
        forceTranscribe: change === "forced",
      });
      await waitForSnippetWork(meeting, file);
      expect(file.finalSpeechRejection).toEqual(
        change === "forced" ? undefined : coverage,
      );
      expect(resolveAudioFileText(file)).toBe(
        change === "forced" ? "fresh forced words" : "",
      );
      expect(transcribeSnippet).toHaveBeenCalledWith(
        meeting,
        snippet,
        expect.objectContaining({ speechDetectionBypass: change === "forced" }),
      );
    },
  );
});
