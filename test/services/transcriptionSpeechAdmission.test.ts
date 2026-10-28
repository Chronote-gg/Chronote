/** @jest-environment node */
import {
  mkdtempSync,
  readdirSync,
  rmdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  ReadStream,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import OpenAI from "openai";
import type { MeetingData } from "../../src/types/meeting-data";
import type {
  SpeechAssessment,
  SpeechDetector,
} from "../../src/services/speechDetectionTypes";
import {
  createSpeechCoverage,
  DEFAULT_SPEECH_POLICY,
} from "../../src/services/speechDetectionPolicy";
import { metricsRegistry } from "../../src/metrics";
import {
  transcribeSnippet,
  transcribeContentSnippet,
  type TranscriptionContentInput,
} from "../../src/services/transcriptionService";
import * as conversion from "../../src/services/transcriptionAudioService";

let mockTempDir: string;
let mockPrompt = "";
const mockEnsureTemp = jest.fn(() => mockTempDir);
const consumeFile = async (file: ReadStream) => {
  for await (const chunk of file) void chunk;
};
const providerSuccess = async ({ file }: { file: ReadStream }) => {
  await consumeFile(file);
  return { text: "retained words", logprobs: [] as { logprob: number }[] };
};
const writeTestWav = async (_inputFile: string, outputFile: string) => {
  const wav = Buffer.alloc(44);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36, 4);
  wav.write("WAVE", 8);
  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24);
  wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  writeFileSync(outputFile, wav);
};
const mockAssess = jest.fn<
  ReturnType<SpeechDetector["assess"]>,
  Parameters<SpeechDetector["assess"]>
>();
const mockGetDetector = jest.fn(() => ({
  assess: mockAssess,
  warm: async () => true,
  shutdown: async () => {},
}));
const mockCreate = jest.fn(providerSuccess);
let mockConvert: jest.SpyInstance;
jest.mock("../../src/services/tempFileService", () => ({
  ensureMeetingTempDirSync: () => mockEnsureTemp(),
  getMeetingTempDir: () => mockTempDir,
}));
jest.mock("../../src/services/speechDetectionService", () => ({
  getSpeechDetector: () => mockGetDetector(),
}));
const mockOpenAIClient = { audio: { transcriptions: { create: mockCreate } } };
jest.mock("../../src/services/openaiClient", () => ({
  createOpenAIClient: () => mockOpenAIClient,
}));
jest.mock("../../src/services/transcriptionPromptService", () => ({
  getTranscriptionPrompt: async () => ({ prompt: mockPrompt }),
}));
jest.mock("../../src/services/modelFactory", () => ({
  getModelChoice: () => ({ model: "test" }),
  buildModelOverrides: () => undefined,
}));
jest.mock("../../src/services/langfuseClient", () => ({
  isLangfuseTracingEnabled: () => false,
}));
jest.mock("../../src/services/openaiChatService", () => ({ chat: jest.fn() }));
jest.mock("../../src/constants", () => ({
  ...jest.requireActual("../../src/constants"),
  TRANSCRIPTION_RATE_MIN_TIME: 0,
}));

const assessment = (
  kind: "speech" | "non_speech" | "uncertain",
): SpeechAssessment => ({
  kind,
  policyFingerprint: DEFAULT_SPEECH_POLICY.policyFingerprint,
  metrics: {
    peakSpeechProbability: kind === "speech" ? 0.8 : 0.2,
    maxConsecutiveSpeechFrames: kind === "speech" ? 2 : 0,
    scannedFrames: 32,
    totalFrames: 32,
    gain: 1,
  },
});
const buildMeeting = (mode: "off" | "shadow" | "enforce"): MeetingData =>
  ({
    meetingId: "test-meeting",
    creator: { id: "test-user" },
    guild: { id: "test-guild" },
    voiceChannel: { id: "test-voice", members: new Map() },
    runtimeConfig: {
      transcription: {
        speechDetectionMode: mode,
        suppressionEnabled: false,
        promptEchoEnabled: false,
        voteEnabled: false,
        noiseGate: { enabled: false },
      },
      modelChoices: {},
      modelParams: {},
    },
  }) as MeetingData;
const pcm = Buffer.alloc(192000);
const snippet = { userId: "test-user", timestamp: 1, chunks: [pcm] };

beforeEach(() => {
  mockTempDir = mkdtempSync(path.join(tmpdir(), "chronote-admission-"));
  mockConvert = jest
    .spyOn(conversion, "convertTranscriptionPcmToWav")
    .mockImplementation(writeTestWav);
  metricsRegistry.resetMetrics();
  mockGetDetector.mockClear();
  mockAssess.mockReset().mockResolvedValue(assessment("non_speech"));
  mockCreate.mockReset().mockImplementation(providerSuccess);
  mockPrompt = "";
});
afterEach(() => {
  mockConvert.mockRestore();
  expect(readdirSync(mockTempDir)).toEqual([]);
  rmdirSync(mockTempDir);
});

test("enforcedNonSpeechMakesNoProviderRequest", async () => {
  const originalPcm = Buffer.from(pcm);
  const result = await transcribeSnippet(buildMeeting("enforce"), snippet);
  expect(result).toMatchObject({ status: "skipped", reason: "non_speech" });
  expect(mockCreate).not.toHaveBeenCalled();
  expect(pcm.equals(originalPcm)).toBe(true);
  expect(readdirSync(mockTempDir)).toEqual([]);
});

test("abort during detection cannot finalize a nonspeech rejection or count a skipped request", async () => {
  const controller = new AbortController();
  mockAssess.mockImplementationOnce(async () => {
    controller.abort();
    return assessment("non_speech");
  });
  const meeting = buildMeeting("enforce");
  const input: TranscriptionContentInput = {
    meetingId: meeting.meetingId,
    creator: meeting.creator,
    guild: meeting.guild,
    voiceChannel: meeting.voiceChannel,
    runtimeConfig: meeting.runtimeConfig,
    signal: controller.signal,
    effect: (run) => run(),
    prompt: async () => ({ prompt: "", source: "fallback" }),
  };
  await expect(transcribeContentSnippet(input, snippet)).resolves.toMatchObject(
    { status: "failed" },
  );
  expect(mockCreate).not.toHaveBeenCalled();
  expect(await metricTotal("requests_skipped_total")).toBe(0);
  expect(await metricTotal("skipped_audio_seconds_total")).toBe(0);
  expect(
    await metricTotal("snippet_outcomes_total", { outcome: "vad_skipped" }),
  ).toBe(0);
});

import { PassThrough } from "node:stream";
import {
  subscribeToUserVoice,
  userStartTalking,
  startProcessingSnippet,
} from "../../src/audio";

jest.mock("../../src/liveVoice", () => ({ maybeRespondLive: jest.fn() }));
jest.mock("prism-media", () => ({
  opus: { Decoder: jest.requireActual("node:stream").PassThrough },
}));
jest.mock("syllable", () => ({
  syllable: (text: string) => text.split(/\s+/).length,
}));

const metricTotal = async (
  name: string,
  labels: Record<string, string> = {},
) => {
  const metric = (await metricsRegistry.getMetricsAsJSON()).find(
    (m) => m.name === `chronote_speech_detection_${name}`,
  );
  return (
    metric?.values
      .filter((v) =>
        Object.entries(labels).every(([key, value]) => v.labels[key] === value),
      )
      .reduce((sum, v) => sum + v.value, 0) ?? 0
  );
};
const expectOutcome = async (mode: string, outcome: string, count = 1) => {
  expect(await metricTotal("snippet_outcomes_total", { mode, outcome })).toBe(
    count,
  );
  expect(await metricTotal("snippet_outcomes_total")).toBe(count);
};

// Removing the explicit bypass or inferring it from other overrides must fail these cases.
test.each(["off", "shadow", "enforce"] as const)(
  "%s explicit force bypasses model work but counts submissions",
  async (mode) => {
    const result = await transcribeSnippet(buildMeeting(mode), snippet, {
      speechDetectionBypass: true,
    });
    expect(result).toMatchObject({
      status: "succeeded",
      text: "retained words",
      admission: { kind: "not_enforced", reason: "forced" },
    });
    expect(mockGetDetector).not.toHaveBeenCalled();
    expect(
      await metricTotal("provider_submissions_total", { mode, phase: "slow" }),
    ).toBe(1);
    await expectOutcome(mode, "transcribed");
  },
);
test("off supplies the baseline without acquiring a detector", async () => {
  expect(await transcribeSnippet(buildMeeting("off"), snippet)).toMatchObject({
    status: "succeeded",
    admission: { kind: "not_enforced", reason: "off" },
  });
  expect(mockGetDetector).not.toHaveBeenCalled();
  expect(await metricTotal("provider_submissions_total", { mode: "off" })).toBe(
    1,
  );
  expect(
    await metricTotal("submitted_audio_seconds_total", { mode: "off" }),
  ).toBe(1);
  await expectOutcome("off", "transcribed");
});
test.each(["speech", "uncertain", "unavailable"] as const)(
  "enforce preserves ASR on %s",
  async (kind) => {
    mockAssess.mockResolvedValue(
      kind === "unavailable"
        ? {
            kind,
            reason: "timeout",
            policyFingerprint: DEFAULT_SPEECH_POLICY.policyFingerprint,
          }
        : assessment(kind),
    );
    const result = await transcribeSnippet(buildMeeting("enforce"), snippet, {
      noiseGateMode: "fast",
    });
    expect(result).toMatchObject({
      status: "succeeded",
      admission: { kind: "assessed", assessment: { kind } },
    });
    expect(
      await metricTotal("provider_submissions_total", {
        mode: "enforce",
        phase: "fast",
      }),
    ).toBe(1);
    expect(await metricTotal("assessments_total", { kind })).toBe(1);
    await expectOutcome("enforce", "transcribed");
  },
);
test("suppression overrides do not silently bypass enforced rejection", async () => {
  expect(
    await transcribeSnippet(buildMeeting("enforce"), snippet, {
      noiseGateEnabledOverride: false,
      suppressionEnabledOverride: false,
    }),
  ).toMatchObject({ status: "skipped" });
  expect(await metricTotal("provider_submissions_total")).toBe(0);
  expect(await metricTotal("requests_skipped_total", { phase: "slow" })).toBe(
    1,
  );
  expect(
    await metricTotal("skipped_audio_seconds_total", { phase: "slow" }),
  ).toBe(1);
  await expectOutcome("enforce", "vad_skipped");
});
test("shadow submits ASR without waiting and late negatives only affect assessment metrics", async () => {
  let finish!: (assessment: SpeechAssessment) => void;
  let retainedWav: Uint8Array | undefined;
  mockAssess.mockImplementation((wav) => {
    retainedWav = wav;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const result = await transcribeSnippet(buildMeeting("shadow"), snippet);
  expect(result).toMatchObject({
    status: "succeeded",
    text: "retained words",
    admission: { kind: "not_enforced", reason: "shadow" },
  });
  expect(mockCreate).toHaveBeenCalledTimes(1);
  expect(readdirSync(mockTempDir)).toEqual([]);
  // The worker may read its owned bytes after every input file has been removed.
  expect(Buffer.from(retainedWav!).subarray(0, 4).toString()).toBe("RIFF");
  expect(await metricTotal("assessments_total")).toBe(0);
  finish(assessment("non_speech"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(result).toMatchObject({ status: "succeeded", text: "retained words" });
  expect(
    await metricTotal("assessments_total", {
      mode: "shadow",
      kind: "non_speech",
    }),
  ).toBe(1);
  expect(await metricTotal("requests_skipped_total")).toBe(0);
  await expectOutcome("shadow", "transcribed");
});
test.each(["shadow", "enforce"] as const)(
  "detectorErrorDoesNotBecomeProviderFailure (%s)",
  async (mode) => {
    mockAssess.mockRejectedValue(new Error("worker unavailable"));
    expect(await transcribeSnippet(buildMeeting(mode), snippet)).toMatchObject({
      status: "succeeded",
      text: "retained words",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(
      await metricTotal("assessments_total", {
        kind: "unavailable",
        reason: "worker_error",
      }),
    ).toBe(1);
    await expectOutcome(mode, "transcribed");
  },
);
test("conversion errors clean both files and record one conversion outcome", async () => {
  mockConvert.mockRejectedValueOnce(new Error("conversion failed"));
  expect(await transcribeSnippet(buildMeeting("enforce"), snippet)).toEqual({
    status: "failed",
    reason: "conversion_error",
  });
  expect(mockAssess).not.toHaveBeenCalled();
  expect(mockCreate).not.toHaveBeenCalled();
  await expectOutcome("enforce", "conversion_error");
});
test("counts actual failed and retried SDK submissions with one terminal outcome", async () => {
  mockCreate.mockImplementationOnce(async ({ file }) => {
    for await (const chunk of file) void chunk;
    throw new OpenAI.APIConnectionError({
      message: "provider transient failure",
    });
  });
  expect(await transcribeSnippet(buildMeeting("off"), snippet)).toMatchObject({
    status: "succeeded",
    text: "retained words",
  });
  expect(mockCreate).toHaveBeenCalledTimes(2);
  expect(await metricTotal("provider_submissions_total", { mode: "off" })).toBe(
    2,
  );
  expect(
    await metricTotal("submitted_audio_seconds_total", { mode: "off" }),
  ).toBe(2);
  await expectOutcome("off", "transcribed");
});
test("records received PCM once while repeated rejected fast snapshots do not shrink or multiply it", async () => {
  const meeting = buildMeeting("enforce");
  const source = new PassThrough({ objectMode: true });
  Object.assign(meeting, {
    guildId: "test-guild",
    channelId: "test-voice",
    participants: new Map(),
    audioData: { currentSnippets: new Map(), audioFiles: [] },
    connection: {
      state: { status: "ready" },
      receiver: voiceReceiver(source),
    },
  });
  await subscribeToUserVoice(meeting, "test-user");
  userStartTalking(meeting, "test-user");
  source.write(pcm);
  const received = meeting.audioData.currentSnippets.get("test-user")!;
  expect(
    await metricTotal("captured_audio_seconds_total", { mode: "enforce" }),
  ).toBe(1);
  for (let index = 0; index < 2; index++) {
    expect(
      await transcribeSnippet(meeting, received, { noiseGateMode: "fast" }),
    ).toMatchObject({ status: "skipped" });
  }
  expect(
    await metricTotal("captured_audio_seconds_total", { mode: "enforce" }),
  ).toBe(1);
  expect(await metricTotal("provider_submissions_total")).toBe(0);
  await expectOutcome("enforce", "vad_skipped", 2);
});

test("real voting counts prompt and no-prompt SDK calls, conversion and outcome happen once", async () => {
  const convert = jest.spyOn(conversion, "convertTranscriptionPcmToWav");
  mockPrompt = "transcription vocabulary";
  mockCreate.mockImplementationOnce(async ({ file }) => {
    await consumeFile(file);
    return { text: "uncertain words", logprobs: [{ logprob: -5 }] };
  });
  const meeting = buildMeeting("enforce");
  meeting.runtimeConfig!.transcription.voteEnabled = true;
  mockAssess.mockResolvedValue(assessment("speech"));
  try {
    expect(await transcribeSnippet(meeting, snippet)).toMatchObject({
      status: "succeeded",
      text: "retained words",
    });
    expect(convert).toHaveBeenCalledTimes(1);
    expect(mockAssess).toHaveBeenCalledTimes(1);
    expect(
      await metricTotal("provider_submissions_total", {
        mode: "enforce",
        candidate: "prompt",
      }),
    ).toBe(1);
    expect(
      await metricTotal("provider_submissions_total", {
        mode: "enforce",
        candidate: "no_prompt",
      }),
    ).toBe(1);
    expect(await metricTotal("submitted_audio_seconds_total")).toBe(2);
    await expectOutcome("enforce", "transcribed");
  } finally {
    convert.mockRestore();
  }
});
test("terminal SDK failure counts every retry but only one failed snippet", async () => {
  mockCreate.mockImplementation(async ({ file }) => {
    await consumeFile(file);
    throw new OpenAI.APIConnectionError({ message: "provider unavailable" });
  });
  expect(
    await transcribeSnippet(buildMeeting("enforce"), snippet, {
      speechDetectionBypass: true,
    }),
  ).toEqual({ status: "failed", reason: "transcription_error" });
  expect(mockCreate).toHaveBeenCalledTimes(4);
  expect(await metricTotal("provider_submissions_total")).toBe(4);
  expect(await metricTotal("submitted_audio_seconds_total")).toBe(4);
  await expectOutcome("enforce", "provider_error");
}, 15000);

test("temporary directory failure records a terminal conversion outcome", async () => {
  mockEnsureTemp.mockImplementationOnce(() => {
    throw new Error("directory unavailable");
  });
  expect(await transcribeSnippet(buildMeeting("off"), snippet)).toEqual({
    status: "failed",
    reason: "conversion_error",
  });
  expect(mockCreate).not.toHaveBeenCalled();
  await expectOutcome("off", "conversion_error");
});

// Exact proven coverage is the only enforcement shortcut; mismatches require full admission.
test("reuses identical proven PCM and policy without conversion or a new assessment", async () => {
  const convert = jest.spyOn(conversion, "convertTranscriptionPcmToWav");
  const coverage = createSpeechCoverage(
    pcm,
    DEFAULT_SPEECH_POLICY.policyFingerprint,
  );
  try {
    expect(
      await transcribeSnippet(buildMeeting("enforce"), snippet, {
        reuseTranscript: { text: "proven words", coverage },
      }),
    ).toEqual({
      status: "succeeded",
      text: "proven words",
      admission: { kind: "reused", coverage },
    });
    expect(convert).not.toHaveBeenCalled();
    expect(mockAssess).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
    await expectOutcome("enforce", "reused");
    expect(await metricTotal("provider_submissions_total")).toBe(0);
    expect(await metricTotal("assessments_total")).toBe(0);
  } finally {
    convert.mockRestore();
  }
});
test.each([
  "changed contents",
  "appended bytes",
  "changed policy",
  "unavailable",
  "forced",
])(
  "reuse candidate with %s shares one preparation and correct fallback",
  async (change) => {
    const coverage = createSpeechCoverage(
      pcm,
      change === "changed policy"
        ? "old-policy"
        : DEFAULT_SPEECH_POLICY.policyFingerprint,
    );
    const changedPcm =
      change === "appended bytes"
        ? Buffer.concat([pcm, Buffer.alloc(4)])
        : Buffer.from(pcm);
    if (change === "changed contents" || change === "unavailable")
      changedPcm[0] = 1;
    if (change === "unavailable")
      mockAssess.mockResolvedValue({
        kind: "unavailable",
        reason: "timeout",
        policyFingerprint: DEFAULT_SPEECH_POLICY.policyFingerprint,
      });
    const convert = jest.spyOn(conversion, "convertTranscriptionPcmToWav");
    try {
      const result = await transcribeSnippet(
        buildMeeting("enforce"),
        { ...snippet, chunks: [changedPcm] },
        {
          reuseTranscript: { text: "old guess", coverage },
          speechDetectionBypass: change === "forced",
        },
      );
      expect(result.status).toBe(
        change === "unavailable" || change === "forced"
          ? "succeeded"
          : "skipped",
      );
      expect(convert).toHaveBeenCalledTimes(1);
      expect(mockAssess).toHaveBeenCalledTimes(change === "forced" ? 0 : 1);
      expect(mockCreate).toHaveBeenCalledTimes(
        change === "unavailable" || change === "forced" ? 1 : 0,
      );
      expect(await metricTotal("snippet_outcomes_total")).toBe(1);
    } finally {
      convert.mockRestore();
    }
  },
);

test.each(["off", "shadow", "enforce"] as const)(
  "%s owner-only fast finalization counts one reuse without a new SDK call or captured denominator",
  async (mode) => {
    const meeting = buildMeeting(mode);
    const source = new PassThrough({ objectMode: true });
    Object.assign(meeting, {
      guildId: "test-guild",
      channelId: "test-voice",
      startTime: new Date(),
      participants: new Map(),
      audioData: { currentSnippets: new Map(), audioFiles: [] },
      connection: {
        state: { status: "ready" },
        receiver: voiceReceiver(source),
      },
    });
    Object.assign(meeting.runtimeConfig!.transcription, {
      fastFinalizationEnabled: true,
      minSnippetSeconds: 0.3,
      maxSnippetMs: 60000,
    });
    await subscribeToUserVoice(meeting, "test-user");
    userStartTalking(meeting, "test-user");
    source.write(pcm);
    const received = meeting.audioData.currentSnippets.get("test-user")!;
    received.timestamp = meeting.startTime.getTime();
    received.lastFastTranscriptBytes = pcm.length;
    received.lastFastSpeechCoverage = createSpeechCoverage(
      pcm,
      DEFAULT_SPEECH_POLICY.policyFingerprint,
    );
    const file = {
      userId: "test-user",
      timestamp: received.timestamp,
      processing: true,
      audioOnlyProcessing: false,
      fastTranscripts: [
        {
          revision: 1,
          text: "proven words",
          createdAt: "2025-01-01T00:00:00Z",
        },
      ],
      transcript: "proven words",
    };
    received.audioFileData = file;
    meeting.audioData.audioFiles.push(file);
    startProcessingSnippet(meeting, "test-user");
    await received.audioFileData.processingPromise;
    const track = meeting.audioData.speakerTracks!.get("test-user")!;
    await track.writePromise;
    try {
      expect(file.transcript).toBe("proven words");
      expect(readFileSync(track.filePath)).toEqual(pcm);
      expect(await metricTotal("captured_audio_seconds_total", { mode })).toBe(
        1,
      );
      expect(await metricTotal("provider_submissions_total")).toBe(0);
      expect(await metricTotal("assessments_total")).toBe(0);
      await expectOutcome(mode, "reused");
    } finally {
      unlinkSync(track.filePath);
      rmdirSync(path.dirname(track.filePath));
      meeting.finished = true;
      source.end();
    }
  },
);

function voiceReceiver(source: PassThrough) {
  return {
    packetDiagnostics: new WeakMap(),
    subscribe: () => source,
    subscriptions: new Map(),
  };
}
