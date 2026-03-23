import {
  TRANSCRIPTION_LOGPROB_AVG_THRESHOLD,
  TRANSCRIPTION_LOGPROB_MIN_THRESHOLD,
} from "../constants";
import type { LogprobMetrics } from "./transcriptionGuards";
import { getTranscriptionTextQuality } from "./transcriptionText";

export type TranscriptionVoteCandidateId = "prompt" | "no_prompt";

export type TranscriptionVoteCandidate = {
  id: TranscriptionVoteCandidateId;
  text: string;
  suppressed: boolean;
  promptEchoDetected: boolean;
  rateMismatchDetected: boolean;
  quietAudio: boolean;
  logprobMetrics?: LogprobMetrics;
};

type CandidateQuality = {
  score: number;
  wordCount: number;
  alnumCharCount: number;
  uniqueWordRatio: number;
  maxConsecutiveRepeats: number;
  trivialText: boolean;
  trivialTextReasons: string[];
};

export type TranscriptionVoteGateResult = {
  shouldRun: boolean;
  reasons: string[];
};

export type TranscriptionVoteDecision = {
  selectedId: TranscriptionVoteCandidateId;
  reasons: string[];
  promptScore: number;
  noPromptScore: number;
  promptQuality: CandidateQuality;
  noPromptQuality: CandidateQuality;
};

const SCORE_EMPTY_TEXT = -1000;
const SCORE_TEXT_PRESENT = 100;
const SCORE_NOT_SUPPRESSED = 40;
const SCORE_SUPPRESSED = -40;
const SCORE_NO_PROMPT_ECHO = 20;
const SCORE_PROMPT_ECHO = -50;
const SCORE_NO_RATE_MISMATCH = 8;
const SCORE_RATE_MISMATCH = -15;
const SCORE_NOT_QUIET_AUDIO = 6;
const SCORE_QUIET_AUDIO = -6;
const SCORE_WORD_COUNT_CAP = 30;
const SCORE_WORD_COUNT_FACTOR = 0.5;
const SCORE_AVG_LOGPROB_FACTOR = 20;
const SCORE_MIN_LOGPROB_FACTOR = 5;
const SCORE_LOW_CONFIDENCE_PENALTY = -25;
const SCORE_UNIQUE_RATIO_THRESHOLD = 0.45;
const SCORE_UNIQUE_RATIO_PENALTY = -20;
const SCORE_CONSECUTIVE_REPEAT_MIN = 3;
const SCORE_CONSECUTIVE_REPEAT_PENALTY = -20;
const SCORE_TRIVIAL_TEXT_PENALTY = -400;
const SCORE_SELECTION_BUFFER = 2;
const NO_PROMPT_MIN_SELECTION_SCORE = 120;

function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9'\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function calculateMaxConsecutiveRepeats(words: string[]): number {
  if (words.length === 0) return 0;

  let maxRun = 1;
  let currentRun = 1;
  for (let index = 1; index < words.length; index += 1) {
    if (words[index] === words[index - 1]) {
      currentRun += 1;
      maxRun = Math.max(maxRun, currentRun);
      continue;
    }
    currentRun = 1;
  }

  return maxRun;
}

export function hasLowConfidenceLogprobs(metrics?: LogprobMetrics): boolean {
  if (!metrics) return false;
  return (
    metrics.avgLogprob <= TRANSCRIPTION_LOGPROB_AVG_THRESHOLD ||
    metrics.minLogprob <= TRANSCRIPTION_LOGPROB_MIN_THRESHOLD
  );
}

function calculateCandidateQuality(
  candidate: TranscriptionVoteCandidate,
): CandidateQuality {
  const textQuality = getTranscriptionTextQuality(candidate.text);
  const trimmed = textQuality.trimmed;
  const wordCount = textQuality.wordCount;
  const normalizedWords = normalizeWords(trimmed);
  const uniqueWordRatio =
    normalizedWords.length === 0
      ? 1
      : new Set(normalizedWords).size / normalizedWords.length;
  const maxConsecutiveRepeats = calculateMaxConsecutiveRepeats(normalizedWords);

  if (!trimmed) {
    return {
      score: SCORE_EMPTY_TEXT,
      wordCount,
      alnumCharCount: textQuality.alnumCharCount,
      uniqueWordRatio,
      maxConsecutiveRepeats,
      trivialText: textQuality.trivial,
      trivialTextReasons: textQuality.reasons,
    };
  }

  let score = SCORE_TEXT_PRESENT;
  score += candidate.suppressed ? SCORE_SUPPRESSED : SCORE_NOT_SUPPRESSED;
  score += candidate.promptEchoDetected
    ? SCORE_PROMPT_ECHO
    : SCORE_NO_PROMPT_ECHO;
  score += candidate.rateMismatchDetected
    ? SCORE_RATE_MISMATCH
    : SCORE_NO_RATE_MISMATCH;
  score += candidate.quietAudio ? SCORE_QUIET_AUDIO : SCORE_NOT_QUIET_AUDIO;

  const cappedWordCount = Math.min(wordCount, SCORE_WORD_COUNT_CAP);
  score += cappedWordCount * SCORE_WORD_COUNT_FACTOR;

  if (candidate.logprobMetrics) {
    score += candidate.logprobMetrics.avgLogprob * SCORE_AVG_LOGPROB_FACTOR;
    score += candidate.logprobMetrics.minLogprob * SCORE_MIN_LOGPROB_FACTOR;
  }

  if (hasLowConfidenceLogprobs(candidate.logprobMetrics)) {
    score += SCORE_LOW_CONFIDENCE_PENALTY;
  }
  if (
    normalizedWords.length >= SCORE_WORD_COUNT_CAP &&
    uniqueWordRatio < SCORE_UNIQUE_RATIO_THRESHOLD
  ) {
    score += SCORE_UNIQUE_RATIO_PENALTY;
  }
  if (maxConsecutiveRepeats >= SCORE_CONSECUTIVE_REPEAT_MIN) {
    score += SCORE_CONSECUTIVE_REPEAT_PENALTY;
  }
  if (textQuality.trivial) {
    // This penalty is only for score telemetry, selection short-circuits on
    // trivialText before comparing prompt and no-prompt scores.
    score += SCORE_TRIVIAL_TEXT_PENALTY;
  }

  return {
    score,
    wordCount,
    alnumCharCount: textQuality.alnumCharCount,
    uniqueWordRatio,
    maxConsecutiveRepeats,
    trivialText: textQuality.trivial,
    trivialTextReasons: textQuality.reasons,
  };
}

export function shouldRunTranscriptionVote(input: {
  enabled: boolean;
  hasPrompt: boolean;
  passMode: "fast" | "slow";
  primaryCandidate: TranscriptionVoteCandidate;
}): TranscriptionVoteGateResult {
  const reasons: string[] = [];

  if (!input.enabled) {
    return { shouldRun: false, reasons };
  }

  if (!input.hasPrompt) {
    return { shouldRun: false, reasons };
  }

  if (input.passMode === "fast") {
    return { shouldRun: false, reasons };
  }

  if (input.primaryCandidate.promptEchoDetected) {
    reasons.push("prompt_echo_detected");
  }
  if (hasLowConfidenceLogprobs(input.primaryCandidate.logprobMetrics)) {
    reasons.push("low_confidence_logprobs");
  }

  return {
    shouldRun: reasons.length > 0,
    reasons,
  };
}

function chooseSelectedCandidateId(input: {
  promptQuality: CandidateQuality;
  noPromptQuality: CandidateQuality;
}): TranscriptionVoteCandidateId {
  if (input.noPromptQuality.trivialText) {
    return "prompt";
  }
  if (input.promptQuality.trivialText) {
    return "no_prompt";
  }
  if (input.noPromptQuality.score < NO_PROMPT_MIN_SELECTION_SCORE) {
    return "prompt";
  }
  if (
    input.noPromptQuality.score >
    input.promptQuality.score + SCORE_SELECTION_BUFFER
  ) {
    return "no_prompt";
  }
  return "prompt";
}

export function decideTranscriptionVote(input: {
  promptCandidate: TranscriptionVoteCandidate;
  noPromptCandidate: TranscriptionVoteCandidate;
}): TranscriptionVoteDecision {
  const promptQuality = calculateCandidateQuality(input.promptCandidate);
  const noPromptQuality = calculateCandidateQuality(input.noPromptCandidate);
  const selectedId = chooseSelectedCandidateId({
    promptQuality,
    noPromptQuality,
  });

  const reasons = [`selected_${selectedId}`];
  if (promptQuality.trivialText !== noPromptQuality.trivialText) {
    reasons.push("trivial_text_difference");
  }
  if (selectedId === "prompt" && noPromptQuality.trivialText) {
    reasons.push("no_prompt_trivial_text");
  }
  if (selectedId === "no_prompt" && promptQuality.trivialText) {
    reasons.push("prompt_trivial_text");
  }
  if (promptQuality.trivialText && noPromptQuality.trivialText) {
    reasons.push("both_trivial_text");
  }
  if (
    selectedId === "prompt" &&
    !noPromptQuality.trivialText &&
    noPromptQuality.score < NO_PROMPT_MIN_SELECTION_SCORE
  ) {
    reasons.push("no_prompt_below_quality_floor");
  }
  if (input.promptCandidate.suppressed !== input.noPromptCandidate.suppressed) {
    reasons.push("suppression_difference");
  }
  if (
    input.promptCandidate.promptEchoDetected !==
    input.noPromptCandidate.promptEchoDetected
  ) {
    reasons.push("prompt_echo_difference");
  }
  if (
    hasLowConfidenceLogprobs(input.promptCandidate.logprobMetrics) !==
    hasLowConfidenceLogprobs(input.noPromptCandidate.logprobMetrics)
  ) {
    reasons.push("logprob_difference");
  }
  if (
    promptQuality.maxConsecutiveRepeats !==
    noPromptQuality.maxConsecutiveRepeats
  ) {
    reasons.push("repetition_difference");
  }

  return {
    selectedId,
    reasons,
    promptScore: promptQuality.score,
    noPromptScore: noPromptQuality.score,
    promptQuality,
    noPromptQuality,
  };
}
