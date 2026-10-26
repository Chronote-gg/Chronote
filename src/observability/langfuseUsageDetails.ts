import type { Transcription } from "openai/resources/audio";
import { updateActiveObservation } from "@langfuse/tracing";
import {
  hasPricedTranscriptionUsage,
  transcriptionAttemptMetadata,
  type TranscriptionAttemptSnapshot,
} from "./transcriptionAttempts";

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

function accountingStatus(
  requestCount: number,
  pricedRequestCount: number,
  attempts?: TranscriptionAttemptSnapshot,
): TranscriptionCostAccountingStatus {
  if (pricedRequestCount === 0) return "unpriced";
  if (pricedRequestCount !== requestCount) return "partial";
  if (
    attempts &&
    (attempts.httpDispatchAttemptCount > pricedRequestCount ||
      attempts.unknownUsageAttemptCount > 0)
  ) {
    return "partial";
  }
  return "priced";
}

export function buildLangfuseTranscriptionAccounting(
  usages: Array<Transcription["usage"]>,
  fallbackAudioSeconds?: number,
  attempts?: TranscriptionAttemptSnapshot,
): LangfuseTranscriptionAccounting {
  let input = 0;
  let output = 0;
  let pricedRequestCount = 0;
  let providerAudioSeconds = 0;

  for (const usage of usages) {
    if (hasPricedTranscriptionUsage(usage)) {
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
  const status = accountingStatus(requestCount, pricedRequestCount, attempts);

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
    providerAudioSeconds > 0
      ? providerAudioSeconds
      : attempts
        ? undefined
        : fallbackAudioSeconds,
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

export function recordLangfuseTranscriptionAccounting(
  attempts: TranscriptionAttemptSnapshot,
  audioSeconds?: number,
) {
  try {
    const accounting = buildLangfuseTranscriptionAccounting(
      attempts.returnedUsages,
      audioSeconds,
      attempts,
    );
    updateActiveObservation(
      {
        usageDetails: accounting.usageDetails,
        metadata: {
          ...transcriptionAttemptMetadata(attempts),
          transcriptionCostAccountingStatus: accounting.status,
          transcriptionRequestCount: accounting.requestCount,
          transcriptionPricedRequestCount: accounting.pricedRequestCount,
          transcriptionUnpricedRequestCount: accounting.unpricedRequestCount,
        },
      },
      { asType: "generation" },
    );
  } catch {
    // Diagnostics must preserve the provider result and rejection identity.
  }
}
