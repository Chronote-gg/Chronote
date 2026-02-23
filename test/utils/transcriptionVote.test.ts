import { describe, expect, test } from "@jest/globals";
import {
  decideTranscriptionVote,
  hasLowConfidenceLogprobs,
  shouldRunTranscriptionVote,
  type TranscriptionVoteCandidate,
} from "../../src/utils/transcriptionVote";

const buildCandidate = (
  overrides: Partial<TranscriptionVoteCandidate> = {},
): TranscriptionVoteCandidate => ({
  id: "prompt",
  text: "hello team",
  suppressed: false,
  promptEchoDetected: false,
  rateMismatchDetected: false,
  quietAudio: false,
  logprobMetrics: {
    avgLogprob: -0.4,
    minLogprob: -1,
    tokenCount: 4,
  },
  ...overrides,
});

describe("transcriptionVote", () => {
  test("hasLowConfidenceLogprobs returns true when either threshold fails", () => {
    expect(
      hasLowConfidenceLogprobs({
        avgLogprob: -1.3,
        minLogprob: -1,
        tokenCount: 4,
      }),
    ).toBe(true);
    expect(
      hasLowConfidenceLogprobs({
        avgLogprob: -0.4,
        minLogprob: -2.6,
        tokenCount: 4,
      }),
    ).toBe(true);
    expect(
      hasLowConfidenceLogprobs({
        avgLogprob: -0.4,
        minLogprob: -1,
        tokenCount: 4,
      }),
    ).toBe(false);
  });

  test("shouldRunTranscriptionVote gates on slow pass with prompt", () => {
    const primaryCandidate = buildCandidate({ promptEchoDetected: true });
    expect(
      shouldRunTranscriptionVote({
        enabled: true,
        hasPrompt: true,
        passMode: "slow",
        primaryCandidate,
      }),
    ).toEqual({
      shouldRun: true,
      reasons: ["prompt_echo_detected"],
    });

    expect(
      shouldRunTranscriptionVote({
        enabled: true,
        hasPrompt: true,
        passMode: "fast",
        primaryCandidate,
      }),
    ).toEqual({
      shouldRun: false,
      reasons: [],
    });

    expect(
      shouldRunTranscriptionVote({
        enabled: true,
        hasPrompt: false,
        passMode: "slow",
        primaryCandidate,
      }),
    ).toEqual({
      shouldRun: false,
      reasons: [],
    });
  });

  test("shouldRunTranscriptionVote runs on low confidence logprobs", () => {
    const primaryCandidate = buildCandidate({
      logprobMetrics: {
        avgLogprob: -1.4,
        minLogprob: -2.6,
        tokenCount: 8,
      },
    });

    expect(
      shouldRunTranscriptionVote({
        enabled: true,
        hasPrompt: true,
        passMode: "slow",
        primaryCandidate,
      }),
    ).toEqual({
      shouldRun: true,
      reasons: ["low_confidence_logprobs"],
    });
  });

  test("decideTranscriptionVote selects no-prompt when prompt is suppressed", () => {
    const decision = decideTranscriptionVote({
      promptCandidate: buildCandidate({
        id: "prompt",
        text: "",
        suppressed: true,
      }),
      noPromptCandidate: buildCandidate({
        id: "no_prompt",
        text: "We shipped the fix today.",
      }),
    });

    expect(decision.selectedId).toBe("no_prompt");
    expect(decision.reasons).toContain("selected_no_prompt");
    expect(decision.reasons).toContain("suppression_difference");
    expect(decision.noPromptScore).toBeGreaterThan(decision.promptScore);
  });

  test("decideTranscriptionVote keeps prompt when scores are close", () => {
    const decision = decideTranscriptionVote({
      promptCandidate: buildCandidate({
        id: "prompt",
        text: "Discussed release timeline.",
      }),
      noPromptCandidate: buildCandidate({
        id: "no_prompt",
        text: "Discussed release timeline",
      }),
    });

    expect(decision.selectedId).toBe("prompt");
    expect(
      Math.abs(decision.promptScore - decision.noPromptScore),
    ).toBeLessThan(3);
  });

  test("decideTranscriptionVote penalizes repetitive text", () => {
    const decision = decideTranscriptionVote({
      promptCandidate: buildCandidate({
        id: "prompt",
        text: "hello ".repeat(40).trim(),
      }),
      noPromptCandidate: buildCandidate({
        id: "no_prompt",
        text: "Hello everyone, we agreed to close action item three.",
      }),
    });

    expect(decision.selectedId).toBe("no_prompt");
    expect(decision.reasons).toContain("repetition_difference");
  });
});
