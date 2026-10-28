import {
  transcriptionLanguageParam,
  type TranscriptionLanguage,
} from "../config/transcriptionLanguage";
import { liveFinalPassInput } from "./liveTranscriptionInput";
import { finalPassSettingsSchema } from "../types/recordingContent";

import type { FinalPassSettings } from "../types/recordingContent";

import { withTranscriptionInput } from "./transcriptionInput";
import { promises as fs } from "node:fs";
import path from "node:path";
import ffmpeg from "fluent-ffmpeg";
import type { TranscriptionCreateParamsNonStreaming } from "openai/resources/audio";
import { z } from "zod";
import type { AudioFileData } from "../types/audio";
import type { MeetingData } from "../types/meeting-data";
import { chat, type ChatMeetingInput } from "./openaiChatService";
import { createOpenAIClient } from "./openaiClient";

import {
  type FinalPassSegmentInput,
  getTranscriptionFinalPassPrompt,
  getTranscriptionPrompt,
} from "./transcriptionPromptService";
import { ensureMeetingTempDir } from "./tempFileService";
import {
  areLowInformationTranscriptionTextsNearDuplicates,
  isLowInformationTranscriptionText,
  isTrivialTranscriptionText,
} from "../utils/transcriptionText";
import {
  resolveAudioFileText,
  resolveAudioFileTranscript,
} from "../utils/audioTranscript";

export type FinalPassContent = ChatMeetingInput & {
  startTime: Date;
  endTime?: Date;
  participants: MeetingData["participants"];
  audioData: Pick<MeetingData["audioData"], "audioFiles">;
  signal: AbortSignal;
  enabled: boolean;
  settings: FinalPassSettings;
  langfuseParentSpanContext?: MeetingData["langfuseParentSpanContext"];
  transcriptionModel: string;
  transcriptionLanguage: TranscriptionLanguage;
  reconcileModel: import("../types/recordingContent").SavedRecordingSettings["models"]["notes"];
  prompt(): ReturnType<typeof getTranscriptionPrompt>;
  finalPassPrompt(
    input: Parameters<typeof getTranscriptionFinalPassPrompt>[1],
  ): ReturnType<typeof getTranscriptionFinalPassPrompt>;
  effect<T>(run: () => Promise<T>): Promise<T>;
};
type ChunkLogprobEntry = {
  logprob?: number;
};

type ChunkLogprobMetrics = {
  avgLogprob: number;
  minLogprob: number;
  tokenCount: number;
};

type BaselineSegment = {
  segmentId: string;
  fileData: AudioFileData;
  speakerKey: string;
  speaker: string;
  startedAt: string;
  offsetSeconds: number;
  estimatedEndSeconds: number;
  text: string;
};

type ChunkWindow = {
  index: number;
  startSeconds: number;
  endSeconds: number;
};

type FinalPassChunkTranscription = {
  text: string;
  logprobs?: ChunkLogprobEntry[];
};

const FinalPassEditSchema = z.object({
  segmentId: z.string().min(1),
  action: z.enum(["replace", "drop"]),
  text: z.string().optional(),
  confidence: z.number().min(0).max(1).default(0),
  reason: z.string().optional(),
});

type FinalPassEdit = z.infer<typeof FinalPassEditSchema>;

const FinalPassResponseSchema = z.object({
  edits: z.array(FinalPassEditSchema).default([]),
});

type FinalPassDependencies = {
  ensureTempDir: (meeting: FinalPassContent) => Promise<string>;
  getAudioDurationSeconds: (
    audioFilePath: string,
  ) => Promise<number | undefined>;
  renderAudioChunk: (input: {
    inputPath: string;
    outputPath: string;
    startSeconds: number;
    durationSeconds: number;
    signal?: AbortSignal;
  }) => Promise<void>;
  transcribeChunk: (input: {
    meeting: FinalPassContent;
    chunkFilePath: string;
    previousChunkTail: string;
    chunkIndex: number;
    chunkCount: number;
  }) => Promise<FinalPassChunkTranscription>;
  reconcileBatch: (input: {
    meeting: FinalPassContent;
    chunkTranscript: string;
    previousChunkTail: string;
    chunkLogprobSummary: string;
    chunkIndex: number;
    chunkCount: number;
    baselineSegments: BaselineSegment[];
  }) => Promise<FinalPassEdit[]>;
  deleteTempFile: (filePath: string) => Promise<void>;
};

type FinalPassCounters = {
  processedChunks: number;
  candidateEdits: number;
  rejectedTrivialEdits: number;
};

type ChunkProcessingResult = {
  processed: boolean;
  candidateEdits: number;
  rejectedTrivialEdits: number;
  nextTail: string;
};

export type TranscriptionFinalPassResult = {
  enabled: boolean;
  applied: boolean;
  processedChunks: number;
  totalChunks: number;
  totalSegments: number;
  candidateEdits: number;
  acceptedEdits: number;
  replacedSegments: number;
  droppedSegments: number;
  rejectedTrivialEdits: number;
  repetitionFilteredSegments: number;
  fallbackApplied: boolean;
  fallbackReason?: string;
};

const resolveSpeakerLabel = (
  meeting: FinalPassContent,
  userId: string,
): string => {
  const participant = meeting.participants.get(userId);
  if (!participant) {
    return userId;
  }
  return (
    participant.serverNickname ||
    participant.displayName ||
    participant.username ||
    participant.tag ||
    userId
  );
};

const buildBaselineSegments = (
  meeting: FinalPassContent,
): BaselineSegment[] => {
  const startedAtMs = meeting.startTime.getTime();
  const maxSnippetSeconds = meeting.settings.maxSnippetMilliseconds / 1000;
  const orderedFiles = [...meeting.audioData.audioFiles].sort(
    (a, b) => a.timestamp - b.timestamp,
  );

  const segments: BaselineSegment[] = [];
  let segmentCounter = 1;

  for (const fileData of orderedFiles) {
    const text = resolveAudioFileText(fileData).trim();
    if (!text) {
      continue;
    }

    segments.push({
      segmentId: `seg-${segmentCounter}`,
      fileData,
      speakerKey: fileData.userId,
      speaker: resolveSpeakerLabel(meeting, fileData.userId),
      startedAt: new Date(fileData.timestamp).toISOString(),
      offsetSeconds: Math.max(0, (fileData.timestamp - startedAtMs) / 1000),
      estimatedEndSeconds: 0,
      text,
    });

    segmentCounter += 1;
  }

  for (let index = 0; index < segments.length; index += 1) {
    const current = segments[index];
    const next = segments[index + 1];
    const cappedEnd = current.offsetSeconds + maxSnippetSeconds;
    current.estimatedEndSeconds = next
      ? Math.min(cappedEnd, next.offsetSeconds)
      : cappedEnd;
  }

  return segments;
};

const estimateChunkSeconds = (settings: FinalPassSettings) => {
  const byTargetSize = Math.floor(
    settings.targetMaxChunkBytes / settings.estimatedMp3BytesPerSecond,
  );
  const byHardLimit = Math.floor(
    settings.maxRequestBytes / settings.estimatedMp3BytesPerSecond,
  );
  return Math.max(
    settings.minChunkSeconds,
    Math.min(settings.chunkSeconds, byTargetSize, byHardLimit),
  );
};

const getAudioDurationSeconds = async (inputPath: string) =>
  await new Promise<number | undefined>((resolve) => {
    ffmpeg.ffprobe(inputPath, (error, metadata) => {
      if (error) {
        console.warn("Failed to read audio duration for final pass.", {
          inputPath,
          error,
        });
        resolve(undefined);
        return;
      }

      const duration = metadata?.format?.duration;
      if (typeof duration !== "number" || !Number.isFinite(duration)) {
        resolve(undefined);
        return;
      }
      resolve(duration > 0 ? duration : undefined);
    });
  });

const renderAudioChunk = async (input: {
  inputPath: string;
  outputPath: string;
  startSeconds: number;
  durationSeconds: number;
  signal?: AbortSignal;
}) =>
  await new Promise<void>((resolve, reject) => {
    input.signal?.throwIfAborted();
    const command = ffmpeg(input.inputPath);
    const cancel = () => command.kill("SIGTERM");
    input.signal?.addEventListener("abort", cancel, { once: true });
    command
      .on("start", () => {
        if (input.signal?.aborted) cancel();
      })
      .setStartTime(input.startSeconds)
      .setDuration(input.durationSeconds)
      .audioCodec("libmp3lame")
      .audioBitrate("128k")
      .audioChannels(2)
      .audioFrequency(48000)
      .toFormat("mp3")
      .on("end", () => {
        input.signal?.removeEventListener("abort", cancel);
        resolve();
      })
      .on("error", (error) => {
        input.signal?.removeEventListener("abort", cancel);
        reject(error);
      })
      .save(input.outputPath);
  });

const buildLogprobMetrics = (
  logprobs?: ChunkLogprobEntry[],
): ChunkLogprobMetrics | undefined => {
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

const summarizeLogprobMetrics = (metrics?: ChunkLogprobMetrics): string => {
  if (!metrics) {
    return "No logprobs returned.";
  }
  return `avgLogprob=${metrics.avgLogprob.toFixed(3)}, minLogprob=${metrics.minLogprob.toFixed(3)}, tokenCount=${metrics.tokenCount}`;
};

const takeTail = (value: string, maxChars: number): string => {
  if (maxChars <= 0) return "";
  if (value.length <= maxChars) return value;
  return value.slice(value.length - maxChars);
};

const stripCodeFences = (value: string): string =>
  value
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

const parseFinalPassEdits = (raw: string): FinalPassEdit[] => {
  const cleaned = stripCodeFences(raw);
  if (!cleaned) return [];

  const objectStart = cleaned.indexOf("{");
  const objectEnd = cleaned.lastIndexOf("}");
  if (objectStart === -1 || objectEnd === -1 || objectEnd < objectStart) {
    return [];
  }

  const candidateJson = cleaned.slice(objectStart, objectEnd + 1);
  try {
    const parsed = JSON.parse(candidateJson);
    const validated = FinalPassResponseSchema.safeParse(parsed);
    if (!validated.success) {
      return [];
    }
    return validated.data.edits;
  } catch {
    return [];
  }
};

const buildChunkWindows = (
  durationSeconds: number,
  chunkSeconds: number,
): ChunkWindow[] => {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return [];
  }

  if (
    !Number.isFinite(chunkSeconds) ||
    chunkSeconds < 1 ||
    durationSeconds > 7200
  )
    throw new Error("Invalid or nonprogressing finalized-pass chunk window");
  const windows: ChunkWindow[] = [];
  for (
    let startSeconds = 0, index = 0;
    startSeconds < durationSeconds;
    startSeconds += chunkSeconds, index += 1
  ) {
    const endSeconds = Math.min(durationSeconds, startSeconds + chunkSeconds);
    windows.push({ index, startSeconds, endSeconds });
  }
  return windows;
};

const segmentPromptLength = (segment: BaselineSegment) =>
  segment.segmentId.length +
  segment.speaker.length +
  segment.startedAt.length +
  segment.text.length +
  12;

const batchSegments = (segments: BaselineSegment[], maxChars: number) => {
  const batches: BaselineSegment[][] = [];
  let currentBatch: BaselineSegment[] = [];
  let currentChars = 0;

  for (const segment of segments) {
    const nextChars = segmentPromptLength(segment);
    const exceedsLimit =
      currentBatch.length > 0 && currentChars + nextChars > maxChars;

    if (exceedsLimit) {
      batches.push(currentBatch);
      currentBatch = [];
      currentChars = 0;
    }

    currentBatch.push(segment);
    currentChars += nextChars;
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches;
};

const EMPTY_FINAL_PASS_RESULT: Omit<TranscriptionFinalPassResult, "enabled"> = {
  applied: false,
  processedChunks: 0,
  totalChunks: 0,
  totalSegments: 0,
  candidateEdits: 0,
  acceptedEdits: 0,
  replacedSegments: 0,
  droppedSegments: 0,
  rejectedTrivialEdits: 0,
  repetitionFilteredSegments: 0,
  fallbackApplied: false,
};

const createResult = (
  input: Partial<TranscriptionFinalPassResult> & { enabled: boolean },
): TranscriptionFinalPassResult => ({
  ...EMPTY_FINAL_PASS_RESULT,
  ...input,
  enabled: input.enabled,
});

const resetFinalPassTranscripts = (meeting: FinalPassContent) => {
  for (const fileData of meeting.audioData.audioFiles) {
    delete fileData.finalPassTranscript;
    delete fileData.finalPassCorrespondence;
  }
};

const getChunkSegments = (
  segments: BaselineSegment[],
  chunk: ChunkWindow,
): BaselineSegment[] =>
  segments.filter(
    (segment) =>
      segment.offsetSeconds < chunk.endSeconds &&
      segment.estimatedEndSeconds > chunk.startSeconds,
  );

const getSegmentById = (
  segments: BaselineSegment[],
  segmentId: string,
): BaselineSegment | undefined =>
  segments.find((segment) => segment.segmentId === segmentId);

const isEditUsable = (
  edit: FinalPassEdit,
  segment: BaselineSegment,
  minimumConfidence: number,
): boolean => {
  if (edit.confidence < minimumConfidence) {
    return false;
  }
  if (edit.action !== "replace") {
    return true;
  }
  const replacement = (edit.text ?? "").trim();
  if (!replacement) {
    return false;
  }
  return replacement !== segment.text;
};

const updateAcceptedEdit = (
  acceptedEdits: Map<string, FinalPassEdit>,
  edit: FinalPassEdit,
) => {
  const current = acceptedEdits.get(edit.segmentId);
  if (!current || edit.confidence > current.confidence) {
    acceptedEdits.set(edit.segmentId, edit);
  }
};

const applyBatchEdits = (
  batch: BaselineSegment[],
  edits: FinalPassEdit[],
  acceptedEdits: Map<string, FinalPassEdit>,
  minimumConfidence: number,
): { candidateEdits: number; rejectedTrivialEdits: number } => {
  let candidateEdits = 0;
  let rejectedTrivialEdits = 0;
  for (const edit of edits) {
    candidateEdits += 1;
    const segment = getSegmentById(batch, edit.segmentId);
    if (!segment || !isEditUsable(edit, segment, minimumConfidence)) {
      continue;
    }
    if (edit.action === "replace") {
      const replacement = (edit.text ?? "").trim();
      if (replacement && isTrivialTranscriptionText(replacement)) {
        rejectedTrivialEdits += 1;
        continue;
      }
    }
    updateAcceptedEdit(acceptedEdits, edit);
  }
  return { candidateEdits, rejectedTrivialEdits };
};

const reconcileChunkBatches = async (input: {
  meeting: FinalPassContent;
  chunkTranscript: string;
  previousChunkTail: string;
  logprobSummary: string;
  chunk: ChunkWindow;
  chunkCount: number;
  chunkSegments: BaselineSegment[];
  acceptedEdits: Map<string, FinalPassEdit>;
  dependencies: FinalPassDependencies;
}): Promise<{ candidateEdits: number; rejectedTrivialEdits: number }> => {
  let candidateEdits = 0;
  let rejectedTrivialEdits = 0;
  const batches = batchSegments(
    input.chunkSegments,
    input.meeting.settings.segmentBatchMaxChars,
  );
  for (const batch of batches) {
    input.meeting.signal.throwIfAborted();
    const edits = await input.dependencies.reconcileBatch({
      meeting: input.meeting,
      chunkTranscript: input.chunkTranscript,
      previousChunkTail: input.previousChunkTail,
      chunkLogprobSummary: input.logprobSummary,
      chunkIndex: input.chunk.index + 1,
      chunkCount: input.chunkCount,
      baselineSegments: batch,
    });
    input.meeting.signal.throwIfAborted();
    const batchResult = applyBatchEdits(
      batch,
      edits,
      input.acceptedEdits,
      input.meeting.settings.minConfidence,
    );
    candidateEdits += batchResult.candidateEdits;
    rejectedTrivialEdits += batchResult.rejectedTrivialEdits;
  }
  return { candidateEdits, rejectedTrivialEdits };
};

const processChunk = async (input: {
  meeting: FinalPassContent;
  options: { audioFilePath: string };
  dependencies: FinalPassDependencies;
  tempDir: string;
  chunk: ChunkWindow;
  chunkCount: number;
  chunkSegments: BaselineSegment[];
  acceptedEdits: Map<string, FinalPassEdit>;
  previousChunkTail: string;
}): Promise<ChunkProcessingResult> => {
  const chunkFilePath = path.join(
    input.tempDir,
    `transcription_final_pass_chunk_${input.chunk.index + 1}.mp3`,
  );

  const signal = input.meeting.signal;
  try {
    signal.throwIfAborted();
    await input.dependencies.renderAudioChunk({
      inputPath: input.options.audioFilePath,
      outputPath: chunkFilePath,
      startSeconds: input.chunk.startSeconds,
      durationSeconds: input.chunk.endSeconds - input.chunk.startSeconds,
      signal,
    });

    signal.throwIfAborted();
    const chunkTranscription = await input.dependencies.transcribeChunk({
      meeting: input.meeting,
      chunkFilePath,
      previousChunkTail: input.previousChunkTail,
      chunkIndex: input.chunk.index + 1,
      chunkCount: input.chunkCount,
    });

    signal.throwIfAborted();
    const chunkTranscript = chunkTranscription.text.trim();
    const nextTail = takeTail(
      chunkTranscript,
      input.meeting.settings.previousTailChars,
    );
    if (!chunkTranscript) {
      return {
        processed: true,
        candidateEdits: 0,
        rejectedTrivialEdits: 0,
        nextTail,
      };
    }

    const logprobSummary = summarizeLogprobMetrics(
      buildLogprobMetrics(chunkTranscription.logprobs),
    );
    const batchTotals = await reconcileChunkBatches({
      meeting: input.meeting,
      chunkTranscript,
      previousChunkTail: input.previousChunkTail,
      logprobSummary,
      chunk: input.chunk,
      chunkCount: input.chunkCount,
      chunkSegments: input.chunkSegments,
      acceptedEdits: input.acceptedEdits,
      dependencies: input.dependencies,
    });

    return {
      processed: true,
      candidateEdits: batchTotals.candidateEdits,
      rejectedTrivialEdits: batchTotals.rejectedTrivialEdits,
      nextTail,
    };
  } catch (error) {
    signal.throwIfAborted();
    console.error("Final transcription pass chunk failed.", {
      meetingId: input.meeting.meetingId,
      chunkIndex: input.chunk.index + 1,
      error,
    });
    return {
      processed: true,
      candidateEdits: 0,
      rejectedTrivialEdits: 0,
      nextTail: input.previousChunkTail,
    };
  } finally {
    await input.dependencies.deleteTempFile(chunkFilePath);
  }
};

const processAllChunks = async (input: {
  meeting: FinalPassContent;
  options: { audioFilePath: string };
  dependencies: FinalPassDependencies;
  tempDir: string;
  chunkWindows: ChunkWindow[];
  baselineSegments: BaselineSegment[];
  acceptedEdits: Map<string, FinalPassEdit>;
}): Promise<FinalPassCounters> => {
  let processedChunks = 0;
  let candidateEdits = 0;
  let rejectedTrivialEdits = 0;
  let previousChunkTail = "";

  for (const chunk of input.chunkWindows) {
    const chunkSegments = getChunkSegments(input.baselineSegments, chunk);
    if (chunkSegments.length === 0) {
      continue;
    }

    const result = await processChunk({
      meeting: input.meeting,
      options: input.options,
      dependencies: input.dependencies,
      tempDir: input.tempDir,
      chunk,
      chunkCount: input.chunkWindows.length,
      chunkSegments,
      acceptedEdits: input.acceptedEdits,
      previousChunkTail,
    });

    if (result.processed) {
      processedChunks += 1;
    }
    candidateEdits += result.candidateEdits;
    rejectedTrivialEdits += result.rejectedTrivialEdits;
    previousChunkTail = result.nextTail;
  }

  return { processedChunks, candidateEdits, rejectedTrivialEdits };
};

const summarizeAcceptedEdits = (
  acceptedEdits: Map<string, FinalPassEdit>,
  totalSegments: number,
) => {
  const droppedSegments = Array.from(acceptedEdits.values()).filter(
    (edit) => edit.action === "drop",
  ).length;
  const replacedSegments = acceptedEdits.size - droppedSegments;
  return {
    droppedSegments,
    replacedSegments,
    dropRatio: droppedSegments / totalSegments,
    changeRatio: acceptedEdits.size / totalSegments,
  };
};

const applyAcceptedEdits = (
  baselineSegments: BaselineSegment[],
  acceptedEdits: Map<string, FinalPassEdit>,
) => {
  const baselineById = new Map(
    baselineSegments.map((segment) => [segment.segmentId, segment]),
  );
  for (const [segmentId, edit] of acceptedEdits) {
    const segment = baselineById.get(segmentId);
    if (!segment) {
      continue;
    }
    if (edit.action === "drop") {
      segment.fileData.finalPassCorrespondence = resolveAudioFileTranscript(
        segment.fileData,
      ).correspondence;
      segment.fileData.finalPassTranscript = "";
      continue;
    }
    const replacement = (edit.text ?? "").trim();
    if (!replacement) {
      continue;
    }
    segment.fileData.finalPassCorrespondence = resolveAudioFileTranscript(
      segment.fileData,
    ).correspondence;
    segment.fileData.finalPassTranscript = replacement;
  }
};

const resolveEffectiveSegmentText = (segment: BaselineSegment) =>
  segment.fileData.finalPassTranscript !== undefined
    ? segment.fileData.finalPassTranscript
    : segment.text;

const applyRepeatedLowInformationFilter = (
  baselineSegments: BaselineSegment[],
  repeatWindowSeconds: number,
): number => {
  const lastKeptBySpeaker = new Map<
    string,
    { text: string; offsetSeconds: number }[]
  >();
  let repetitionFilteredSegments = 0;

  for (const segment of baselineSegments) {
    const text = resolveEffectiveSegmentText(segment).trim();
    if (!isLowInformationTranscriptionText(text)) {
      continue;
    }

    const speakerEntries = lastKeptBySpeaker.get(segment.speakerKey) ?? [];
    const windowStart = segment.offsetSeconds - repeatWindowSeconds;
    const recentEntries = speakerEntries.filter(
      (entry) => entry.offsetSeconds >= windowStart,
    );
    const duplicate = recentEntries.some((entry) =>
      areLowInformationTranscriptionTextsNearDuplicates(text, entry.text),
    );

    if (duplicate) {
      segment.fileData.finalPassCorrespondence = resolveAudioFileTranscript(
        segment.fileData,
      ).correspondence;
      segment.fileData.finalPassTranscript = "";
      repetitionFilteredSegments += 1;
      lastKeptBySpeaker.set(segment.speakerKey, recentEntries);
      continue;
    }

    recentEntries.push({ text, offsetSeconds: segment.offsetSeconds });
    lastKeptBySpeaker.set(segment.speakerKey, recentEntries);
  }

  return repetitionFilteredSegments;
};

const defaultDependencies: FinalPassDependencies = {
  ensureTempDir: async (meeting) => await ensureMeetingTempDir(meeting),
  getAudioDurationSeconds,
  renderAudioChunk,
  transcribeChunk: async (input) => {
    const { prompt, langfusePrompt } = await input.meeting.prompt();
    const promptValue = prompt.trim();
    const continuityTail = input.previousChunkTail.trim();
    const continuationPrompt = continuityTail
      ? `Previous chunk transcript tail (context only):\n${continuityTail}`
      : "";
    const combinedPrompt = [promptValue, continuationPrompt]
      .filter(Boolean)
      .join("\n\n")
      .trim();

    const modelChoice = { model: input.meeting.transcriptionModel };

    const openAIClient = createOpenAIClient({
      traceName: "transcription-final-pass-audio",
      generationName: "transcription-final-pass-audio",
      userId: input.meeting.creator.id,
      sessionId: input.meeting.meetingId,
      tags: ["feature:transcription_final_pass"],
      metadata: {
        guildId: input.meeting.guild.id,
        channelId: input.meeting.voiceChannel.id,
        meetingId: input.meeting.meetingId,
        chunkIndex: input.chunkIndex,
        chunkCount: input.chunkCount,
      },
      langfusePrompt,
      parentSpanContext: input.meeting.langfuseParentSpanContext,
    });

    const signal = input.meeting.signal;
    signal.throwIfAborted();
    const request: Omit<
      TranscriptionCreateParamsNonStreaming<"json">,
      "file"
    > = {
      model: modelChoice.model,
      ...transcriptionLanguageParam(input.meeting.transcriptionLanguage),
      temperature: 0,
      response_format: "json",
      include: ["logprobs"],
      ...(combinedPrompt ? { prompt: combinedPrompt } : {}),
    };

    const acknowledge = input.meeting.observeGeneration?.(
      "transcription-audio-final-pass",
      modelChoice.model,
      combinedPrompt ? langfusePrompt : null,
    );
    const result = await withTranscriptionInput(input.chunkFilePath, (file) =>
      openAIClient.audio.transcriptions.create(
        { ...request, file },
        { signal },
      ),
    );
    signal.throwIfAborted();
    acknowledge?.(null);
    return {
      text: result.text ?? "",
      logprobs: result.logprobs ?? [],
    };
  },
  reconcileBatch: async (input) => {
    const promptSegments: FinalPassSegmentInput[] = input.baselineSegments.map(
      (segment) => ({
        segmentId: segment.segmentId,
        speaker: segment.speaker,
        startedAt: segment.startedAt,
        text: segment.text,
      }),
    );

    const { messages, langfusePrompt } = await input.meeting.finalPassPrompt({
      chunkIndex: input.chunkIndex,
      chunkCount: input.chunkCount,
      chunkTranscript: input.chunkTranscript,
      previousChunkTail: input.previousChunkTail,
      chunkLogprobSummary: input.chunkLogprobSummary,
      baselineSegments: promptSegments,
    });

    const modelChoice = input.meeting.reconcileModel;

    const raw = await chat(
      input.meeting,
      {
        messages: [...messages],
      },
      {
        model: modelChoice.model,
        frozenModel: modelChoice,
        traceName: "transcription-final-pass-reconcile",
        generationName: "transcription-final-pass-reconcile",
        tags: ["feature:transcription_final_pass"],
        langfusePrompt,
        parentSpanContext: input.meeting.langfuseParentSpanContext,
        modelParamRole: "transcriptionCoalesce",
        metadata: {
          chunkIndex: input.chunkIndex,
          chunkCount: input.chunkCount,
          segmentCount: input.baselineSegments.length,
        },
      },
    );

    return parseFinalPassEdits(raw);
  },
  deleteTempFile: async (filePath) => {
    await fs.rm(filePath, { force: true });
  },
};

export function runTranscriptionFinalPass(
  meeting: MeetingData,
  options: { audioFilePath: string },
  dependencyOverrides: Partial<FinalPassDependencies> = {},
) {
  return runContentTranscriptionFinalPass(
    liveFinalPassInput(meeting),
    options,
    dependencyOverrides,
  );
}
export function runContentTranscriptionFinalPass(
  content: FinalPassContent,
  options: { audioFilePath: string },
  dependencyOverrides: Partial<FinalPassDependencies> = {},
) {
  return content.effect(() =>
    runOwnedTranscriptionFinalPass(content, options, dependencyOverrides),
  );
}
async function runOwnedTranscriptionFinalPass(
  meeting: FinalPassContent,
  options: {
    audioFilePath: string;
  },
  dependencyOverrides: Partial<FinalPassDependencies> = {},
): Promise<TranscriptionFinalPassResult> {
  const signal = meeting.signal;
  signal.throwIfAborted();
  const enabled = meeting.enabled;
  if (!enabled) {
    return createResult({ enabled: false });
  }

  finalPassSettingsSchema.parse(meeting.settings);
  const dependencies: FinalPassDependencies = {
    ...defaultDependencies,
    ...dependencyOverrides,
  };

  resetFinalPassTranscripts(meeting);

  const baselineSegments = buildBaselineSegments(meeting);
  if (baselineSegments.length === 0) {
    return createResult({ enabled: true });
  }

  try {
    const chunkSeconds = estimateChunkSeconds(meeting.settings);
    const fallbackDurationSeconds = meeting.endTime
      ? Math.max(
          1,
          (meeting.endTime.getTime() - meeting.startTime.getTime()) / 1000,
        )
      : baselineSegments[baselineSegments.length - 1].offsetSeconds + 1;
    const detectedDurationSeconds =
      (await dependencies.getAudioDurationSeconds(options.audioFilePath)) ??
      fallbackDurationSeconds;
    signal.throwIfAborted();
    const chunkWindows = buildChunkWindows(
      detectedDurationSeconds,
      chunkSeconds,
    );

    if (chunkWindows.length === 0) {
      return createResult({
        enabled: true,
        totalSegments: baselineSegments.length,
      });
    }

    const tempDir = await dependencies.ensureTempDir(meeting);
    signal.throwIfAborted();
    const acceptedEdits = new Map<string, FinalPassEdit>();
    const counters = await processAllChunks({
      meeting,
      options,
      dependencies,
      tempDir,
      chunkWindows,
      baselineSegments,
      acceptedEdits,
    });

    signal.throwIfAborted();
    if (acceptedEdits.size === 0) {
      const repetitionFilteredSegments = applyRepeatedLowInformationFilter(
        baselineSegments,
        meeting.settings.repeatWindowSeconds,
      );
      return createResult({
        enabled: true,
        applied: repetitionFilteredSegments > 0,
        processedChunks: counters.processedChunks,
        totalChunks: chunkWindows.length,
        totalSegments: baselineSegments.length,
        candidateEdits: counters.candidateEdits,
        rejectedTrivialEdits: counters.rejectedTrivialEdits,
        droppedSegments: repetitionFilteredSegments,
        repetitionFilteredSegments,
      });
    }

    const editSummary = summarizeAcceptedEdits(
      acceptedEdits,
      baselineSegments.length,
    );

    if (
      editSummary.dropRatio > meeting.settings.maxDropRatio ||
      editSummary.changeRatio > meeting.settings.maxChangeRatio
    ) {
      // When the reconcile model looks suspicious, keep the baseline transcript
      // untouched and skip the deterministic repetition filter as well.
      return createResult({
        enabled: true,
        processedChunks: counters.processedChunks,
        totalChunks: chunkWindows.length,
        totalSegments: baselineSegments.length,
        candidateEdits: counters.candidateEdits,
        rejectedTrivialEdits: counters.rejectedTrivialEdits,
        acceptedEdits: acceptedEdits.size,
        replacedSegments: editSummary.replacedSegments,
        droppedSegments: editSummary.droppedSegments,
        fallbackApplied: true,
        fallbackReason: "guardrail_threshold",
      });
    }

    applyAcceptedEdits(baselineSegments, acceptedEdits);
    const repetitionFilteredSegments = applyRepeatedLowInformationFilter(
      baselineSegments,
      meeting.settings.repeatWindowSeconds,
    );

    return createResult({
      enabled: true,
      applied: true,
      processedChunks: counters.processedChunks,
      totalChunks: chunkWindows.length,
      totalSegments: baselineSegments.length,
      candidateEdits: counters.candidateEdits,
      rejectedTrivialEdits: counters.rejectedTrivialEdits,
      acceptedEdits: acceptedEdits.size,
      replacedSegments: editSummary.replacedSegments,
      droppedSegments: editSummary.droppedSegments + repetitionFilteredSegments,
      repetitionFilteredSegments,
    });
  } catch (error) {
    signal.throwIfAborted();
    console.error("Final transcription pass failed.", {
      meetingId: meeting.meetingId,
      error,
    });
    return createResult({
      enabled: true,
      totalSegments: baselineSegments.length,
      fallbackApplied: true,
      fallbackReason: "runtime_error",
    });
  }
}
