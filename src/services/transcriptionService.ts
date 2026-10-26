import { liveTranscriptionInput } from "./liveTranscriptionInput";
import {
  createTranscriptionFailureScope,
  isExhaustedTranscriptionFailure,
  runTranscriptionRequest,
} from "./transcriptionRequest";
import {
  createTranscriptionAttemptLedger,
  type TranscriptionCandidateId,
} from "../observability/transcriptionAttempts";
import type { Transcription } from "openai/resources/audio";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import ffmpeg from "fluent-ffmpeg";
import {
  bulkhead,
  circuitBreaker,
  ConsecutiveBreaker,
  handleWhen,
} from "cockatiel";
import Bottleneck from "bottleneck";
import type {
  AudioSnippet,
  SnippetTranscriptionResult,
  TranscriptVariant,
} from "../types/audio";
import type { MeetingData } from "../types/meeting-data";
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
  TRANSCRIBE_SAMPLE_RATE,
} from "../constants";
import { applyTranscriptionGuards } from "../utils/transcriptionGuards";
import {
  decideTranscriptionVote,
  shouldRunTranscriptionVote,
  type TranscriptionVoteCandidate,
  type TranscriptionVoteDecision,
  type TranscriptionVoteGateResult,
} from "../utils/transcriptionVote";
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
import { evaluateNoiseGate } from "../utils/audioNoiseGate";
import { countWords } from "../utils/text";
import {
  getTranscriptionPrompt,
  getTranscriptionCoalescePrompt,
} from "./transcriptionPromptService";
import { chat } from "./openaiChatService";
import { getMeetingModelOverrides } from "./meetingModelOverrides";
import { getTranscriptionTextQuality } from "../utils/transcriptionText";

export type TranscriptionContentInput = {
  observeGeneration?: import("../types/fixtureEvidence").GenerationObserver;
  meetingId: string;
  creator: { id: string };
  guild: { id: string };
  voiceChannel: { id: string };
  signal: AbortSignal;
  runtimeConfig?: Pick<
    NonNullable<MeetingData["runtimeConfig"]>,
    "transcription" | "modelChoices"
  >;
  prompt(): ReturnType<typeof getTranscriptionPrompt>;
  effect<T>(run: () => Promise<T>): Promise<T>;
};

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

type TranscriptionGuardConfig = {
  suppressionEnabled: boolean;
  promptEchoEnabled: boolean;
  hardSilenceDbfs: number;
  rateMaxSeconds: number;
  rateMinWords: number;
  rateMinSyllables: number;
  maxSyllablesPerSecond: number;
};

type TranscriptStats = {
  transcriptCharCount: number;
  transcriptWordCount: number;
  transcriptSyllableCount?: number;
  wordsPerSecond?: number;
  syllablesPerSecond?: number;
};

const resolvePromptEchoEnabled = (meeting: TranscriptionContentInput) =>
  meeting.runtimeConfig?.transcription.promptEchoEnabled ?? true;

const resolveTranscriptionVoteEnabled = (meeting: TranscriptionContentInput) =>
  meeting.runtimeConfig?.transcription.voteEnabled ?? true;

const resolveHardSilenceDbfs = (meeting: TranscriptionContentInput) =>
  meeting.runtimeConfig?.transcription.suppressionHardSilenceDbfs ??
  TRANSCRIPTION_HARD_SILENCE_DBFS;

const resolveRateConfig = (meeting: TranscriptionContentInput) => {
  const transcriptionConfig = meeting.runtimeConfig?.transcription;
  return {
    rateMaxSeconds:
      transcriptionConfig?.suppressionRateMaxSeconds ??
      TRANSCRIPTION_RATE_MAX_SECONDS,
    rateMinWords:
      transcriptionConfig?.suppressionRateMinWords ??
      TRANSCRIPTION_RATE_MIN_WORDS,
    rateMinSyllables:
      transcriptionConfig?.suppressionRateMinSyllables ??
      TRANSCRIPTION_RATE_MIN_SYLLABLES,
    maxSyllablesPerSecond:
      transcriptionConfig?.suppressionRateMaxSyllablesPerSecond ??
      TRANSCRIPTION_RATE_MAX_SYLLABLES_PER_SECOND,
  };
};

const resolveGuardConfig = (
  meeting: TranscriptionContentInput,
  context?: TranscriptionTraceContext,
): TranscriptionGuardConfig => {
  const rateConfig = resolveRateConfig(meeting);
  return {
    suppressionEnabled: resolveSuppressionEnabled(
      meeting,
      context?.suppressionEnabledOverride,
    ),
    promptEchoEnabled: resolvePromptEchoEnabled(meeting),
    hardSilenceDbfs: resolveHardSilenceDbfs(meeting),
    rateMaxSeconds: rateConfig.rateMaxSeconds,
    rateMinWords: rateConfig.rateMinWords,
    rateMinSyllables: rateConfig.rateMinSyllables,
    maxSyllablesPerSecond: rateConfig.maxSyllablesPerSecond,
  };
};

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
};

async function transcribeInternal(
  meeting: TranscriptionContentInput,
  file: string,
  context: TranscriptionTraceContext | undefined,
  queueWaitMs: number,
): Promise<string> {
  meeting.signal.throwIfAborted();
  const { prompt, langfusePrompt } = await meeting.prompt();
  meeting.signal.throwIfAborted();
  const promptValue = prompt.trim();
  const resolvedPrompt = promptValue.length > 0 ? promptValue : undefined;
  const passMode = context?.noiseGateMode ?? "slow";
  const voteEnabled = resolveTranscriptionVoteEnabled(meeting);

  const modelChoice = getModelChoice(
    "transcription",
    getMeetingModelOverrides(meeting),
  );
  const traceMetadata = {
    transcriptionQueueWaitMs: queueWaitMs,
    guildId: meeting.guild.id,
    channelId: meeting.voiceChannel.id,
    meetingId: meeting.meetingId,
    snippetUserId: context?.userId,
    snippetTimestamp: context?.timestamp,
    audioSeconds: context?.audioSeconds,
    audioBytes: context?.audioBytes,
    noiseGateEnabled: context?.noiseGateEnabled,
    noiseGateMode: passMode,
    promptLength: resolvedPrompt?.length ?? 0,
    promptName: langfusePrompt?.name,
    promptVersion: langfusePrompt?.version,
    promptFallback: langfusePrompt?.isFallback ?? false,
    transcriptionVoteEnabled: voteEnabled,
  };
  const ledger = createTranscriptionAttemptLedger(traceMetadata.audioSeconds);

  const runTranscription = async (
    candidate: TranscriptionCandidateId,
    clientOptions: Parameters<typeof createOpenAIClient>[0],
    promptText?: string,
  ) => {
    const transcription = await runTranscriptionRequest({
      candidate,
      file,
      signal: meeting.signal,
      ledger,
      clientOptions,
      observeGeneration: meeting.observeGeneration,
      generationOperation: `transcription-audio-${passMode}`,
      request: {
        model: modelChoice.model,
        language: "en",
        temperature: 0,
        response_format: "json",
        include: ["logprobs"],
        ...(promptText ? { prompt: promptText } : {}),
      },
    });
    return {
      text: transcription.text ?? "",
      logprobs: transcription.logprobs ?? [],
      usage: transcription.usage,
    };
  };

  const guardConfig = resolveGuardConfig(meeting, context);

  type GuardedTranscriptionResult = {
    candidateId: "prompt" | "no_prompt";
    rawTextQuality: ReturnType<typeof getTranscriptionTextQuality>;
    selectedTextQuality: ReturnType<typeof getTranscriptionTextQuality>;
    guardResult: ReturnType<typeof applyTranscriptionGuards>;
    transcriptStats: TranscriptStats;
    suppressionEnabled: boolean;
    promptEchoEnabled: boolean;
    hardSilenceDbfs: number;
    rateMaxSeconds: number;
    rateMinWords: number;
    rateMinSyllables: number;
    maxSyllablesPerSecond: number;
    usage?: Transcription["usage"];
  };

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

  const applyGuardsAndLog = async (
    raw: {
      text: string;
      logprobs?: { logprob?: number }[];
      usage?: Transcription["usage"];
    },
    candidate: {
      id: "prompt" | "no_prompt";
      promptText?: string;
    },
  ): Promise<GuardedTranscriptionResult> => {
    const rawTextQuality = getTranscriptionTextQuality(raw.text);
    const promptEchoEnabledForCandidate =
      guardConfig.promptEchoEnabled && Boolean(candidate.promptText);

    const transcriptStats = await buildTranscriptStats({
      transcript: raw.text,
      audioSeconds: context?.audioSeconds,
      traceMetadata,
    });
    const guardResult = applyTranscriptionGuards({
      transcription: raw.text,
      suppressionEnabled: guardConfig.suppressionEnabled,
      hardSilenceDbfs: guardConfig.hardSilenceDbfs,
      rateMaxSeconds: guardConfig.rateMaxSeconds,
      rateMinWords: guardConfig.rateMinWords,
      rateMinSyllables: guardConfig.rateMinSyllables,
      maxSyllablesPerSecond: guardConfig.maxSyllablesPerSecond,
      promptEchoEnabled: promptEchoEnabledForCandidate,
      promptText: candidate.promptText,
      noiseGateMetrics: context?.noiseGateMetrics,
      audioSeconds: context?.audioSeconds,
      transcriptWordCount: transcriptStats.transcriptWordCount,
      transcriptSyllableCount: transcriptStats.transcriptSyllableCount,
      logprobs: raw.logprobs,
    });
    const selectedTextQuality = getTranscriptionTextQuality(guardResult.text);
    const rawTextQualityForLogs = toLogSafeTextQuality(rawTextQuality);
    const selectedTextQualityForLogs =
      toLogSafeTextQuality(selectedTextQuality);

    if (
      guardResult.flags.length > 0 ||
      rawTextQuality.trivial ||
      selectedTextQuality.trivial
    ) {
      console.warn("Transcription candidate needs review.", {
        ...traceMetadata,
        transcriptionCandidate: candidate.id,
        candidatePromptLength: candidate.promptText?.length ?? 0,
        flags: guardResult.flags,
        quietAudio: guardResult.quietAudio,
        quietByPeak: guardResult.quietByPeak,
        quietByActivity: guardResult.quietByActivity,
        hardSilenceDetected: guardResult.hardSilenceDetected,
        rateMismatchDetected: guardResult.rateMismatchDetected,
        suppressionEnabled: guardConfig.suppressionEnabled,
        promptEchoEnabled: promptEchoEnabledForCandidate,
        hardSilenceDbfs: guardConfig.hardSilenceDbfs,
        rateMaxSeconds: guardConfig.rateMaxSeconds,
        rateMinWords: guardConfig.rateMinWords,
        rateMinSyllables: guardConfig.rateMinSyllables,
        maxSyllablesPerSecond: guardConfig.maxSyllablesPerSecond,
        logprobMetrics: guardResult.logprobMetrics,
        promptEchoDetected: guardResult.promptEchoDetected,
        promptEchoMetrics: guardResult.promptEchoMetrics,
        noiseGateMetrics: context?.noiseGateMetrics,
        rawTranscriptionLength: transcriptStats.transcriptCharCount,
        transcriptWordCount: transcriptStats.transcriptWordCount,
        transcriptSyllableCount: transcriptStats.transcriptSyllableCount,
        wordsPerSecond: transcriptStats.wordsPerSecond,
        syllablesPerSecond: transcriptStats.syllablesPerSecond,
        rawTextQuality: rawTextQualityForLogs,
        selectedTextQuality: selectedTextQualityForLogs,
        transcriptionLength: guardResult.text.length,
      });
    }

    return {
      candidateId: candidate.id,
      rawTextQuality,
      selectedTextQuality,
      guardResult,
      transcriptStats,
      suppressionEnabled: guardConfig.suppressionEnabled,
      promptEchoEnabled: promptEchoEnabledForCandidate,
      hardSilenceDbfs: guardConfig.hardSilenceDbfs,
      rateMaxSeconds: guardConfig.rateMaxSeconds,
      rateMinWords: guardConfig.rateMinWords,
      rateMinSyllables: guardConfig.rateMinSyllables,
      maxSyllablesPerSecond: guardConfig.maxSyllablesPerSecond,
      usage: raw.usage,
    };
  };

  const buildVoteCandidate = (
    candidate: GuardedTranscriptionResult,
  ): TranscriptionVoteCandidate => {
    return {
      id: candidate.candidateId,
      text: candidate.guardResult.text,
      suppressed: candidate.guardResult.suppressed,
      promptEchoDetected: candidate.guardResult.promptEchoDetected,
      rateMismatchDetected: candidate.guardResult.rateMismatchDetected,
      quietAudio: candidate.guardResult.quietAudio,
      logprobMetrics: candidate.guardResult.logprobMetrics,
    };
  };

  type TranscriptionSelection = {
    selected: GuardedTranscriptionResult;
    promptCandidate: GuardedTranscriptionResult;
    noPromptCandidate?: GuardedTranscriptionResult;
    voteGate: TranscriptionVoteGateResult;
    voteDecision?: TranscriptionVoteDecision;
  };

  const runAndSelectTranscription = async (
    clientOptions: Parameters<typeof createOpenAIClient>[0],
  ): Promise<TranscriptionSelection> => {
    const promptOutput = await runTranscription(
      "prompt",
      clientOptions,
      resolvedPrompt,
    );
    const promptCandidate = await applyGuardsAndLog(promptOutput, {
      id: "prompt",
      promptText: resolvedPrompt,
    });

    const voteGate = shouldRunTranscriptionVote({
      enabled: voteEnabled,
      hasPrompt: Boolean(resolvedPrompt),
      passMode,
      primaryCandidate: buildVoteCandidate(promptCandidate),
    });

    if (!voteGate.shouldRun) {
      return {
        selected: promptCandidate,
        promptCandidate,
        voteGate,
      };
    }

    const noPromptOutput = await runTranscription("no_prompt", clientOptions);
    const noPromptCandidate = await applyGuardsAndLog(noPromptOutput, {
      id: "no_prompt",
    });

    const voteDecision = decideTranscriptionVote({
      promptCandidate: buildVoteCandidate(promptCandidate),
      noPromptCandidate: buildVoteCandidate(noPromptCandidate),
    });
    const selected =
      voteDecision.selectedId === "no_prompt"
        ? noPromptCandidate
        : promptCandidate;

    console.log("Transcription vote selected candidate.", {
      ...traceMetadata,
      voteGateReasons: voteGate.reasons,
      voteDecisionReasons: voteDecision.reasons,
      voteSelectedCandidate: voteDecision.selectedId,
      votePromptScore: voteDecision.promptScore,
      voteNoPromptScore: voteDecision.noPromptScore,
      votePromptFlags: promptCandidate.guardResult.flags,
      voteNoPromptFlags: noPromptCandidate.guardResult.flags,
      votePromptSuppressed: promptCandidate.guardResult.suppressed,
      voteNoPromptSuppressed: noPromptCandidate.guardResult.suppressed,
      votePromptTrivialText: promptCandidate.selectedTextQuality.trivial,
      votePromptTrivialReasons: promptCandidate.selectedTextQuality.reasons,
      voteNoPromptTrivialText: noPromptCandidate.selectedTextQuality.trivial,
      voteNoPromptTrivialReasons: noPromptCandidate.selectedTextQuality.reasons,
    });

    return {
      selected,
      promptCandidate,
      noPromptCandidate,
      voteGate,
      voteDecision,
    };
  };

  if (!isLangfuseTracingEnabled()) {
    const selection = await runAndSelectTranscription({
      traceName: "transcription",
      generationName: "transcription",
      userId: meeting.creator.id,
      sessionId: meeting.meetingId,
      tags: ["feature:transcription"],
      metadata: traceMetadata,
      langfusePrompt,
    });
    meeting.signal.throwIfAborted();
    return selection.selected.guardResult.text;
  }

  return await propagateAttributes(
    {
      traceName: "transcription",
      userId: context?.userId,
      tags: ["feature:transcription"],
      metadata: toLangfuseAttributeMetadata(traceMetadata),
    },
    async () =>
      startActiveObservation(
        "transcription",
        async () => {
          const observationInput = {
            language: "en",
            ...(resolvedPrompt ? { prompt: resolvedPrompt } : {}),
          };
          updateActiveObservation(
            {
              input: observationInput,
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
                      input: {
                        ...observationInput,
                        audio: audioAttachment.media,
                      },
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
            const selection = await runAndSelectTranscription({
              disableTracing: true,
              langfusePrompt,
            });
            const {
              guardResult,
              transcriptStats,
              suppressionEnabled,
              promptEchoEnabled,
              hardSilenceDbfs,
              rateMaxSeconds,
              rateMinWords,
              rateMinSyllables,
              maxSyllablesPerSecond,
            } = selection.selected;

            updateActiveObservation(
              {
                output: guardResult.text,
                metadata: {
                  transcriptionFlags: guardResult.flags,
                  transcriptionCandidate: selection.selected.candidateId,
                  quietAudio: guardResult.quietAudio,
                  quietByPeak: guardResult.quietByPeak,
                  quietByActivity: guardResult.quietByActivity,
                  hardSilenceDetected: guardResult.hardSilenceDetected,
                  suppressionEnabled,
                  promptEchoEnabled,
                  hardSilenceDbfs,
                  rateMaxSeconds,
                  rateMinWords,
                  rateMinSyllables,
                  maxSyllablesPerSecond,
                  ...transcriptStats,
                  transcriptionRawTextTrivial:
                    selection.selected.rawTextQuality.trivial,
                  transcriptionRawTextReasons:
                    selection.selected.rawTextQuality.reasons,
                  transcriptionTextTrivial:
                    selection.selected.selectedTextQuality.trivial,
                  transcriptionTextReasons:
                    selection.selected.selectedTextQuality.reasons,
                  transcriptionAlnumCharCount:
                    selection.selected.selectedTextQuality.alnumCharCount,
                  logprobMetrics: guardResult.logprobMetrics,
                  promptEchoDetected: guardResult.promptEchoDetected,
                  promptEchoMetrics: guardResult.promptEchoMetrics,
                  rateMismatchDetected: guardResult.rateMismatchDetected,
                  noiseGateEnabled: context?.noiseGateEnabled,
                  noiseGateMode: passMode,
                  noiseGateMetrics: context?.noiseGateMetrics,
                  suppressed: guardResult.suppressed,
                  transcriptionVoteEnabled: voteEnabled,
                  transcriptionVoteGateReasons: selection.voteGate.reasons,
                  transcriptionVoteAttempted: Boolean(
                    selection.noPromptCandidate,
                  ),
                  transcriptionVoteSelected: selection.selected.candidateId,
                  transcriptionVoteDecisionReasons:
                    selection.voteDecision?.reasons,
                  transcriptionVotePromptScore:
                    selection.voteDecision?.promptScore,
                  transcriptionVoteNoPromptScore:
                    selection.voteDecision?.noPromptScore,
                  transcriptionVotePromptFlags:
                    selection.promptCandidate.guardResult.flags,
                  transcriptionVoteNoPromptFlags:
                    selection.noPromptCandidate?.guardResult.flags,
                  transcriptionVotePromptTrivialText:
                    selection.promptCandidate.selectedTextQuality.trivial,
                  transcriptionVotePromptTrivialReasons:
                    selection.promptCandidate.selectedTextQuality.reasons,
                  transcriptionVoteNoPromptTrivialText:
                    selection.noPromptCandidate?.selectedTextQuality.trivial,
                  transcriptionVoteNoPromptTrivialReasons:
                    selection.noPromptCandidate?.selectedTextQuality.reasons,
                },
              },
              { asType: "generation" },
            );

            selectedText = guardResult.text;
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
  context?: TranscriptionTraceContext,
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
  const tempDir = ensureMeetingTempDirSync(meeting);
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
): boolean =>
  override ?? meeting.runtimeConfig?.transcription.suppressionEnabled ?? true;

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

const convertPcmToWav = (
  inputFile: string,
  outputFile: string,
  signal: AbortSignal,
) =>
  new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const command = ffmpeg(inputFile);
    const cancel = () => command.kill("SIGTERM");
    signal.addEventListener("abort", cancel, { once: true });
    command
      .on("start", () => {
        if (signal.aborted) cancel();
      })
      .inputOptions([
        `-f s16le`,
        `-ar ${RECORD_SAMPLE_RATE}`,
        `-ac ${CHANNELS}`,
      ])
      .outputOptions([
        `-f wav`,
        `-c:a pcm_s16le`,
        `-ar ${TRANSCRIBE_SAMPLE_RATE}`,
      ])
      .on("end", () => {
        signal.removeEventListener("abort", cancel);
        resolve();
      })
      .on("error", (err) => {
        signal.removeEventListener("abort", cancel);
        console.error(`Error converting PCM to WAV: ${err.message}`);
        reject(err);
      })
      .save(outputFile);
  });

const cleanupTempFile = (filePath: string, label: string) => {
  try {
    if (existsSync(filePath)) {
      unlinkSync(filePath);
      return;
    }
    console.log(`failed cleaning up temp ${label} file, continuing`);
  } catch {
    console.warn(`Failed cleaning up temp ${label} file, continuing.`);
  }
};

const cleanupTempFiles = (files: TempSnippetFiles) => {
  cleanupTempFile(files.pcmFile, "pcm");
  cleanupTempFile(files.wavFile, "wav");
};

export async function transcribeContentSnippet(
  meeting: TranscriptionContentInput,
  snippet: AudioSnippet,
  options: {
    tempSuffix?: string;
    noiseGateMode?: "fast" | "slow";
    noiseGateEnabledOverride?: boolean;
    suppressionEnabledOverride?: boolean;
  } = {},
): Promise<SnippetTranscriptionResult> {
  const suffix = options.tempSuffix ? `_${options.tempSuffix}` : "";
  const tempFiles = buildSnippetTempFiles(meeting, snippet, suffix);
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
  try {
    const signal = meeting.signal;
    signal.throwIfAborted();
    writeFileSync(tempFiles.pcmFile, buffer);
    await convertPcmToWav(tempFiles.pcmFile, tempFiles.wavFile, signal);
    signal.throwIfAborted();
    stage = "transcription";
    const text = await transcribe(meeting, tempFiles.wavFile, {
      userId: snippet.userId,
      timestamp: snippet.timestamp,
      audioSeconds,
      audioBytes,
      noiseGateEnabled,
      noiseGateMode: resolvedNoiseGateMode,
      noiseGateMetrics,
      suppressionEnabledOverride: options.suppressionEnabledOverride,
    });
    return { status: "succeeded", text };
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
    cleanupTempFiles(tempFiles);
  }
}

export function transcribeSnippet(
  meeting: MeetingData,
  snippet: AudioSnippet,
  options: Parameters<typeof transcribeContentSnippet>[2] = {},
) {
  return transcribeContentSnippet(
    liveTranscriptionInput(meeting),
    snippet,
    options,
  );
}

type CoalesceInput = {
  slowTranscript: string;
  fastTranscripts: TranscriptVariant[];
};

export async function coalesceTranscription(
  meeting: MeetingData,
  input: CoalesceInput,
): Promise<string> {
  const { messages, langfusePrompt } = await getTranscriptionCoalescePrompt(
    meeting,
    input,
  );
  const modelChoice = getModelChoice(
    "transcriptionCoalesce",
    getMeetingModelOverrides(meeting),
  );
  return await chat(
    meeting,
    {
      messages: [...messages],
    },
    {
      model: modelChoice.model,
      traceName: "transcription-coalesce",
      generationName: "transcription-coalesce",
      tags: ["feature:transcription_coalesce"],
      langfusePrompt,
      parentSpanContext: meeting.langfuseParentSpanContext,
      modelParamRole: "transcriptionCoalesce",
    },
  );
}
