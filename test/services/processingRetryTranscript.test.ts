/** @jest-environment node */
jest.mock("dotenv", () => ({ config: () => ({ parsed: {} }) }));
jest.mock("../../src/services/transcriptionService", () => ({
  ...jest.requireActual("../../src/services/transcriptionService"),
  transcribeContentSnippet: jest.fn(async () => ({
    status: "succeeded",
    text: "Recovered words.",
  })),
}));
jest.mock("../../src/services/storageService", () => ({
  ...jest.requireActual("../../src/services/storageService"),
  downloadObjectToFile: jest.fn(async () => true),
}));
jest.mock("../../src/services/personalMediaUploadProcessingService", () => ({
  runFfmpeg: jest.fn(async () => undefined),
  resolveTranscriptionInputs: jest.fn(async () => ["chunk-0.mp3"]),
  transcribeAudioFiles: jest.fn(async () => ({
    text: "Mixed words.",
    failedChunks: 0,
  })),
}));
import { existsSync } from "node:fs";
import path from "node:path";
import { transcribeContentSnippet } from "../../src/services/transcriptionService";
import { downloadObjectToFile } from "../../src/services/storageService";
import { transcribeAudioFiles } from "../../src/services/personalMediaUploadProcessingService";
import {
  readRecoveryContent,
  recoverTranscript,
  retranscribeOmittedRanges,
  TranscriptOverlapUnknown,
} from "../../src/services/meetingRecoveryContent";
import {
  retryTranscriptKey,
  storeRetryTranscript,
  transcribeMixedRecording,
} from "../../src/services/processingRetryTranscript";
import { resetMockStore } from "../../src/repositories/mockStore";
import type { TranscriptPayload } from "../../src/types/transcript";
import {
  pcmArtifact,
  recoveryFixture,
  savedTranscriptionPrompt,
} from "./meetingRecoveryFixtures";

const signal = new AbortController().signal;
const run = <T>(effect: () => Promise<T>) => effect();
const coverage = {
  pcmSha256: "sha",
  audioBytes: 1920,
  policyFingerprint: "policy",
};
const savedSpan = {
  sourceId: "user:123",
  sequence: 0,
  startByte: 0,
  endByte: 1920,
};

async function checkpointContent() {
  const f = await recoveryFixture("Saved words.", {
    context: savedTranscriptionPrompt,
    artifacts: [
      pcmArtifact("user:123", 0, Buffer.alloc(3840, 1), [
        { startOffsetMs: 0, durationMs: 20 },
      ]),
    ],
    transcript: (payload) => {
      payload.entries[0].correspondence = { kind: "pcm", spans: [savedSpan] };
      payload.omitted = {
        kind: "pcm",
        spans: [{ ...savedSpan, startByte: 1920, endByte: 3840 }],
      };
      payload.processing = {
        finalPass: "acknowledged",
        cleanup: "disabled",
        finalText: "Exact finalized input",
        correspondence: payload.entries[0].correspondence,
      };
    },
  });
  const content = await readRecoveryContent(f.claim.history, f.reader, signal);
  return { f, content };
}

beforeEach(() => {
  jest.clearAllMocks();
  resetMockStore();
});

test("re-transcribes only omitted ranges, keeps saved entries, and stays attributed", async () => {
  const { f, content } = await checkpointContent();
  const result = await retranscribeOmittedRanges(
    content,
    f.reader,
    signal,
    run,
  );
  expect(transcribeContentSnippet).toHaveBeenCalledTimes(1);
  expect(result.segments.map((s) => [s.userId, s.text])).toEqual([
    ["123", "Saved words."],
    ["123", "Recovered words."],
  ]);
  expect(result.text).not.toContain("Exact finalized input");
  expect(result.retranscribedRanges).toBe(1);
});

test.each([
  { status: "skipped" as const, reason: "non_speech" as const, coverage },
  {
    status: "succeeded" as const,
    text: "",
    admission: { kind: "not_enforced" as const, reason: "off" as const },
  },
])(
  "a range that comes back without text counts as handled but not recovered: %j",
  async (outcome) => {
    const { f, content } = await checkpointContent();
    jest.mocked(transcribeContentSnippet).mockResolvedValueOnce(outcome);
    await expect(
      retranscribeOmittedRanges(content, f.reader, signal, run),
    ).resolves.toMatchObject({
      segments: [{ text: "Saved words." }],
      retranscribedRanges: 0,
    });
  },
);

test("a provider failure on any range fails the transcription", async () => {
  const { f, content } = await checkpointContent();
  jest
    .mocked(transcribeContentSnippet)
    .mockResolvedValueOnce({ status: "failed", reason: "transcription_error" });
  await expect(
    retranscribeOmittedRanges(content, f.reader, signal, run),
  ).rejects.toThrow("Recovery transcription failed");
});

test("a retry never replays the frozen finalized-audio pass", async () => {
  const { f, content } = await checkpointContent();
  content.manifest.captureState = {
    kind: "complete",
    startedAt: f.claim.history.timestamp,
    endedAt: f.claim.history.timestamp,
  };
  if (content.context.settings.availability !== "available")
    throw new Error("settings");
  content.context.settings.value.transcription.finalPassEnabled = true;
  // The fixture has no final-pass prompt, so running the pass would throw.
  await expect(
    retranscribeOmittedRanges(content, f.reader, signal, run),
  ).resolves.toMatchObject({ retranscribedRanges: 1 });
  expect(content.processing?.finalPass).toBe("not_applicable");
});

test("recoverTranscript still refuses an acknowledged transcript with uncovered input", async () => {
  const { f, content } = await checkpointContent();
  await expect(
    recoverTranscript(content, f.reader, signal, run),
  ).rejects.toBeInstanceOf(TranscriptOverlapUnknown);
});

test("recoverTranscript treats never-transcribed audio the speech gate skips as handled, not failed", async () => {
  const { f, content } = await checkpointContent();
  content.processing = undefined;
  content.omitted = undefined;
  jest.mocked(transcribeContentSnippet).mockResolvedValueOnce({
    status: "skipped",
    reason: "non_speech",
    coverage,
  });
  await expect(
    recoverTranscript(content, f.reader, signal, run),
  ).resolves.toMatchObject({
    segments: [{ text: "Saved words." }],
    retranscribedRanges: 0,
  });
});

test("mixed recording transcription returns all chunk text and removes its temp dir", async () => {
  await expect(
    transcribeMixedRecording("g/c_m_t/audio.mp3", signal),
  ).resolves.toEqual({ text: "Mixed words." });
  expect(transcribeAudioFiles).toHaveBeenCalledWith(
    ["chunk-0.mp3"],
    false,
    signal,
  );
  const [, destination] = jest.mocked(downloadObjectToFile).mock.calls[0];
  expect(existsSync(path.dirname(destination))).toBe(false);
});

test("mixed recording transcription reports a missing object as source_missing", async () => {
  jest.mocked(downloadObjectToFile).mockResolvedValueOnce(false);
  await expect(
    transcribeMixedRecording("g/c_m_t/audio.mp3", signal),
  ).resolves.toBe("source_missing");
});

test("mixed recording transcription fails on any failed chunk", async () => {
  jest.mocked(transcribeAudioFiles).mockRejectedValueOnce(new Error("429"));
  await expect(
    transcribeMixedRecording("g/c_m_t/audio.mp3", signal),
  ).rejects.toThrow("429");
});

test.each([
  [
    { checkpoint: { artifactFolder: "p/g/c_m_t/" } },
    "p/g/c_m_t/transcript-retry-job-1.json",
  ],
  [
    { audioS3Key: "p/g/c_m_t/audio.mp3" },
    "p/g/c_m_t/transcript-retry-job-1.json",
  ],
  [
    { transcriptS3Key: "p/g/c_m_t/transcript.json" },
    "p/g/c_m_t/transcript-retry-job-1.json",
  ],
  [
    { audioS3Key: "audio.mp3", transcriptS3Key: "p/g/c_m_t/transcript.json" },
    "p/g/c_m_t/transcript-retry-job-1.json",
  ],
])("retry transcript key for %j", (row, key) =>
  expect(retryTranscriptKey(row, "job-1")).toBe(key),
);

test.each([{}, { audioS3Key: "" }, { audioS3Key: "audio.mp3" }])(
  "no retry transcript key without a folder: %j",
  (row) => expect(() => retryTranscriptKey(row, "job-1")).toThrow(),
);

test("storing the same transcript twice succeeds; a different body at the key throws", async () => {
  const key = "p/g/c_m_t/transcript-retry-job-1.json";
  const payload: TranscriptPayload = {
    generatedAt: "2026-10-28T00:00:00.000Z",
    segments: [{ userId: "123", startedAt: "2026-10-28T00:00:00.000Z" }],
    text: "Saved words.",
  };
  await storeRetryTranscript(key, payload, signal);
  await expect(
    storeRetryTranscript(key, payload, signal),
  ).resolves.toBeUndefined();
  await expect(
    storeRetryTranscript(key, { ...payload, text: "other" }, signal),
  ).rejects.toThrow();
});
