import {
  transcriptionVadReportSchema,
  validateVadCase,
} from "../../src/evals/transcriptionVadReport";
import { runTranscriptionQualityCase } from "../../src/evals/transcriptionQualityCase";

const decision = {
  id: "tone",
  sha256: "a".repeat(64),
  shouldTranscribe: false,
  peakSpeechProbability: 0.01,
  maxConsecutiveSpeechFrames: 0,
  gain: 1,
  durationMs: 1,
};
const item = {
  id: "tone",
  file: "tone.wav",
  sha256: "a".repeat(64),
  split: "tune" as const,
  tags: [],
  label: { kind: "nonspeech" as const, provenance: "synthetic" as const },
};
test("requires VAD decisions to match the exact labeled audio", () => {
  expect(validateVadCase(item, [decision])).toEqual(decision);
  expect(() => validateVadCase(item, [])).toThrow("Missing or stale");
  expect(() =>
    validateVadCase(item, [{ ...decision, sha256: "b".repeat(64) }]),
  ).toThrow("Missing or stale");
  expect(
    transcriptionVadReportSchema.safeParse({
      version: 1,
      detector: "silero",
      modelSha256: "a".repeat(64),
      runtimeVersion: "test",
      numpyVersion: "test",
      parameters: {
        threshold: 0.5,
        minFrames: 2,
        normalizeDbfs: null,
        maxGain: 100,
      },
      cases: [decision, decision],
    }).success,
  ).toBe(false);
});

test("an experimental speech rejection avoids the request and records lost speech", async () => {
  const pcm = Buffer.alloc(48000 * 4);
  for (let index = 0; index < pcm.length; index += 2)
    pcm.writeInt16LE(4000, index);
  const result = await runTranscriptionQualityCase({
    pcm,
    reference: "Yes",
    mode: "pipeline",
    passMode: "fast",
    policy: {},
    prompt: "",
    force: false,
    vad: decision,
    transcribe: async () => {
      throw new Error("must not be called");
    },
  });
  expect(result).toMatchObject({
    status: "skipped",
    reason: "vad",
    requests: 0,
    score: { speechDropped: true },
  });
});
