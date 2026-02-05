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
  quietByPeak: boolean;
  quietByActivity: boolean;
  hardSilenceDetected: boolean;
  rateMismatchDetected: boolean;
  syllableCount?: number;
  syllablesPerSecond?: number;
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

type LoudnessEvaluation = {
  quietAudio: boolean;
  quietByPeak: boolean;
  quietByActivity: boolean;
  logprobMetrics?: LogprobMetrics;
  lowConfidence: boolean;
  flags: string[];
};

type RateEvaluation = {
  syllableCount?: number;
  syllablesPerSecond?: number;
  rateMismatchDetected: boolean;
  flags: string[];
};

type RateInputs = {
  audioSeconds: number;
  wordCount: number;
  syllableCount: number;
  rateMaxSeconds: number;
  minWords: number;
  minSyllables: number;
  maxSyllablesPerSecond: number;
  syllablesPerSecond: number;
};

type PromptEchoInputs = {
  normalizedPrompt: string;
  normalizedTranscript: string;
  transcriptWordCount: number;
  eligible: boolean;
};

type PromptEchoComparison = {
  substringMatch: boolean;
  similarityMatch: boolean;
  similarityRatio?: number;
  comparedLength?: number;
  distanceValue?: number;
};

type PromptEchoEvaluation = {
  detected: boolean;
  flags: string[];
  metrics?: PromptEchoMetrics;
};

const normalizeValue = (value: string) => value.trim();

const toFiniteNumber = (value?: number) =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const toPositiveNumber = (value?: number) =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;

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

const isLowConfidence = (
  metrics?: LogprobMetrics,
  mode: "and" | "or" = "and",
) => {
  if (!metrics) return false;
  if (mode === "or") {
    return (
      metrics.avgLogprob <= TRANSCRIPTION_LOGPROB_AVG_THRESHOLD ||
      metrics.minLogprob <= TRANSCRIPTION_LOGPROB_MIN_THRESHOLD
    );
  }
  return (
    metrics.avgLogprob <= TRANSCRIPTION_LOGPROB_AVG_THRESHOLD &&
    metrics.minLogprob <= TRANSCRIPTION_LOGPROB_MIN_THRESHOLD
  );
};

const isQuietByPeak = (metrics?: NoiseGateMetrics): boolean => {
  if (!metrics) return false;
  return metrics.peakDbfs <= metrics.thresholdDbfs;
};

const isQuietByActivity = (metrics?: NoiseGateMetrics): boolean => {
  if (!metrics) return false;
  return metrics.activeWindowCount < metrics.minActiveWindows;
};

const isQuietAudio = (
  enabled: boolean,
  metrics?: NoiseGateMetrics,
): boolean => {
  if (!enabled || !metrics) return false;
  return isQuietByPeak(metrics) || isQuietByActivity(metrics);
};

const evaluateLoudnessGuard = (options: {
  enabled: boolean;
  metrics?: NoiseGateMetrics;
  logprobs?: LogprobEntry[];
}): LoudnessEvaluation => {
  const logprobMetrics = buildLogprobMetrics(options.logprobs);
  const quietByPeak = isQuietByPeak(options.metrics);
  const quietByActivity = isQuietByActivity(options.metrics);
  const quietAudio = isQuietAudio(options.enabled, options.metrics);
  const lowConfidence = isLowConfidence(
    logprobMetrics,
    quietAudio ? "or" : "and",
  );
  const flags: string[] = [];

  if (quietAudio) {
    flags.push("quiet_audio");
    if (!logprobMetrics) {
      flags.push("logprobs_missing");
    }
  }

  if (quietAudio && lowConfidence) {
    flags.push("low_confidence");
  }

  return {
    quietAudio,
    quietByPeak,
    quietByActivity,
    logprobMetrics,
    lowConfidence,
    flags,
  };
};

const resolveRateInputs = (options: {
  audioSeconds?: number;
  wordCount?: number;
  syllableCount?: number;
  rateMaxSeconds?: number;
  minWords?: number;
  minSyllables?: number;
  maxSyllablesPerSecond?: number;
}): RateInputs | null => {
  const audioSeconds = toPositiveNumber(options.audioSeconds);
  const wordCount = toFiniteNumber(options.wordCount);
  const syllableCount = toFiniteNumber(options.syllableCount);
  const rateMaxSeconds = toPositiveNumber(options.rateMaxSeconds);
  const minWords = toPositiveNumber(options.minWords);
  const minSyllables = toPositiveNumber(options.minSyllables);
  const maxSyllablesPerSecond = toPositiveNumber(options.maxSyllablesPerSecond);
  const syllablesPerSecond =
    audioSeconds !== undefined && syllableCount !== undefined
      ? syllableCount / audioSeconds
      : undefined;

  if (
    audioSeconds === undefined ||
    wordCount === undefined ||
    syllableCount === undefined ||
    rateMaxSeconds === undefined ||
    minWords === undefined ||
    minSyllables === undefined ||
    maxSyllablesPerSecond === undefined ||
    syllablesPerSecond === undefined
  ) {
    return null;
  }

  return {
    audioSeconds,
    wordCount,
    syllableCount,
    rateMaxSeconds,
    minWords,
    minSyllables,
    maxSyllablesPerSecond,
    syllablesPerSecond,
  };
};

const meetsRateThresholds = (inputs: RateInputs) =>
  [
    inputs.audioSeconds <= inputs.rateMaxSeconds,
    inputs.wordCount >= inputs.minWords,
    inputs.syllableCount >= inputs.minSyllables,
    inputs.syllablesPerSecond >= inputs.maxSyllablesPerSecond,
  ].every(Boolean);

const evaluateRateGuard = (options: {
  enabled: boolean;
  audioSeconds?: number;
  wordCount?: number;
  syllableCount?: number;
  rateMaxSeconds?: number;
  minWords?: number;
  minSyllables?: number;
  maxSyllablesPerSecond?: number;
}): RateEvaluation => {
  const flags: string[] = [];

  if (!options.enabled) {
    return {
      syllableCount: options.syllableCount,
      syllablesPerSecond: undefined,
      rateMismatchDetected: false,
      flags,
    };
  }

  const inputs = resolveRateInputs({
    audioSeconds: options.audioSeconds,
    wordCount: options.wordCount,
    syllableCount: options.syllableCount,
    rateMaxSeconds: options.rateMaxSeconds,
    minWords: options.minWords,
    minSyllables: options.minSyllables,
    maxSyllablesPerSecond: options.maxSyllablesPerSecond,
  });

  if (!inputs) {
    return {
      syllableCount: options.syllableCount,
      syllablesPerSecond: undefined,
      rateMismatchDetected: false,
      flags,
    };
  }

  const rateMismatchDetected = meetsRateThresholds(inputs);

  if (rateMismatchDetected) {
    flags.push("rate_mismatch");
  }

  return {
    syllableCount: inputs.syllableCount,
    syllablesPerSecond: inputs.syllablesPerSecond,
    rateMismatchDetected,
    flags,
  };
};

const isHardSilence = (
  metrics?: NoiseGateMetrics,
  hardSilenceDbfs?: number,
): boolean => {
  if (!metrics || hardSilenceDbfs === undefined) return false;
  return metrics.peakDbfs <= hardSilenceDbfs;
};

const buildPromptEchoInputs = (
  enabled: boolean,
  promptText: string,
  transcript: string,
): PromptEchoInputs => {
  if (!enabled) {
    return {
      normalizedPrompt: "",
      normalizedTranscript: "",
      transcriptWordCount: 0,
      eligible: false,
    };
  }

  const normalizedPrompt = normalizeForEcho(promptText);
  const normalizedTranscript = normalizeForEcho(transcript);
  const transcriptWordCount = countWords(normalizedTranscript);
  const eligible =
    normalizedPrompt.length > 0 &&
    normalizedTranscript.length >= TRANSCRIPTION_PROMPT_ECHO_MIN_CHARS &&
    transcriptWordCount >= TRANSCRIPTION_PROMPT_ECHO_MIN_WORDS;

  return {
    normalizedPrompt,
    normalizedTranscript,
    transcriptWordCount,
    eligible,
  };
};

const selectPromptEchoComparison = (
  inputs: PromptEchoInputs,
): PromptEchoComparison => {
  if (!inputs.eligible) {
    return {
      substringMatch: false,
      similarityMatch: false,
    };
  }

  const substringMatch = inputs.normalizedPrompt.includes(
    inputs.normalizedTranscript,
  );
  const comparedPrompt =
    inputs.normalizedPrompt.length >= inputs.normalizedTranscript.length
      ? inputs.normalizedPrompt.slice(0, inputs.normalizedTranscript.length)
      : inputs.normalizedPrompt;
  const comparedLength = comparedPrompt.length;
  if (comparedPrompt.length === 0) {
    return {
      substringMatch,
      similarityMatch: false,
      comparedLength,
    };
  }

  const distanceValue = distance(inputs.normalizedTranscript, comparedPrompt);
  const similarityRatio =
    distanceValue /
    Math.max(inputs.normalizedTranscript.length, comparedPrompt.length);
  const similarityMatch =
    similarityRatio <= TRANSCRIPTION_PROMPT_ECHO_SIMILARITY_THRESHOLD;

  return {
    substringMatch,
    similarityMatch,
    similarityRatio,
    comparedLength,
    distanceValue,
  };
};

const buildPromptEchoFlags = (comparison: PromptEchoComparison) => {
  const flags: string[] = [];
  if (comparison.substringMatch) {
    flags.push("prompt_echo_substring");
  }
  if (comparison.similarityMatch) {
    flags.push("prompt_echo_similarity");
  }
  return flags;
};

const evaluatePromptEchoGuard = (options: {
  enabled: boolean;
  promptText: string;
  transcript: string;
}): PromptEchoEvaluation => {
  if (!options.enabled) {
    return {
      detected: false,
      flags: [],
    };
  }

  const inputs = buildPromptEchoInputs(
    options.enabled,
    options.promptText,
    options.transcript,
  );
  const comparison = selectPromptEchoComparison(inputs);
  const detected = comparison.substringMatch || comparison.similarityMatch;

  return {
    detected,
    flags: detected ? buildPromptEchoFlags(comparison) : [],
    metrics: {
      enabled: options.enabled,
      eligible: inputs.eligible,
      normalizedPromptLength: inputs.normalizedPrompt.length,
      normalizedTranscriptLength: inputs.normalizedTranscript.length,
      transcriptWordCount: inputs.transcriptWordCount,
      minChars: TRANSCRIPTION_PROMPT_ECHO_MIN_CHARS,
      minWords: TRANSCRIPTION_PROMPT_ECHO_MIN_WORDS,
      substringMatch: comparison.substringMatch,
      similarityMatch: comparison.similarityMatch,
      similarityRatio: comparison.similarityRatio,
      similarityThreshold: TRANSCRIPTION_PROMPT_ECHO_SIMILARITY_THRESHOLD,
      comparedLength: comparison.comparedLength,
      distance: comparison.distanceValue,
    },
  };
};

type SuppressionDecisions = {
  suppressedByLoudness: boolean;
  suppressedByHardSilence: boolean;
  suppressedByRateMismatch: boolean;
  suppressedByPromptEcho: boolean;
  suppressed: boolean;
};

const resolveSuppressionDecisions = (input: {
  suppressionEnabled: boolean;
  promptEchoEnabled: boolean;
  hasText: boolean;
  loudness: LoudnessEvaluation;
  hardSilenceDetected: boolean;
  rateMismatchDetected: boolean;
  promptEchoDetected: boolean;
}): SuppressionDecisions => {
  const suppressionAllowed = input.suppressionEnabled && input.hasText;
  const suppressedByLoudness =
    suppressionAllowed &&
    input.loudness.quietAudio &&
    input.loudness.lowConfidence;
  const suppressedByHardSilence =
    suppressionAllowed && input.hardSilenceDetected;
  const suppressedByRateMismatch =
    suppressionAllowed && input.rateMismatchDetected;
  const suppressedByPromptEcho =
    input.promptEchoEnabled && input.hasText && input.promptEchoDetected;
  return {
    suppressedByLoudness,
    suppressedByHardSilence,
    suppressedByRateMismatch,
    suppressedByPromptEcho,
    suppressed:
      suppressedByLoudness ||
      suppressedByHardSilence ||
      suppressedByRateMismatch ||
      suppressedByPromptEcho,
  };
};

const buildLoudnessFlags = (input: {
  baseFlags: string[];
  suppressedByLoudness: boolean;
  hardSilenceDetected: boolean;
  suppressedByHardSilence: boolean;
}): string[] => {
  const flags = [...input.baseFlags];
  if (input.suppressedByLoudness) {
    flags.push("suppressed_low_confidence");
  }
  if (input.hardSilenceDetected) {
    flags.push("hard_silence");
  }
  if (input.suppressedByHardSilence) {
    flags.push("suppressed_hard_silence");
  }
  return flags;
};

const buildRateFlags = (input: {
  baseFlags: string[];
  suppressedByRateMismatch: boolean;
}): string[] => {
  const flags = [...input.baseFlags];
  if (input.suppressedByRateMismatch) {
    flags.push("suppressed_rate_mismatch");
  }
  return flags;
};

const buildPromptEchoFlagsForResult = (input: {
  baseFlags: string[];
  suppressedByPromptEcho: boolean;
}): string[] => {
  if (!input.suppressedByPromptEcho) {
    return [...input.baseFlags];
  }
  return [...input.baseFlags, "suppressed_prompt_echo"];
};

const mergeGuardFlags = (input: {
  suppressionEnabled: boolean;
  promptEchoEnabled: boolean;
  loudnessFlags: string[];
  rateFlags: string[];
  promptEchoFlags: string[];
}): string[] => {
  return [
    ...(input.suppressionEnabled ? input.loudnessFlags : []),
    ...(input.suppressionEnabled ? input.rateFlags : []),
    ...(input.promptEchoEnabled ? input.promptEchoFlags : []),
  ];
};

export function applyTranscriptionGuards(input: {
  transcription: string;
  suppressionEnabled: boolean;
  hardSilenceDbfs?: number;
  rateMaxSeconds?: number;
  rateMinWords?: number;
  rateMinSyllables?: number;
  maxSyllablesPerSecond?: number;
  promptEchoEnabled: boolean;
  promptText?: string;
  noiseGateMetrics?: NoiseGateMetrics;
  audioSeconds?: number;
  transcriptWordCount?: number;
  transcriptSyllableCount?: number;
  logprobs?: LogprobEntry[];
}): TranscriptionGuardResult {
  const trimmed = normalizeValue(input.transcription);
  const hasText = Boolean(trimmed);
  const loudness = evaluateLoudnessGuard({
    enabled: input.suppressionEnabled,
    metrics: input.noiseGateMetrics,
    logprobs: input.logprobs,
  });
  const rate = evaluateRateGuard({
    enabled: input.suppressionEnabled,
    audioSeconds: input.audioSeconds,
    wordCount: input.transcriptWordCount,
    syllableCount: input.transcriptSyllableCount,
    rateMaxSeconds: input.rateMaxSeconds,
    minWords: input.rateMinWords,
    minSyllables: input.rateMinSyllables,
    maxSyllablesPerSecond: input.maxSyllablesPerSecond,
  });
  const hardSilenceDetected = isHardSilence(
    input.noiseGateMetrics,
    input.hardSilenceDbfs,
  );
  const promptEcho = evaluatePromptEchoGuard({
    enabled: input.promptEchoEnabled,
    promptText: input.promptText ?? "",
    transcript: trimmed,
  });

  const suppression = resolveSuppressionDecisions({
    suppressionEnabled: input.suppressionEnabled,
    promptEchoEnabled: input.promptEchoEnabled,
    hasText,
    loudness,
    hardSilenceDetected,
    rateMismatchDetected: rate.rateMismatchDetected,
    promptEchoDetected: promptEcho.detected,
  });

  const loudnessFlags = buildLoudnessFlags({
    baseFlags: loudness.flags,
    suppressedByLoudness: suppression.suppressedByLoudness,
    hardSilenceDetected,
    suppressedByHardSilence: suppression.suppressedByHardSilence,
  });
  const promptEchoFlags = buildPromptEchoFlagsForResult({
    baseFlags: promptEcho.flags,
    suppressedByPromptEcho: suppression.suppressedByPromptEcho,
  });
  const rateFlags = buildRateFlags({
    baseFlags: rate.flags,
    suppressedByRateMismatch: suppression.suppressedByRateMismatch,
  });

  return {
    text: suppression.suppressed ? "" : trimmed,
    flags: mergeGuardFlags({
      suppressionEnabled: input.suppressionEnabled,
      promptEchoEnabled: input.promptEchoEnabled,
      loudnessFlags,
      rateFlags,
      promptEchoFlags,
    }),
    logprobMetrics: loudness.logprobMetrics,
    promptEchoDetected: promptEcho.detected,
    promptEchoMetrics: promptEcho.metrics,
    quietAudio: loudness.quietAudio,
    quietByPeak: loudness.quietByPeak,
    quietByActivity: loudness.quietByActivity,
    hardSilenceDetected,
    rateMismatchDetected: rate.rateMismatchDetected,
    syllableCount: rate.syllableCount,
    syllablesPerSecond: rate.syllablesPerSecond,
    suppressed: suppression.suppressed,
  };
}
