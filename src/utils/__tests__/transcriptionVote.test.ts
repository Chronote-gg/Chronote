import { decideTranscriptionVote } from "../transcriptionVote";

const buildCandidate = (
  overrides: Partial<
    Parameters<typeof decideTranscriptionVote>[0]["promptCandidate"]
  >,
) => ({
  id: "prompt" as const,
  text: "baseline transcript",
  suppressed: false,
  promptEchoDetected: false,
  rateMismatchDetected: false,
  quietAudio: false,
  logprobMetrics: {
    avgLogprob: -0.3,
    minLogprob: -0.4,
    tokenCount: 4,
  },
  ...overrides,
});

describe("decideTranscriptionVote", () => {
  it("keeps the prompt candidate when the no-prompt result is punctuation only", () => {
    const decision = decideTranscriptionVote({
      promptCandidate: buildCandidate({
        id: "prompt",
        text: "I think we should review the notes tonight",
        logprobMetrics: {
          avgLogprob: -1.8,
          minLogprob: -2.1,
          tokenCount: 8,
        },
      }),
      noPromptCandidate: buildCandidate({
        id: "no_prompt",
        text: ".",
        logprobMetrics: {
          avgLogprob: -0.05,
          minLogprob: -0.05,
          tokenCount: 1,
        },
      }),
    });

    expect(decision.selectedId).toBe("prompt");
    expect(decision.reasons).toContain("trivial_text_difference");
    expect(decision.reasons).toContain("no_prompt_trivial_text");
    expect(decision.noPromptQuality.trivialText).toBe(true);
  });

  it("allows the no-prompt candidate to win when the prompt result is trivial", () => {
    const decision = decideTranscriptionVote({
      promptCandidate: buildCandidate({
        id: "prompt",
        text: "...",
      }),
      noPromptCandidate: buildCandidate({
        id: "no_prompt",
        text: "We should ship the moderation update tomorrow.",
        logprobMetrics: {
          avgLogprob: -0.2,
          minLogprob: -0.3,
          tokenCount: 9,
        },
      }),
    });

    expect(decision.selectedId).toBe("no_prompt");
    expect(decision.promptQuality.trivialText).toBe(true);
    expect(decision.noPromptQuality.trivialText).toBe(false);
  });
});
