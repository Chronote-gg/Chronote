import {
  runTranscriptionQualityCase,
  TranscriptionBudgetExhausted,
} from "../../src/evals/transcriptionQualityCase";

const silence = Buffer.alloc(48000 * 2 * 2);
const tone = Buffer.from(silence);
for (let index = 0; index < tone.length; index += 2)
  tone.writeInt16LE(4000, index);
const options = {
  prompt: "Dictionary: VRChat",
  passMode: "slow" as const,
  policy: {},
  force: false,
};

test("avoids a provider request for silence and scores explicit nonspeech", async () => {
  let calls = 0;
  const result = await runTranscriptionQualityCase({
    ...options,
    mode: "pipeline",
    pcm: silence,
    reference: "",
    transcribe: async () => {
      calls++;
      return { text: "hello" };
    },
  });
  expect(calls).toBe(0);
  expect(result.status).toBe("skipped");
  expect(result.requests).toBe(0);
  expect(result.score).toMatchObject({ scored: true, exactMatch: true });
});
test("provider mode bypasses the gate and measures the raw hallucination", async () => {
  const result = await runTranscriptionQualityCase({
    ...options,
    mode: "provider",
    pcm: silence,
    reference: "",
    transcribe: async () => ({ text: "VRChat" }),
  });
  expect(result.status).toBe("succeeded");
  expect(result.requests).toBe(1);
  expect(result.score).toMatchObject({ unwantedOutput: true });
});
test("a failed request is unscored and remains counted as submitted audio", async () => {
  const result = await runTranscriptionQualityCase({
    ...options,
    mode: "pipeline",
    pcm: tone,
    reference: "",
    transcribe: async () => {
      throw new Error("request failed");
    },
  });
  expect(result).toMatchObject({
    status: "failed",
    requests: 1,
    submittedAudioSeconds: 1,
    score: { scored: false },
  });
});
test("preflight never calls the provider or invents a successful speech score", async () => {
  const result = await runTranscriptionQualityCase({
    ...options,
    mode: "preflight",
    pcm: tone,
    reference: "yes",
    transcribe: async () => {
      throw new Error("must not be called");
    },
  });
  expect(result).toMatchObject({
    status: "eligible",
    requests: 0,
    score: { scored: false },
  });
});
test("counts both candidate requests and retains usage when rejecting both", async () => {
  const result = await runTranscriptionQualityCase({
    ...options,
    mode: "pipeline",
    pcm: tone,
    reference: "",
    transcribe: async () => ({
      text: "The Den",
      logprobs: [{ logprob: -3 }],
      usage: { type: "duration", seconds: 1 },
    }),
  });
  expect(result).toMatchObject({
    status: "succeeded",
    requests: 2,
    submittedAudioSeconds: 2,
    selectedId: "none",
    text: "",
  });
  expect(result.candidates).toHaveLength(2);
});
test("a forced request bypasses the noise gate", async () => {
  const result = await runTranscriptionQualityCase({
    ...options,
    force: true,
    mode: "pipeline",
    pcm: silence,
    reference: "",
    transcribe: async () => ({ text: "Yes" }),
  });
  expect(result.requests).toBe(1);
});

test("a budget refusal is unscored and is not counted as an HTTP request", async () => {
  const result = await runTranscriptionQualityCase({
    ...options,
    mode: "provider",
    pcm: tone,
    reference: "",
    transcribe: async () => {
      throw new TranscriptionBudgetExhausted("stop");
    },
  });
  expect(result).toMatchObject({
    status: "failed",
    reason: "budget_exhausted",
    requests: 0,
    submittedAudioSeconds: 0,
    score: { scored: false },
  });
});

test("a failed retry retains the successful candidate but does not grade partial output", async () => {
  let calls = 0;
  const result = await runTranscriptionQualityCase({
    ...options,
    mode: "pipeline",
    pcm: tone,
    reference: "",
    transcribe: async () => {
      if (++calls === 2) throw new Error("retry failed");
      return { text: "VRChat", logprobs: [{ logprob: -3 }] };
    },
  });
  expect(result).toMatchObject({
    status: "failed",
    requests: 2,
    score: { scored: false },
  });
  expect(result.candidates).toHaveLength(1);
});
