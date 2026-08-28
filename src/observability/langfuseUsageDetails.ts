import type { Transcription } from "openai/resources/audio";

export const LANGFUSE_AUDIO_SECONDS_USAGE_KEY = "input_audio_seconds";

export type TranscriptionCostAccountingStatus =
  "priced" | "partial" | "unpriced";

export type LangfuseTranscriptionAccounting = {
  usageDetails?: Record<string, number>;
  status: TranscriptionCostAccountingStatus;
  requestCount: number;
  pricedRequestCount: number;
  unpricedRequestCount: number;
};

const isValidUsageNumber = (value: number) =>
  Number.isFinite(value) && value >= 0;

const roundedPositiveSeconds = (audioSeconds?: number) => {
  if (typeof audioSeconds !== "number" || !Number.isFinite(audioSeconds)) {
    return undefined;
  }
  if (audioSeconds <= 0) {
    return undefined;
  }
  const rounded = Number(audioSeconds.toFixed(3));
  if (rounded <= 0) {
    return undefined;
  }
  return rounded;
};

export function buildLangfuseTranscriptionAccounting(
  usages: Array<Transcription["usage"]>,
  fallbackAudioSeconds?: number,
): LangfuseTranscriptionAccounting {
  let input = 0;
  let output = 0;
  let pricedRequestCount = 0;
  let providerAudioSeconds = 0;

  for (const usage of usages) {
    if (
      usage?.type === "tokens" &&
      isValidUsageNumber(usage.input_tokens) &&
      isValidUsageNumber(usage.output_tokens)
    ) {
      pricedRequestCount += 1;
      input += usage.input_tokens;
      output += usage.output_tokens;
    } else if (
      usage?.type === "duration" &&
      isValidUsageNumber(usage.seconds)
    ) {
      providerAudioSeconds += usage.seconds;
    }
  }

  const requestCount = usages.length;
  const unpricedRequestCount = requestCount - pricedRequestCount;
  const status: TranscriptionCostAccountingStatus =
    pricedRequestCount === requestCount && requestCount > 0
      ? "priced"
      : pricedRequestCount > 0
        ? "partial"
        : "unpriced";

  if (pricedRequestCount > 0) {
    return {
      usageDetails: { input, output, total: input + output },
      status,
      requestCount,
      pricedRequestCount,
      unpricedRequestCount,
    };
  }

  const audioSeconds = roundedPositiveSeconds(
    providerAudioSeconds > 0 ? providerAudioSeconds : fallbackAudioSeconds,
  );
  return {
    usageDetails:
      audioSeconds === undefined
        ? undefined
        : { [LANGFUSE_AUDIO_SECONDS_USAGE_KEY]: audioSeconds },
    status,
    requestCount,
    pricedRequestCount,
    unpricedRequestCount,
  };
}
