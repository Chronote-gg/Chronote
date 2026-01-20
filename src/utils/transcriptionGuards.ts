import type { NoiseGateMetrics } from "./audioNoiseGate";
import {
  TRANSCRIPTION_LOGPROB_AVG_THRESHOLD,
  TRANSCRIPTION_LOGPROB_MIN_THRESHOLD,
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
  quietAudio: boolean;
  suppressed: boolean;
};

const normalizeValue = (value: string) => value.trim();

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
  noiseGateEnabled: boolean;
  noiseGateMetrics?: NoiseGateMetrics;
  logprobs?: LogprobEntry[];
}): TranscriptionGuardResult {
  const trimmed = normalizeValue(input.transcription);
  const flags: string[] = [];
  const quietAudio = isQuietAudio(
    input.noiseGateEnabled,
    input.noiseGateMetrics,
  );
  const logprobMetrics = buildLogprobMetrics(input.logprobs);

  if (quietAudio) {
    flags.push("quiet_audio");
    if (!logprobMetrics) {
      flags.push("logprobs_missing");
    }
  }

  const lowConfidence =
    logprobMetrics &&
    logprobMetrics.avgLogprob <= TRANSCRIPTION_LOGPROB_AVG_THRESHOLD &&
    logprobMetrics.minLogprob <= TRANSCRIPTION_LOGPROB_MIN_THRESHOLD;

  if (quietAudio && lowConfidence) {
    flags.push("low_confidence");
  }

  const suppressed =
    input.suppressionEnabled &&
    quietAudio &&
    Boolean(trimmed) &&
    !!lowConfidence;

  if (suppressed) {
    flags.push("suppressed_low_confidence");
  }

  return {
    text: suppressed ? "" : trimmed,
    flags: input.suppressionEnabled ? flags : [],
    logprobMetrics,
    quietAudio,
    suppressed,
  };
}
