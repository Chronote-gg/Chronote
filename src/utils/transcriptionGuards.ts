import type { NoiseGateMetrics } from "./audioNoiseGate";
import {
  TRANSCRIPTION_LOGPROB_AVG_THRESHOLD,
  TRANSCRIPTION_LOGPROB_MIN_THRESHOLD,
} from "../constants";
import { getTranscriptionTextQuality } from "./transcriptionText";

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
  quietAudio: boolean;
  quietByPeak: boolean;
  quietByActivity: boolean;
  hardSilenceDetected: boolean;
  rateMismatchDetected: boolean;
  syllableCount?: number;
  syllablesPerSecond?: number;
  suppressed: boolean;
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

const normalizeValue = (value: string) => value.trim();

const toFiniteNumber = (value?: number) =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const toPositiveNumber = (value?: number) =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;

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

const shouldSuppressForRate = (inputs: RateInputs) =>
  [
    inputs.audioSeconds <= inputs.rateMaxSeconds,
    inputs.wordCount >= inputs.minWords,
    inputs.syllableCount >= inputs.minSyllables,
    inputs.syllablesPerSecond > inputs.maxSyllablesPerSecond,
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

  const rateMismatchDetected = shouldSuppressForRate(inputs);

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

type SuppressionDecisions = {
  suppressedByLoudness: boolean;
  suppressedByHardSilence: boolean;
  suppressedByRateMismatch: boolean;
  suppressed: boolean;
};

const resolveSuppressionDecisions = (input: {
  suppressionEnabled: boolean;
  hasText: boolean;
  loudness: LoudnessEvaluation;
  hardSilenceDetected: boolean;
  rateMismatchDetected: boolean;
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
  return {
    suppressedByLoudness,
    suppressedByHardSilence,
    suppressedByRateMismatch,
    suppressed:
      suppressedByLoudness ||
      suppressedByHardSilence ||
      suppressedByRateMismatch,
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

export function applyTranscriptionGuards(input: {
  transcription: string;
  suppressionEnabled: boolean;
  hardSilenceDbfs?: number;
  rateMaxSeconds?: number;
  rateMinWords?: number;
  rateMinSyllables?: number;
  maxSyllablesPerSecond?: number;
  noiseGateMetrics?: NoiseGateMetrics;
  audioSeconds?: number;
  transcriptWordCount?: number;
  transcriptSyllableCount?: number;
  logprobs?: LogprobEntry[];
}): TranscriptionGuardResult {
  const trimmed = normalizeValue(input.transcription);
  const punctuationOnly = getTranscriptionTextQuality(trimmed).punctuationOnly;
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
  const suppression = resolveSuppressionDecisions({
    suppressionEnabled: input.suppressionEnabled,
    hasText,
    loudness,
    hardSilenceDetected,
    rateMismatchDetected: rate.rateMismatchDetected,
  });

  const loudnessFlags = buildLoudnessFlags({
    baseFlags: loudness.flags,
    suppressedByLoudness: suppression.suppressedByLoudness,
    hardSilenceDetected,
    suppressedByHardSilence: suppression.suppressedByHardSilence,
  });
  const rateFlags = buildRateFlags({
    baseFlags: rate.flags,
    suppressedByRateMismatch: suppression.suppressedByRateMismatch,
  });
  const suppressed = suppression.suppressed || punctuationOnly;

  return {
    text: suppressed ? "" : trimmed,
    flags: [
      ...(input.suppressionEnabled ? [...loudnessFlags, ...rateFlags] : []),
      ...(punctuationOnly ? ["suppressed_punctuation_only"] : []),
    ],
    logprobMetrics: loudness.logprobMetrics,
    quietAudio: loudness.quietAudio,
    quietByPeak: loudness.quietByPeak,
    quietByActivity: loudness.quietByActivity,
    hardSilenceDetected,
    rateMismatchDetected: rate.rateMismatchDetected,
    syllableCount: rate.syllableCount,
    syllablesPerSecond: rate.syllablesPerSecond,
    suppressed,
  };
}
