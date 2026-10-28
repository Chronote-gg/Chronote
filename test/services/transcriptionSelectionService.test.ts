import {
  selectTranscription,
  resolveTranscriptionGuardConfig,
  type RawTranscriptionCandidate,
} from "../../src/services/transcriptionSelectionService";

const strong = (text: string): RawTranscriptionCandidate => ({
  text,
  logprobs: [{ logprob: -0.05 }],
});
const weak = (text: string): RawTranscriptionCandidate => ({
  text,
  logprobs: [{ logprob: -3 }],
});
const run = (
  responses: RawTranscriptionCandidate[],
  passMode: "fast" | "slow" = "slow",
) => {
  const requests: (string | undefined)[] = [];
  const result = selectTranscription({
    transcribe: async (prompt) => {
      requests.push(prompt);
      return responses[requests.length - 1];
    },
    prompt: "The Workshop, VRChat, dictionary terms",
    passMode,
    voteEnabled: true,
    guardConfig: resolveTranscriptionGuardConfig(),
    audioSeconds: 2,
  });
  return { requests, result };
};

test("rejects both weak candidates while retaining both request usages", async () => {
  const usage = { type: "duration", seconds: 2 } as const;
  const { requests, result } = run([
    { ...weak("The Den"), usage },
    { ...weak("はい。"), usage },
  ]);
  const selected = await result;
  expect(requests).toEqual([
    "The Workshop, VRChat, dictionary terms",
    undefined,
  ]);
  expect(selected.selected.candidateId).toBe("none");
  expect(selected.selected.guardResult.text).toBe("");
  expect(selected.selected.guardResult.flags).toContain(
    "suppressed_vote_quality_floor",
  );
  expect(selected.promptCandidate.usage).toEqual(usage);
  expect(selected.noPromptCandidate?.usage).toEqual(usage);
});

test("keeps high confidence short speech and non-English speech", async () => {
  for (const text of ["Yes", "VRChat", "はい。", "Bist du?"]) {
    const { requests, result } = run([strong(text)]);
    expect((await result).selected.guardResult.text).toBe(text);
    expect(requests).toHaveLength(1);
  }
});

test("fast pass suppresses punctuation without making a retry request", async () => {
  const { requests, result } = run([weak("###")], "fast");
  expect((await result).selected.guardResult.text).toBe("");
  expect(requests).toHaveLength(1);
});

test("accepts a strong no-prompt recovery after weak prompted text", async () => {
  const { result } = run([
    weak("context:"),
    strong("We should meet tomorrow."),
  ]);
  expect((await result).selected.guardResult.text).toBe(
    "We should meet tomorrow.",
  );
});

test("provider errors remain failures", async () => {
  await expect(
    selectTranscription({
      transcribe: async () => {
        throw new Error("provider unavailable");
      },
      passMode: "slow",
      voteEnabled: true,
      guardConfig: resolveTranscriptionGuardConfig(),
    }),
  ).rejects.toThrow("provider unavailable");
});
