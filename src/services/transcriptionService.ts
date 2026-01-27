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
  TRANSCRIPTION_MAX_CONCURRENT,
  TRANSCRIPTION_MAX_QUEUE,
  TRANSCRIPTION_MAX_RETRIES,
  TRANSCRIPTION_RATE_MIN_TIME,
  TRANSCRIBE_SAMPLE_RATE,
} from "../constants";
import { applyTranscriptionGuards } from "../utils/transcriptionGuards";
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

type TranscriptionTraceContext = {
  userId: string;
  timestamp: number;
  audioSeconds: number;
  audioBytes: number;
  noiseGateEnabled?: boolean;
  noiseGateMetrics?: ReturnType<typeof evaluateNoiseGate>["metrics"];
};

async function transcribeInternal(
  meeting: MeetingData,
  file: string,
  context?: TranscriptionTraceContext,
): Promise<string> {
  const { prompt, langfusePrompt } = await getTranscriptionPrompt(meeting);
  const promptValue = prompt.trim();
  const resolvedPrompt = promptValue.length > 0 ? promptValue : undefined;

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
    promptLength: resolvedPrompt?.length ?? 0,
    promptName: langfusePrompt?.name,
    promptVersion: langfusePrompt?.version,
    promptFallback: langfusePrompt?.isFallback ?? false,
  };

  const runTranscription = async (openAIClient: OpenAI) => {
    const request: TranscriptionCreateParamsNonStreaming<"json"> = {
      file: createReadStream(file),
      model: modelChoice.model,
      language: "en",
      temperature: 0,
      response_format: "json",
      include: ["logprobs"],
      ...(resolvedPrompt ? { prompt: resolvedPrompt } : {}),
    };
    const transcription =
      await openAIClient.audio.transcriptions.create(request);
    return {
      text: transcription.text ?? "",
      logprobs: transcription.logprobs ?? [],
    };
  };

  const applyGuardsAndLog = (raw: {
    text: string;
    logprobs?: { logprob?: number }[];
  }) => {
    const guardResult = applyTranscriptionGuards({
      transcription: raw.text,
      suppressionEnabled:
        meeting.runtimeConfig?.transcription.suppressionEnabled ?? true,
      promptEchoEnabled:
        meeting.runtimeConfig?.transcription.promptEchoEnabled ?? true,
      promptText: resolvedPrompt,
      noiseGateEnabled: context?.noiseGateEnabled ?? false,
      noiseGateMetrics: context?.noiseGateMetrics,
      logprobs: raw.logprobs,
    });

    if (guardResult.flags.length > 0) {
      console.warn("Transcription flagged by guard checks.", {
        ...traceMetadata,
        flags: guardResult.flags,
        quietAudio: guardResult.quietAudio,
        logprobMetrics: guardResult.logprobMetrics,
        promptEchoDetected: guardResult.promptEchoDetected,
        promptEchoMetrics: guardResult.promptEchoMetrics,
        noiseGateMetrics: context?.noiseGateMetrics,
        transcriptionLength: guardResult.text.length,
      });
    }

    return guardResult;
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
    const output = await runTranscription(openAIClient);
    return applyGuardsAndLog(output).text;
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
      const output = await runTranscription(openAIClient);
      const guardResult = applyGuardsAndLog(output);

      const usageDetails = buildLangfuseTranscriptionUsageDetails(
        context?.audioSeconds,
      );
      updateActiveObservation(
        {
          output: guardResult.text,
          usageDetails,
          metadata: {
            transcriptionFlags: guardResult.flags,
            quietAudio: guardResult.quietAudio,
            logprobMetrics: guardResult.logprobMetrics,
            promptEchoDetected: guardResult.promptEchoDetected,
            promptEchoMetrics: guardResult.promptEchoMetrics,
            noiseGateMetrics: context?.noiseGateMetrics,
            suppressed: guardResult.suppressed,
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

export async function transcribeSnippet(
  meeting: MeetingData,
  snippet: AudioSnippet,
  options: {
    tempSuffix?: string;
    noiseGateMode?: "fast" | "slow";
    noiseGateEnabledOverride?: boolean;
  } = {},
): Promise<string> {
  const suffix = options.tempSuffix ? `_${options.tempSuffix}` : "";
  const tempDir = ensureMeetingTempDirSync(meeting);
  const tempPcmFileName = path.join(
    tempDir,
    `temp_snippet_${snippet.userId}_${snippet.timestamp}${suffix}_transcript.pcm`,
  );
  const tempWavFileName = path.join(
    tempDir,
    `temp_snippet_${snippet.userId}_${snippet.timestamp}${suffix}.wav`,
  );

  // Write the PCM buffer to a file
  const buffer = Buffer.concat(snippet.chunks);
  const audioBytes = buffer.length;
  const audioSeconds =
    audioBytes / (RECORD_SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE);
  const noiseGateConfig =
    meeting.runtimeConfig?.transcription.noiseGate ?? DEFAULT_NOISE_GATE_CONFIG;
  const noiseGateMode = options.noiseGateMode ?? "slow";
  const noiseGateEnabled =
    options.noiseGateEnabledOverride ??
    (noiseGateConfig.enabled &&
      (noiseGateMode === "fast"
        ? noiseGateConfig.applyToFast
        : noiseGateConfig.applyToSlow));
  const noiseGateMetrics =
    noiseGateEnabled && buffer.length > 0
      ? evaluateNoiseGate(buffer, noiseGateConfig, {
          sampleRate: RECORD_SAMPLE_RATE,
          channels: CHANNELS,
          bytesPerSample: BYTES_PER_SAMPLE,
        }).metrics
      : undefined;
  writeFileSync(tempPcmFileName, buffer);

  // Convert PCM to WAV using ffmpeg
  await new Promise<void>((resolve, reject) => {
    ffmpeg(tempPcmFileName)
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
      .save(tempWavFileName);
  });

  try {
    const transcription = await transcribe(meeting, tempWavFileName, {
      userId: snippet.userId,
      timestamp: snippet.timestamp,
      audioSeconds,
      audioBytes,
      noiseGateEnabled,
      noiseGateMetrics,
    });

    if (existsSync(tempPcmFileName)) {
      unlinkSync(tempPcmFileName);
    } else {
      console.log("failed cleaning up temp pcm file, continuing");
    }
    if (existsSync(tempWavFileName)) {
      unlinkSync(tempWavFileName);
    } else {
      console.log("failed cleaning up temp wav file, continuing");
    }

    return transcription;
  } catch (error) {
    console.error(
      `Failed to transcribe snippet for user ${snippet.userId}:`,
      error,
    );

    if (existsSync(tempPcmFileName)) {
      unlinkSync(tempPcmFileName);
    } else {
      console.log("failed cleaning up temp pcm file, continuing");
    }
    if (existsSync(tempWavFileName)) {
      unlinkSync(tempWavFileName);
    } else {
      console.log("failed cleaning up temp wav file, continuing");
    }

    return "[Transcription failed]";
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
