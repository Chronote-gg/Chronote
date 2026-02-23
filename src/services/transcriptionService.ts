import type OpenAI from "openai";
import type { TranscriptionCreateParamsNonStreaming } from "openai/resources/audio";
import {
  createReadStream,
  existsSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import ffmpeg from "fluent-ffmpeg";
import {
  bulkhead,
  circuitBreaker,
  ConsecutiveBreaker,
  ExponentialBackoff,
  handleAll,
  retry,
  wrap,
} from "cockatiel";
import Bottleneck from "bottleneck";
import type { AudioSnippet, TranscriptVariant } from "../types/audio";
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
  TRANSCRIPTION_MAX_RETRIES,
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
import { createOpenAIClient } from "./openaiClient";
import { getModelChoice } from "./modelFactory";
import { isLangfuseTracingEnabled } from "./langfuseClient";
import {
  startActiveObservation,
  updateActiveObservation,
  updateActiveTrace,
} from "@langfuse/tracing";
import { buildLangfuseTranscriptionAudioAttachment } from "../observability/langfuseAudioAttachment";
import { buildLangfuseTranscriptionUsageDetails } from "../observability/langfuseUsageDetails";
import { ensureMeetingTempDirSync } from "./tempFileService";
import { evaluateNoiseGate } from "../utils/audioNoiseGate";
import { countWords } from "../utils/text";
import {
  getTranscriptionPrompt,
  getTranscriptionCleanupPrompt,
  getTranscriptionCoalescePrompt,
} from "./transcriptionPromptService";
import { chat } from "./openaiChatService";
import { getMeetingModelOverrides } from "./meetingModelOverrides";

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
      .then((module) => {
        const counter = module.syllable ?? module.default ?? module;
        if (typeof counter !== "function") {
          throw new Error("Failed to load syllable counter.");
        }
        return counter;
      })
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

const resolvePromptEchoEnabled = (meeting: MeetingData) =>
  meeting.runtimeConfig?.transcription.promptEchoEnabled ?? true;

const resolveTranscriptionVoteEnabled = (meeting: MeetingData) =>
  meeting.runtimeConfig?.transcription.voteEnabled ?? true;

const resolveHardSilenceDbfs = (meeting: MeetingData) =>
  meeting.runtimeConfig?.transcription.suppressionHardSilenceDbfs ??
  TRANSCRIPTION_HARD_SILENCE_DBFS;

const resolveRateConfig = (meeting: MeetingData) => {
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
  meeting: MeetingData,
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
  meeting: MeetingData,
  file: string,
  context?: TranscriptionTraceContext,
): Promise<string> {
  const { prompt, langfusePrompt } = await getTranscriptionPrompt(meeting);
  const promptValue = prompt.trim();
  const resolvedPrompt = promptValue.length > 0 ? promptValue : undefined;
  const passMode = context?.noiseGateMode ?? "slow";
  const voteEnabled = resolveTranscriptionVoteEnabled(meeting);

  const modelChoice = getModelChoice(
    "transcription",
    getMeetingModelOverrides(meeting),
  );
  const traceMetadata = {
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

  const runTranscription = async (
    openAIClient: OpenAI,
    promptText?: string,
  ) => {
    const request: TranscriptionCreateParamsNonStreaming<"json"> = {
      file: createReadStream(file),
      model: modelChoice.model,
      language: "en",
      temperature: 0,
      response_format: "json",
      include: ["logprobs"],
      ...(promptText ? { prompt: promptText } : {}),
    };
    const transcription =
      await openAIClient.audio.transcriptions.create(request);
    return {
      text: transcription.text ?? "",
      logprobs: transcription.logprobs ?? [],
    };
  };

  const guardConfig = resolveGuardConfig(meeting, context);

  type GuardedTranscriptionResult = {
    candidateId: "prompt" | "no_prompt";
    guardResult: ReturnType<typeof applyTranscriptionGuards>;
    transcriptStats: TranscriptStats;
    suppressionEnabled: boolean;
    promptEchoEnabled: boolean;
    hardSilenceDbfs: number;
    rateMaxSeconds: number;
    rateMinWords: number;
    rateMinSyllables: number;
    maxSyllablesPerSecond: number;
  };

  const applyGuardsAndLog = async (
    raw: {
      text: string;
      logprobs?: { logprob?: number }[];
    },
    candidate: {
      id: "prompt" | "no_prompt";
      promptText?: string;
    },
  ): Promise<GuardedTranscriptionResult> => {
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

    if (guardResult.flags.length > 0) {
      console.warn("Transcription flagged by guard checks.", {
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
        transcriptionLength: guardResult.text.length,
      });
    }

    return {
      candidateId: candidate.id,
      guardResult,
      transcriptStats,
      suppressionEnabled: guardConfig.suppressionEnabled,
      promptEchoEnabled: promptEchoEnabledForCandidate,
      hardSilenceDbfs: guardConfig.hardSilenceDbfs,
      rateMaxSeconds: guardConfig.rateMaxSeconds,
      rateMinWords: guardConfig.rateMinWords,
      rateMinSyllables: guardConfig.rateMinSyllables,
      maxSyllablesPerSecond: guardConfig.maxSyllablesPerSecond,
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
    openAIClient: OpenAI,
  ): Promise<TranscriptionSelection> => {
    const promptOutput = await runTranscription(openAIClient, resolvedPrompt);
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

    const noPromptOutput = await runTranscription(openAIClient);
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
    const openAIClient = createOpenAIClient({
      traceName: "transcription",
      generationName: "transcription",
      userId: meeting.creator.id,
      sessionId: meeting.meetingId,
      tags: ["feature:transcription"],
      metadata: traceMetadata,
      langfusePrompt,
    });
    const selection = await runAndSelectTranscription(openAIClient);
    return selection.selected.guardResult.text;
  }

  return await startActiveObservation(
    "transcription",
    async () => {
      updateActiveTrace({
        name: "transcription",
        userId: context?.userId,
        tags: ["feature:transcription"],
        metadata: traceMetadata,
      });
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

      void langfuseAttachmentLimiter
        .schedule(() => buildLangfuseTranscriptionAudioAttachment(file))
        .then((audioAttachment) => {
          if (!audioAttachment) return;
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
          console.warn(
            "Failed to attach transcription audio to Langfuse.",
            error,
          );
        });

      const openAIClient = createOpenAIClient({
        disableTracing: true,
        langfusePrompt,
      });
      const selection = await runAndSelectTranscription(openAIClient);
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

      const usageDetails = buildLangfuseTranscriptionUsageDetails(
        context?.audioSeconds,
      );
      updateActiveObservation(
        {
          output: guardResult.text,
          usageDetails,
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
            transcriptionVoteAttempted: Boolean(selection.noPromptCandidate),
            transcriptionVoteSelected: selection.selected.candidateId,
            transcriptionVoteDecisionReasons: selection.voteDecision?.reasons,
            transcriptionVotePromptScore: selection.voteDecision?.promptScore,
            transcriptionVoteNoPromptScore:
              selection.voteDecision?.noPromptScore,
            transcriptionVotePromptFlags:
              selection.promptCandidate.guardResult.flags,
            transcriptionVoteNoPromptFlags:
              selection.noPromptCandidate?.guardResult.flags,
          },
        },
        { asType: "generation" },
      );

      return guardResult.text;
    },
    { asType: "generation" },
  );
}

const retryPolicy = retry(handleAll, {
  maxAttempts: TRANSCRIPTION_MAX_RETRIES,
  backoff: new ExponentialBackoff(),
});
const breakerPolicy = circuitBreaker(handleAll, {
  halfOpenAfter: TRANSCRIPTION_BREAK_DURATION,
  breaker: new ConsecutiveBreaker(
    TRANSCRIPTION_BREAK_AFTER_CONSECUTIVE_FAILURES,
  ),
});
const bulkheadPolicy = bulkhead(
  TRANSCRIPTION_MAX_CONCURRENT,
  TRANSCRIPTION_MAX_QUEUE,
);

const policies = wrap(bulkheadPolicy, breakerPolicy, retryPolicy);

const limiter = new Bottleneck({
  minTime: TRANSCRIPTION_RATE_MIN_TIME,
});

const langfuseAttachmentLimiter = new Bottleneck({
  maxConcurrent: LANGFUSE_AUDIO_ATTACHMENT_MAX_CONCURRENT,
  minTime: LANGFUSE_AUDIO_ATTACHMENT_MIN_TIME,
});

async function transcribe(
  meeting: MeetingData,
  file: string,
  context?: TranscriptionTraceContext,
): Promise<string> {
  return await policies.execute(() =>
    limiter.schedule(() => transcribeInternal(meeting, file, context)),
  );
}

type TempSnippetFiles = {
  pcmFile: string;
  wavFile: string;
};

const buildSnippetTempFiles = (
  meeting: MeetingData,
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
  meeting: MeetingData,
  override?: boolean,
): boolean =>
  override ?? meeting.runtimeConfig?.transcription.suppressionEnabled ?? true;

const resolveNoiseGateContext = (input: {
  meeting: MeetingData;
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

const convertPcmToWav = (inputFile: string, outputFile: string) =>
  new Promise<void>((resolve, reject) => {
    ffmpeg(inputFile)
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
        resolve();
      })
      .on("error", (err) => {
        console.error(`Error converting PCM to WAV: ${err.message}`);
        reject(err);
      })
      .save(outputFile);
  });

const cleanupTempFile = (filePath: string, label: string) => {
  if (existsSync(filePath)) {
    unlinkSync(filePath);
    return;
  }
  console.log(`failed cleaning up temp ${label} file, continuing`);
};

const cleanupTempFiles = (files: TempSnippetFiles) => {
  cleanupTempFile(files.pcmFile, "pcm");
  cleanupTempFile(files.wavFile, "wav");
};

export async function transcribeSnippet(
  meeting: MeetingData,
  snippet: AudioSnippet,
  options: {
    tempSuffix?: string;
    noiseGateMode?: "fast" | "slow";
    noiseGateEnabledOverride?: boolean;
    suppressionEnabledOverride?: boolean;
  } = {},
): Promise<string> {
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

  writeFileSync(tempFiles.pcmFile, buffer);
  await convertPcmToWav(tempFiles.pcmFile, tempFiles.wavFile);

  try {
    return await transcribe(meeting, tempFiles.wavFile, {
      userId: snippet.userId,
      timestamp: snippet.timestamp,
      audioSeconds,
      audioBytes,
      noiseGateEnabled,
      noiseGateMode: resolvedNoiseGateMode,
      noiseGateMetrics,
      suppressionEnabledOverride: options.suppressionEnabledOverride,
    });
  } catch (error) {
    console.error(
      `Failed to transcribe snippet for user ${snippet.userId}:`,
      error,
    );
    return "[Transcription failed]";
  } finally {
    cleanupTempFiles(tempFiles);
  }
}

type CoalesceInput = {
  slowTranscript: string;
  fastTranscripts: TranscriptVariant[];
};

export async function cleanupTranscription(
  meeting: MeetingData,
  transcription: string,
) {
  const { messages, langfusePrompt } = await getTranscriptionCleanupPrompt(
    meeting,
    transcription,
  );
  const modelChoice = getModelChoice(
    "transcriptionCleanup",
    getMeetingModelOverrides(meeting),
  );
  return await chat(
    meeting,
    {
      messages: [...messages],
    },
    {
      model: modelChoice.model,
      traceName: "transcription-cleanup",
      generationName: "transcription-cleanup",
      tags: ["feature:transcription_cleanup"],
      langfusePrompt,
      parentSpanContext: meeting.langfuseParentSpanContext,
      modelParamRole: "transcriptionCleanup",
    },
  );
}

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
