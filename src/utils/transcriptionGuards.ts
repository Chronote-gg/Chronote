import type { NoiseGateMetrics } from "./audioNoiseGate";
import { distance } from "fastest-levenshtein";
import {
  TRANSCRIPTION_LOGPROB_AVG_THRESHOLD,
  TRANSCRIPTION_LOGPROB_MIN_THRESHOLD,
  TRANSCRIPTION_PROMPT_ECHO_MIN_CHARS,
  TRANSCRIPTION_PROMPT_ECHO_MIN_WORDS,
  TRANSCRIPTION_PROMPT_ECHO_SIMILARITY_THRESHOLD,
} from "../constants";

type LogprobEntry = {
  logprob?: number;
};

export type LogprobMetrics = {
  avgLogprob: number;
  minLogprob: number;
  tokenCount: number;
};

export type TranscriptionGuardResult = {
  text: string;
  flags: string[];
  logprobMetrics?: LogprobMetrics;
  promptEchoDetected: boolean;
  promptEchoMetrics?: PromptEchoMetrics;
  quietAudio: boolean;
  suppressed: boolean;
};

export type PromptEchoMetrics = {
  enabled: boolean;
  eligible: boolean;
  normalizedPromptLength: number;
  normalizedTranscriptLength: number;
  transcriptWordCount: number;
  minChars: number;
  minWords: number;
  substringMatch: boolean;
  similarityMatch: boolean;
  similarityRatio?: number;
  similarityThreshold: number;
  comparedLength?: number;
  distance?: number;
};

const normalizeValue = (value: string) => value.trim();

const normalizeForEcho = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const countWords = (value: string) =>
  value ? value.split(" ").filter(Boolean).length : 0;

const buildLogprobMetrics = (
  logprobs?: LogprobEntry[],
): LogprobMetrics | undefined => {
  if (!logprobs || logprobs.length === 0) return undefined;
  const values = logprobs
    .map((entry) => entry.logprob)
    .filter((value): value is number => Number.isFinite(value));
  if (values.length === 0) return undefined;
  const sum = values.reduce((acc, value) => acc + value, 0);
  return {
    avgLogprob: sum / values.length,
    minLogprob: Math.min(...values),
    tokenCount: values.length,
  };
};

const isQuietAudio = (
  enabled: boolean,
  metrics?: NoiseGateMetrics,
): boolean => {
  if (!enabled || !metrics) return false;
  return (
    metrics.peakDbfs <= metrics.thresholdDbfs ||
    metrics.activeWindowCount < metrics.minActiveWindows
  );
};

export function applyTranscriptionGuards(input: {
  transcription: string;
  suppressionEnabled: boolean;
  promptEchoEnabled: boolean;
  promptText?: string;
  noiseGateEnabled: boolean;
  noiseGateMetrics?: NoiseGateMetrics;
  logprobs?: LogprobEntry[];
}): TranscriptionGuardResult {
  const trimmed = normalizeValue(input.transcription);
  const loudnessFlags: string[] = [];
  const promptEchoFlags: string[] = [];
  const quietAudio = isQuietAudio(
    input.noiseGateEnabled,
    input.noiseGateMetrics,
  );
  const logprobMetrics = buildLogprobMetrics(input.logprobs);

  if (quietAudio) {
    loudnessFlags.push("quiet_audio");
    if (!logprobMetrics) {
      loudnessFlags.push("logprobs_missing");
    }
  }

  const lowConfidence =
    logprobMetrics &&
    logprobMetrics.avgLogprob <= TRANSCRIPTION_LOGPROB_AVG_THRESHOLD &&
    logprobMetrics.minLogprob <= TRANSCRIPTION_LOGPROB_MIN_THRESHOLD;

  if (quietAudio && lowConfidence) {
    loudnessFlags.push("low_confidence");
  }

  const promptText = input.promptText ?? "";
  const normalizedPrompt = input.promptEchoEnabled
    ? normalizeForEcho(promptText)
    : "";
  const normalizedTranscript = input.promptEchoEnabled
    ? normalizeForEcho(trimmed)
    : "";
  const transcriptWordCount = input.promptEchoEnabled
    ? countWords(normalizedTranscript)
    : 0;
  const promptEchoEligible =
    input.promptEchoEnabled &&
    normalizedPrompt.length > 0 &&
    normalizedTranscript.length >= TRANSCRIPTION_PROMPT_ECHO_MIN_CHARS &&
    transcriptWordCount >= TRANSCRIPTION_PROMPT_ECHO_MIN_WORDS;
  const substringMatch =
    promptEchoEligible && normalizedPrompt.includes(normalizedTranscript);
  const comparedPrompt = promptEchoEligible
    ? normalizedPrompt.length >= normalizedTranscript.length
      ? normalizedPrompt.slice(0, normalizedTranscript.length)
      : normalizedPrompt
    : "";
  const comparedLength = promptEchoEligible ? comparedPrompt.length : undefined;
  const distanceValue =
    promptEchoEligible && comparedPrompt.length > 0
      ? distance(normalizedTranscript, comparedPrompt)
      : undefined;
  const similarityRatio =
    promptEchoEligible &&
    distanceValue !== undefined &&
    comparedPrompt.length > 0
      ? distanceValue /
        Math.max(normalizedTranscript.length, comparedPrompt.length)
      : undefined;
  const similarityMatch =
    promptEchoEligible &&
    similarityRatio !== undefined &&
    similarityRatio <= TRANSCRIPTION_PROMPT_ECHO_SIMILARITY_THRESHOLD;
  const promptEchoDetected = substringMatch || similarityMatch;

  if (promptEchoDetected) {
    if (substringMatch) {
      promptEchoFlags.push("prompt_echo_substring");
    }
    if (similarityMatch) {
      promptEchoFlags.push("prompt_echo_similarity");
    }
  }

  const suppressedByLoudness =
    input.suppressionEnabled &&
    quietAudio &&
    Boolean(trimmed) &&
    !!lowConfidence;
  const suppressedByPromptEcho =
    input.promptEchoEnabled && promptEchoDetected && Boolean(trimmed);
  const suppressed = suppressedByLoudness || suppressedByPromptEcho;

  if (suppressedByLoudness) {
    loudnessFlags.push("suppressed_low_confidence");
  }
  if (suppressedByPromptEcho) {
    promptEchoFlags.push("suppressed_prompt_echo");
  }

  return {
    text: suppressed ? "" : trimmed,
    flags: [
      ...(input.suppressionEnabled ? loudnessFlags : []),
      ...(input.promptEchoEnabled ? promptEchoFlags : []),
    ],
    logprobMetrics,
    promptEchoDetected,
    promptEchoMetrics: input.promptEchoEnabled
      ? {
          enabled: input.promptEchoEnabled,
          eligible: promptEchoEligible,
          normalizedPromptLength: normalizedPrompt.length,
          normalizedTranscriptLength: normalizedTranscript.length,
          transcriptWordCount,
          minChars: TRANSCRIPTION_PROMPT_ECHO_MIN_CHARS,
          minWords: TRANSCRIPTION_PROMPT_ECHO_MIN_WORDS,
          substringMatch,
          similarityMatch,
          similarityRatio,
          similarityThreshold: TRANSCRIPTION_PROMPT_ECHO_SIMILARITY_THRESHOLD,
          comparedLength,
          distance: distanceValue,
        }
      : undefined,
    quietAudio,
    suppressed,
  };
}
