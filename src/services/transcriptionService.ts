import { recordSpeechRejection } from "./recordingContentService";
import { liveTranscriptionInput } from "./liveTranscriptionInput";
import {
  buildTranscriptionRequest,
  createTranscriptionFailureScope,
  isExhaustedTranscriptionFailure,
  runTranscriptionRequest,
} from "./transcriptionRequest";
import { createTranscriptionAttemptLedger } from "../observability/transcriptionAttempts";
import path from "node:path";
import {
  bulkhead,
  circuitBreaker,
  ConsecutiveBreaker,
  handleWhen,
} from "cockatiel";
import Bottleneck from "bottleneck";
import type { AudioSnippet, SnippetTranscriptionResult } from "../types/audio";
import type { MeetingData } from "../types/meeting-data";
import type { MeetingRuntimeConfig } from "../config/types";
import {
  BYTES_PER_SAMPLE,
  CHANNELS,
  LANGFUSE_AUDIO_ATTACHMENT_MAX_CONCURRENT,
  LANGFUSE_AUDIO_ATTACHMENT_MIN_TIME,
  NOISE_GATE_APPLY_TO_FAST,
  NOISE_GATE_APPLY_TO_SLOW,
  NOISE_GATE_ENABLED,
  NOISE_GATE_MIN_ACTIVE_WINDOWS,
  NOISE_GATE_MIN_PEAK_ABOVE_NOISE_DB,
  NOISE_GATE_PEAK_DBFS,
  NOISE_GATE_WINDOW_MS,
  RECORD_SAMPLE_RATE,
  TRANSCRIPTION_BREAK_AFTER_CONSECUTIVE_FAILURES,
  TRANSCRIPTION_BREAK_DURATION,
  TRANSCRIPTION_HARD_SILENCE_DBFS,
  TRANSCRIPTION_RATE_MAX_SECONDS,
  TRANSCRIPTION_RATE_MAX_SYLLABLES_PER_SECOND,
  TRANSCRIPTION_RATE_MIN_SYLLABLES,
  TRANSCRIPTION_RATE_MIN_WORDS,
  TRANSCRIPTION_MAX_CONCURRENT,
  TRANSCRIPTION_MAX_QUEUE,
  TRANSCRIPTION_RATE_MIN_TIME,
} from "../constants";
import { applyTranscriptionGuards } from "../utils/transcriptionGuards";
import type { createOpenAIClient } from "./openaiClient";
import { getModelChoice } from "./modelFactory";
import { isLangfuseTracingEnabled } from "./langfuseClient";
import {
  propagateAttributes,
  startActiveObservation,
  updateActiveObservation,
} from "@langfuse/tracing";
import { buildLangfuseTranscriptionAudioAttachment } from "../observability/langfuseAudioAttachment";
import { recordLangfuseTranscriptionAccounting } from "../observability/langfuseUsageDetails";
import { toLangfuseAttributeMetadata } from "../observability/langfuseMetadata";
import { ensureMeetingTempDirSync } from "./tempFileService";
import {
  evaluateNoiseGate,
  type NoiseGateMetrics,
} from "../utils/audioNoiseGate";
import { countWords } from "../utils/text";
import type { TranscriptionContentInput } from "../types/transcriptionContent";
export type { TranscriptionContentInput } from "../types/transcriptionContent";
import { getMeetingModelOverrides } from "./meetingModelOverrides";
import { getTranscriptionTextQuality } from "../utils/transcriptionText";
import {
  speechAdmissionMetadata,
  withPreparedTranscriptionInput,
} from "./transcriptionInputService";
import type {
  SpeechAdmission,
  SpeechAdmissionOrigin,
} from "./speechDetectionTypes";
import {
  DEFAULT_SPEECH_POLICY,
  speechCoverageMatches,
} from "./speechDetectionPolicy";
import { getSpeechDetector } from "./speechDetectionService";
import type { SpeechDetectionMode } from "../config/speechDetection";
import type { SpeechPhase, SpeechCoverage } from "./speechDetectionTypes";
import {
  recordSpeechAssessment,
  recordSpeechProviderSubmission,
  recordTranscriptionMissingLogprobs,
  recordSpeechRequestSkipped,
  recordSpeechSnippetOutcome,
} from "../metrics";

const DEFAULT_NOISE_GATE_CONFIG = {
  enabled: NOISE_GATE_ENABLED,
  windowMs: NOISE_GATE_WINDOW_MS,
  peakDbfs: NOISE_GATE_PEAK_DBFS,
  minActiveWindows: NOISE_GATE_MIN_ACTIVE_WINDOWS,
  minPeakAboveNoiseDb: NOISE_GATE_MIN_PEAK_ABOVE_NOISE_DB,
  applyToFast: NOISE_GATE_APPLY_TO_FAST,
  applyToSlow: NOISE_GATE_APPLY_TO_SLOW,
};

let syllableCounterPromise: Promise<(value: string) => number> | null = null;

const getSyllableCounter = async () => {
  if (!syllableCounterPromise) {
    syllableCounterPromise = import("syllable")
      .then((module) => module.syllable)
      .catch((error) => {
        syllableCounterPromise = null;
        throw error;
      });
  }
  return syllableCounterPromise;
};

const countSyllables = async (text: string) => {
  if (!text) return 0;
  const counter = await getSyllableCounter();
  return counter(text);
};

type TranscriptStats = {
  transcriptCharCount: number;
  transcriptWordCount: number;
  transcriptSyllableCount?: number;
  wordsPerSecond?: number;
  syllablesPerSecond?: number;
};

export function resolveTranscriptionGuardConfig(
  settings?: Partial<
    Pick<
      MeetingRuntimeConfig["transcription"],
      | "suppressionEnabled"
      | "suppressionHardSilenceDbfs"
      | "suppressionRateMaxSeconds"
      | "suppressionRateMinWords"
      | "suppressionRateMinSyllables"
      | "suppressionRateMaxSyllablesPerSecond"
    >
  >,
  suppressionOverride?: boolean,
) {
  return {
    suppressionEnabled:
      suppressionOverride ?? settings?.suppressionEnabled ?? true,
    hardSilenceDbfs:
      settings?.suppressionHardSilenceDbfs ?? TRANSCRIPTION_HARD_SILENCE_DBFS,
    rateMaxSeconds:
      settings?.suppressionRateMaxSeconds ?? TRANSCRIPTION_RATE_MAX_SECONDS,
    rateMinWords:
      settings?.suppressionRateMinWords ?? TRANSCRIPTION_RATE_MIN_WORDS,
    rateMinSyllables:
      settings?.suppressionRateMinSyllables ?? TRANSCRIPTION_RATE_MIN_SYLLABLES,
    maxSyllablesPerSecond:
      settings?.suppressionRateMaxSyllablesPerSecond ??
      TRANSCRIPTION_RATE_MAX_SYLLABLES_PER_SECOND,
  };
}

const buildTranscriptStats = async (options: {
  transcript: string;
  audioSeconds?: number;
  traceMetadata: Record<string, unknown>;
}): Promise<TranscriptStats> => {
  const trimmed = options.transcript.trim();
  const transcriptCharCount = trimmed.length;
  const transcriptWordCount = countWords(trimmed);
  let transcriptSyllableCount: number | undefined = 0;

  if (trimmed) {
    try {
      transcriptSyllableCount = await countSyllables(trimmed);
    } catch (error) {
      transcriptSyllableCount = undefined;
      console.warn("Failed to count syllables for transcription.", {
        ...options.traceMetadata,
        error,
      });
    }
  }

  const wordsPerSecond =
    options.audioSeconds && options.audioSeconds > 0
      ? transcriptWordCount / options.audioSeconds
      : undefined;
  const syllablesPerSecond =
    options.audioSeconds &&
    options.audioSeconds > 0 &&
    transcriptSyllableCount !== undefined
      ? transcriptSyllableCount / options.audioSeconds
      : undefined;

  return {
    transcriptCharCount,
    transcriptWordCount,
    transcriptSyllableCount,
    wordsPerSecond,
    syllablesPerSecond,
  };
};

type TranscriptionTraceContext = {
  userId: string;
  timestamp: number;
  audioSeconds: number;
  audioBytes: number;
  noiseGateEnabled?: boolean;
  noiseGateMode?: "fast" | "slow";
  noiseGateMetrics?: ReturnType<typeof evaluateNoiseGate>["metrics"];
  suppressionEnabledOverride?: boolean;
  speechDetectionMode: SpeechDetectionMode;
  speechPhase: SpeechPhase;
  speechAdmission: SpeechAdmission;
};

/** The post-ASR guards every live transcription passes, shared with the offline eval. */
export async function guardTranscription(input: {
  raw: { text?: string; logprobs?: { logprob?: number }[] };
  audioSeconds: number;
  noiseGateMetrics?: NoiseGateMetrics;
  guardConfig: ReturnType<typeof resolveTranscriptionGuardConfig>;
  traceMetadata: Record<string, unknown>;
}) {
  const { guardConfig, traceMetadata } = input;
  const raw = input.raw.text ?? "";
  const transcriptStats = await buildTranscriptStats({
    transcript: raw,
    audioSeconds: input.audioSeconds,
    traceMetadata,
  });
  const guardResult = applyTranscriptionGuards({
    transcription: raw,
    ...guardConfig,
    noiseGateMetrics: input.noiseGateMetrics,
    audioSeconds: input.audioSeconds,
    transcriptWordCount: transcriptStats.transcriptWordCount,
    transcriptSyllableCount: transcriptStats.transcriptSyllableCount,
    logprobs: input.raw.logprobs ?? [],
  });
  const rawTextQuality = getTranscriptionTextQuality(raw);
  const selectedTextQuality = getTranscriptionTextQuality(guardResult.text);
  const review = {
    flags: guardResult.flags,
    suppressed: guardResult.suppressed,
    quietAudio: guardResult.quietAudio,
    quietByPeak: guardResult.quietByPeak,
    quietByActivity: guardResult.quietByActivity,
    hardSilenceDetected: guardResult.hardSilenceDetected,
    rateMismatchDetected: guardResult.rateMismatchDetected,
    logprobMetrics: guardResult.logprobMetrics,
    ...guardConfig,
    noiseGateMetrics: input.noiseGateMetrics,
    rawTranscriptionLength: transcriptStats.transcriptCharCount,
    transcriptWordCount: transcriptStats.transcriptWordCount,
    transcriptSyllableCount: transcriptStats.transcriptSyllableCount,
    wordsPerSecond: transcriptStats.wordsPerSecond,
    syllablesPerSecond: transcriptStats.syllablesPerSecond,
    rawTextQuality: toLogSafeTextQuality(rawTextQuality),
    selectedTextQuality: toLogSafeTextQuality(selectedTextQuality),
    transcriptionLength: guardResult.text.length,
  };
  return {
    text: guardResult.text,
    review,
    needsReview:
      guardResult.flags.length > 0 ||
      rawTextQuality.trivial ||
      selectedTextQuality.trivial,
  };
}

async function transcribeInternal(
  meeting: TranscriptionContentInput,
  file: string,
  context: TranscriptionTraceContext,
  queueWaitMs: number,
): Promise<string> {
  meeting.signal.throwIfAborted();
  const passMode = context.noiseGateMode ?? "slow";
  const modelChoice = getModelChoice(
    "transcription",
    getMeetingModelOverrides(meeting),
  );
  const traceMetadata = {
    transcriptionQueueWaitMs: queueWaitMs,
    guildId: meeting.guild.id,
    channelId: meeting.voiceChannel.id,
    meetingId: meeting.meetingId,
    snippetUserId: context.userId,
    snippetTimestamp: context.timestamp,
    audioSeconds: context.audioSeconds,
    audioBytes: context.audioBytes,
    noiseGateEnabled: context.noiseGateEnabled,
    noiseGateMode: passMode,
    ...speechAdmissionMetadata(context.speechAdmission),
  };
  const ledger = createTranscriptionAttemptLedger(traceMetadata.audioSeconds);
  const guardConfig = resolveTranscriptionGuardConfig(
    meeting.runtimeConfig?.transcription,
    context.suppressionEnabledOverride,
  );

  const transcribeAndGuard = async (
    clientOptions: Parameters<typeof createOpenAIClient>[0],
  ) => {
    const transcription = await runTranscriptionRequest({
      file,
      signal: meeting.signal,
      ledger,
      clientOptions,
      onSdkInvocation: () =>
        recordSpeechProviderSubmission({
          mode: context.speechDetectionMode,
          phase: context.speechPhase,
          audioSeconds: context.audioSeconds,
        }),
      request: buildTranscriptionRequest(
        modelChoice.model,
        meeting.languageHint,
      ),
    });
    if (transcription.text.trim() && !transcription.logprobs?.length) {
      recordTranscriptionMissingLogprobs(modelChoice.model);
      console.warn("Transcription response has no logprobs.", {
        ...traceMetadata,
        model: modelChoice.model,
      });
    }
    const guarded = await guardTranscription({
      raw: transcription,
      audioSeconds: context.audioSeconds,
      noiseGateMetrics: context.noiseGateMetrics,
      guardConfig,
      traceMetadata,
    });
    if (guarded.needsReview)
      console.warn("Transcription candidate needs review.", {
        ...traceMetadata,
        ...guarded.review,
      });
    return guarded;
  };

  if (!isLangfuseTracingEnabled()) {
    const result = await transcribeAndGuard({
      traceName: "transcription",
      generationName: "transcription",
      userId: meeting.creator.id,
      sessionId: meeting.meetingId,
      tags: ["feature:transcription"],
      metadata: traceMetadata,
    });
    meeting.signal.throwIfAborted();
    return result.text;
  }

  return await propagateAttributes(
    {
      traceName: "transcription",
      userId: context.userId,
      tags: ["feature:transcription"],
      metadata: toLangfuseAttributeMetadata(traceMetadata),
    },
    async () =>
      startActiveObservation(
        "transcription",
        async () => {
          updateActiveObservation(
            {
              input: {},
              model: modelChoice.model,
              modelParameters: {
                temperature: 0,
                response_format: "json",
                include: "logprobs",
              },
              metadata: traceMetadata,
            },
            { asType: "generation" },
          );

          const attachment = meeting
            .effect(() =>
              langfuseAttachmentLimiter
                .schedule(() => {
                  meeting.signal.throwIfAborted();
                  return buildLangfuseTranscriptionAudioAttachment(file);
                })
                .then((audioAttachment) => {
                  if (!audioAttachment || meeting.signal.aborted) return;
                  updateActiveObservation(
                    {
                      input: { audio: audioAttachment.media },
                      metadata: {
                        audioAttachmentBytes: audioAttachment.byteLength,
                        audioAttachmentContentType: audioAttachment.contentType,
                      },
                    },
                    { asType: "generation" },
                  );
                })
                .catch((error) => {
                  if (meeting.signal.aborted) return;
                  console.warn(
                    "Failed to attach transcription audio to Langfuse.",
                    error,
                  );
                }),
            )
            .catch(() => {});

          let selectedText: string;
          try {
            const result = await transcribeAndGuard({ disableTracing: true });
            updateActiveObservation(
              {
                output: result.text,
                metadata: {
                  ...result.review,
                  transcriptionFlags: result.review.flags,
                  noiseGateEnabled: context.noiseGateEnabled,
                  noiseGateMode: passMode,
                },
              },
              { asType: "generation" },
            );
            selectedText = result.text;
          } finally {
            recordLangfuseTranscriptionAccounting(
              ledger.snapshot(),
              traceMetadata.audioSeconds,
            );
            await attachment;
          }
          meeting.signal.throwIfAborted();
          return selectedText;
        },
        { asType: "generation" },
      ),
  );
}

const toLogSafeTextQuality = (
  quality: ReturnType<typeof getTranscriptionTextQuality>,
) => ({
  charCount: quality.charCount,
  wordCount: quality.wordCount,
  alnumCharCount: quality.alnumCharCount,
  punctuationOnly: quality.punctuationOnly,
  trivial: quality.trivial,
  reasons: quality.reasons,
});

const breakerPolicy = circuitBreaker(
  handleWhen(isExhaustedTranscriptionFailure),
  {
    halfOpenAfter: TRANSCRIPTION_BREAK_DURATION,
    breaker: new ConsecutiveBreaker(
      TRANSCRIPTION_BREAK_AFTER_CONSECUTIVE_FAILURES,
    ),
  },
);
const bulkheadPolicy = bulkhead(
  TRANSCRIPTION_MAX_CONCURRENT,
  TRANSCRIPTION_MAX_QUEUE,
);

const limiter = new Bottleneck({
  minTime: TRANSCRIPTION_RATE_MIN_TIME,
});

const langfuseAttachmentLimiter = new Bottleneck({
  maxConcurrent: LANGFUSE_AUDIO_ATTACHMENT_MAX_CONCURRENT,
  minTime: LANGFUSE_AUDIO_ATTACHMENT_MIN_TIME,
});

async function transcribe(
  meeting: TranscriptionContentInput,
  file: string,
  context: TranscriptionTraceContext,
): Promise<string> {
  const queuedAt = performance.now();
  const scope = createTranscriptionFailureScope();
  return bulkheadPolicy.execute(() =>
    scope.run(() => {
      meeting.signal.throwIfAborted();
      return breakerPolicy.execute(() =>
        limiter.schedule(() =>
          scope.run(() => {
            meeting.signal.throwIfAborted();
            const queueWaitMs = Math.max(0, performance.now() - queuedAt);
            return transcribeInternal(meeting, file, context, queueWaitMs);
          }),
        ),
      );
    }),
  );
}

type TempSnippetFiles = {
  pcmFile: string;
  wavFile: string;
};

const buildSnippetTempFiles = (
  meeting: TranscriptionContentInput,
  snippet: AudioSnippet,
  suffix: string,
): TempSnippetFiles => {
  const tempDir = meeting.tempDirectory ?? ensureMeetingTempDirSync(meeting);
  return {
    pcmFile: path.join(
      tempDir,
      `temp_snippet_${snippet.userId}_${snippet.timestamp}${suffix}_transcript.pcm`,
    ),
    wavFile: path.join(
      tempDir,
      `temp_snippet_${snippet.userId}_${snippet.timestamp}${suffix}.wav`,
    ),
  };
};

const buildAudioStats = (buffer: Buffer) => {
  const audioBytes = buffer.length;
  const audioSeconds =
    audioBytes / (RECORD_SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE);
  return { audioBytes, audioSeconds };
};

const resolveSuppressionEnabled = (
  meeting: TranscriptionContentInput,
  override?: boolean,
) =>
  resolveTranscriptionGuardConfig(
    meeting.runtimeConfig?.transcription,
    override,
  ).suppressionEnabled;

const resolveNoiseGateContext = (input: {
  meeting: TranscriptionContentInput;
  buffer: Buffer;
  suppressionEnabled: boolean;
  noiseGateMode?: "fast" | "slow";
  noiseGateEnabledOverride?: boolean;
}) => {
  const noiseGateConfig =
    input.meeting.runtimeConfig?.transcription.noiseGate ??
    DEFAULT_NOISE_GATE_CONFIG;
  const noiseGateMode = input.noiseGateMode ?? "slow";
  const noiseGateEnabled =
    input.noiseGateEnabledOverride ??
    (noiseGateConfig.enabled &&
      (noiseGateMode === "fast"
        ? noiseGateConfig.applyToFast
        : noiseGateConfig.applyToSlow));
  const shouldComputeMetrics =
    input.buffer.length > 0 && (noiseGateEnabled || input.suppressionEnabled);
  const noiseGateMetrics = shouldComputeMetrics
    ? evaluateNoiseGate(input.buffer, noiseGateConfig, {
        sampleRate: RECORD_SAMPLE_RATE,
        channels: CHANNELS,
        bytesPerSample: BYTES_PER_SAMPLE,
      }).metrics
    : undefined;

  return { noiseGateEnabled, noiseGateMetrics };
};

function reusableSnippetTranscript(
  buffer: Buffer,
  options: NonNullable<Parameters<typeof transcribeContentSnippet>[2]>,
) {
  const reuse = options.reuseTranscript;
  if (options.speechDetectionBypass === true || !reuse) return undefined;
  return !getTranscriptionTextQuality(reuse.text).trivial &&
    speechCoverageMatches(
      buffer,
      reuse.coverage,
      DEFAULT_SPEECH_POLICY.policyFingerprint,
    )
    ? reuse
    : undefined;
}

export async function transcribeContentSnippet(
  meeting: TranscriptionContentInput,
  snippet: AudioSnippet,
  options: {
    tempSuffix?: string;
    noiseGateMode?: "fast" | "slow";
    noiseGateEnabledOverride?: boolean;
    suppressionEnabledOverride?: boolean;
    speechDetectionBypass?: boolean;
    reuseTranscript?: {
      text: string;
      coverage: SpeechCoverage;
      origin?: SpeechAdmissionOrigin;
    };
  } = {},
): Promise<SnippetTranscriptionResult> {
  const startedAt = performance.now();
  const mode =
    meeting.runtimeConfig?.transcription.speechDetectionMode ?? "off";
  const phase = options.noiseGateMode ?? "slow";
  const force = options.speechDetectionBypass === true;
  const suffix = options.tempSuffix ? `_${options.tempSuffix}` : "";
  const buffer = Buffer.concat(snippet.chunks);
  const { audioBytes, audioSeconds } = buildAudioStats(buffer);
  const suppressionEnabled = resolveSuppressionEnabled(
    meeting,
    options.suppressionEnabledOverride,
  );
  const resolvedNoiseGateMode = options.noiseGateMode ?? "slow";
  const { noiseGateEnabled, noiseGateMetrics } = resolveNoiseGateContext({
    meeting,
    buffer,
    suppressionEnabled,
    noiseGateMode: resolvedNoiseGateMode,
    noiseGateEnabledOverride: options.noiseGateEnabledOverride,
  });

  let stage: "conversion" | "transcription" = "conversion";
  let outcome: Parameters<typeof recordSpeechSnippetOutcome>[0]["outcome"] =
    "conversion_error";
  try {
    const tempFiles = buildSnippetTempFiles(meeting, snippet, suffix);
    const signal = meeting.signal;
    signal.throwIfAborted();
    const reuse = reusableSnippetTranscript(buffer, options);
    if (reuse) {
      outcome = "reused";
      return {
        status: "succeeded",
        text: reuse.text,
        admission: {
          kind: "reused",
          coverage: reuse.coverage,
          origin: reuse.origin,
        },
      };
    }
    return await withPreparedTranscriptionInput<SnippetTranscriptionResult>(
      {
        pcm: buffer,
        ...tempFiles,
        mode,
        phase,
        force,
        policyFingerprint: DEFAULT_SPEECH_POLICY.policyFingerprint,
        detector: mode === "off" || force ? undefined : getSpeechDetector(),
        signal,
        observe: (assessment, durationMs) =>
          recordSpeechAssessment({ mode, phase, assessment, durationMs }),
      },
      async ({ wavFile, admission, coverage }) => {
        signal.throwIfAborted();
        if (
          admission.kind === "assessed" &&
          admission.assessment.kind === "non_speech"
        ) {
          outcome = "vad_skipped";
          recordSpeechRequestSkipped({ phase, audioSeconds });
          return { status: "skipped", reason: "non_speech", coverage };
        }
        stage = "transcription";
        outcome = "provider_error";
        const text = await transcribe(meeting, wavFile, {
          userId: snippet.userId,
          timestamp: snippet.timestamp,
          audioSeconds,
          audioBytes,
          noiseGateEnabled,
          noiseGateMode: resolvedNoiseGateMode,
          noiseGateMetrics,
          suppressionEnabledOverride: options.suppressionEnabledOverride,
          speechDetectionMode: mode,
          speechPhase: phase,
          speechAdmission: admission,
        });
        outcome = "transcribed";
        return { status: "succeeded", text, admission };
      },
    );
  } catch (error) {
    const providerError = error as { status?: unknown; code?: unknown };
    const failureLabel = stage === "conversion" ? "convert" : "transcribe";
    console.error(
      `Failed to ${failureLabel} snippet for user ${snippet.userId}.`,
      {
        status:
          typeof providerError.status === "number"
            ? providerError.status
            : undefined,
        code:
          typeof providerError.code === "number"
            ? providerError.code
            : undefined,
      },
    );
    return {
      status: "failed",
      reason:
        stage === "conversion" ? "conversion_error" : "transcription_error",
    };
  } finally {
    recordSpeechSnippetOutcome({
      mode,
      phase,
      outcome,
      audioSeconds,
      durationMs: performance.now() - startedAt,
    });
  }
}

export async function transcribeSnippet(
  meeting: MeetingData,
  snippet: AudioSnippet,
  options: Parameters<typeof transcribeContentSnippet>[2] = {},
) {
  const { userId, timestamp } = snippet;
  const pcmSpans = snippet.pcmSpans?.map((span) => ({ ...span }));
  const result = await transcribeContentSnippet(
    liveTranscriptionInput(meeting),
    snippet,
    options,
  );
  if (result.status === "skipped")
    recordSpeechRejection(
      meeting,
      { userId, timestamp, pcmSpans },
      result.coverage,
      options.noiseGateMode ?? "slow",
    );
  return result;
}
