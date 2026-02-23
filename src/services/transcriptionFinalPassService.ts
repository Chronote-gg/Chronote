import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import ffmpeg from "fluent-ffmpeg";
import type { TranscriptionCreateParamsNonStreaming } from "openai/resources/audio";
import { z } from "zod";
import {
  MAX_SNIPPET_LENGTH,
  TRANSCRIPTION_FINAL_PASS_CHUNK_SECONDS,
  TRANSCRIPTION_FINAL_PASS_MAX_CHANGE_RATIO,
  TRANSCRIPTION_FINAL_PASS_MAX_DROP_RATIO,
  TRANSCRIPTION_FINAL_PASS_MAX_REQUEST_BYTES,
  TRANSCRIPTION_FINAL_PASS_MIN_CONFIDENCE,
  TRANSCRIPTION_FINAL_PASS_PREVIOUS_TAIL_CHARS,
  TRANSCRIPTION_FINAL_PASS_SEGMENT_BATCH_MAX_CHARS,
  TRANSCRIPTION_FINAL_PASS_TARGET_MAX_CHUNK_BYTES,
} from "../constants";
import type { AudioFileData } from "../types/audio";
import type { MeetingData } from "../types/meeting-data";
import { chat } from "./openaiChatService";
import { createOpenAIClient } from "./openaiClient";
import { getMeetingModelOverrides } from "./meetingModelOverrides";
import { getModelChoice } from "./modelFactory";
import {
  type FinalPassSegmentInput,
  getTranscriptionFinalPassPrompt,
  getTranscriptionPrompt,
} from "./transcriptionPromptService";
import { ensureMeetingTempDir } from "./tempFileService";

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

const ESTIMATED_MP3_BYTES_PER_SECOND = 16_000;
const MIN_CHUNK_SECONDS = 60;

type FinalPassDependencies = {
  ensureTempDir: (meeting: MeetingData) => Promise<string>;
  getAudioDurationSeconds: (
    audioFilePath: string,
  ) => Promise<number | undefined>;
  renderAudioChunk: (input: {
    inputPath: string;
    outputPath: string;
    startSeconds: number;
    durationSeconds: number;
  }) => Promise<void>;
  transcribeChunk: (input: {
    meeting: MeetingData;
    chunkFilePath: string;
    previousChunkTail: string;
    chunkIndex: number;
    chunkCount: number;
  }) => Promise<FinalPassChunkTranscription>;
  reconcileBatch: (input: {
    meeting: MeetingData;
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
};

type ChunkProcessingResult = {
  processed: boolean;
  candidateEdits: number;
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
  fallbackApplied: boolean;
  fallbackReason?: string;
};

const resolveAudioFileText = (fileData: AudioFileData): string =>
  fileData.coalescedTranscript ??
  fileData.slowTranscript ??
  fileData.transcript ??
  (fileData.fastTranscripts && fileData.fastTranscripts.length > 0
    ? fileData.fastTranscripts[fileData.fastTranscripts.length - 1].text
    : "");

const resolveSpeakerLabel = (meeting: MeetingData, userId: string): string => {
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

const buildBaselineSegments = (meeting: MeetingData): BaselineSegment[] => {
  const startedAtMs = meeting.startTime.getTime();
  const maxSnippetSeconds = MAX_SNIPPET_LENGTH / 1000;
  const orderedFiles = [...meeting.audioData.audioFiles].sort(
    (a, b) => a.timestamp - b.timestamp,
  );

  const segments = orderedFiles
    .map((fileData, index) => {
      const text = resolveAudioFileText(fileData).trim();
      if (!text) return undefined;
      return {
        segmentId: `seg-${index + 1}`,
        fileData,
        speaker: resolveSpeakerLabel(meeting, fileData.userId),
        startedAt: new Date(fileData.timestamp).toISOString(),
        offsetSeconds: Math.max(0, (fileData.timestamp - startedAtMs) / 1000),
        estimatedEndSeconds: 0,
        text,
      };
    })
    .filter((segment): segment is BaselineSegment => Boolean(segment));

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

const estimateChunkSeconds = () => {
  const byTargetSize = Math.floor(
    TRANSCRIPTION_FINAL_PASS_TARGET_MAX_CHUNK_BYTES /
      ESTIMATED_MP3_BYTES_PER_SECOND,
  );
  const byHardLimit = Math.floor(
    TRANSCRIPTION_FINAL_PASS_MAX_REQUEST_BYTES / ESTIMATED_MP3_BYTES_PER_SECOND,
  );
  return Math.max(
    MIN_CHUNK_SECONDS,
    Math.min(TRANSCRIPTION_FINAL_PASS_CHUNK_SECONDS, byTargetSize, byHardLimit),
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
}) =>
  await new Promise<void>((resolve, reject) => {
    ffmpeg(input.inputPath)
      .setStartTime(input.startSeconds)
      .setDuration(input.durationSeconds)
      .audioCodec("libmp3lame")
      .audioBitrate("128k")
      .audioChannels(2)
      .audioFrequency(48000)
      .toFormat("mp3")
      .on("end", () => {
        resolve();
      })
      .on("error", (error) => {
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

const batchSegments = (segments: BaselineSegment[]) => {
  const batches: BaselineSegment[][] = [];
  let currentBatch: BaselineSegment[] = [];
  let currentChars = 0;

  for (const segment of segments) {
    const nextChars = segmentPromptLength(segment);
    const exceedsLimit =
      currentBatch.length > 0 &&
      currentChars + nextChars >
        TRANSCRIPTION_FINAL_PASS_SEGMENT_BATCH_MAX_CHARS;

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
  fallbackApplied: false,
};

const createResult = (
  input: Partial<TranscriptionFinalPassResult> & { enabled: boolean },
): TranscriptionFinalPassResult => ({
  ...EMPTY_FINAL_PASS_RESULT,
  ...input,
  enabled: input.enabled,
});

const resetFinalPassTranscripts = (meeting: MeetingData) => {
  for (const fileData of meeting.audioData.audioFiles) {
    delete fileData.finalPassTranscript;
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
): boolean => {
  if (edit.confidence < TRANSCRIPTION_FINAL_PASS_MIN_CONFIDENCE) {
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
): number => {
  let candidateEdits = 0;
  for (const edit of edits) {
    candidateEdits += 1;
    const segment = getSegmentById(batch, edit.segmentId);
    if (!segment || !isEditUsable(edit, segment)) {
      continue;
    }
    updateAcceptedEdit(acceptedEdits, edit);
  }
  return candidateEdits;
};

const reconcileChunkBatches = async (input: {
  meeting: MeetingData;
  chunkTranscript: string;
  previousChunkTail: string;
  logprobSummary: string;
  chunk: ChunkWindow;
  chunkCount: number;
  chunkSegments: BaselineSegment[];
  acceptedEdits: Map<string, FinalPassEdit>;
  dependencies: FinalPassDependencies;
}): Promise<number> => {
  let candidateEdits = 0;
  const batches = batchSegments(input.chunkSegments);
  for (const batch of batches) {
    const edits = await input.dependencies.reconcileBatch({
      meeting: input.meeting,
      chunkTranscript: input.chunkTranscript,
      previousChunkTail: input.previousChunkTail,
      chunkLogprobSummary: input.logprobSummary,
      chunkIndex: input.chunk.index + 1,
      chunkCount: input.chunkCount,
      baselineSegments: batch,
    });
    candidateEdits += applyBatchEdits(batch, edits, input.acceptedEdits);
  }
  return candidateEdits;
};

const processChunk = async (input: {
  meeting: MeetingData;
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

  try {
    await input.dependencies.renderAudioChunk({
      inputPath: input.options.audioFilePath,
      outputPath: chunkFilePath,
      startSeconds: input.chunk.startSeconds,
      durationSeconds: input.chunk.endSeconds - input.chunk.startSeconds,
    });

    const chunkTranscription = await input.dependencies.transcribeChunk({
      meeting: input.meeting,
      chunkFilePath,
      previousChunkTail: input.previousChunkTail,
      chunkIndex: input.chunk.index + 1,
      chunkCount: input.chunkCount,
    });

    const chunkTranscript = chunkTranscription.text.trim();
    const nextTail = takeTail(
      chunkTranscript,
      TRANSCRIPTION_FINAL_PASS_PREVIOUS_TAIL_CHARS,
    );
    if (!chunkTranscript) {
      return { processed: true, candidateEdits: 0, nextTail };
    }

    const logprobSummary = summarizeLogprobMetrics(
      buildLogprobMetrics(chunkTranscription.logprobs),
    );
    const candidateEdits = await reconcileChunkBatches({
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

    return { processed: true, candidateEdits, nextTail };
  } catch (error) {
    console.error("Final transcription pass chunk failed.", {
      meetingId: input.meeting.meetingId,
      chunkIndex: input.chunk.index + 1,
      error,
    });
    return {
      processed: true,
      candidateEdits: 0,
      nextTail: input.previousChunkTail,
    };
  } finally {
    await input.dependencies.deleteTempFile(chunkFilePath);
  }
};

const processAllChunks = async (input: {
  meeting: MeetingData;
  options: { audioFilePath: string };
  dependencies: FinalPassDependencies;
  tempDir: string;
  chunkWindows: ChunkWindow[];
  baselineSegments: BaselineSegment[];
  acceptedEdits: Map<string, FinalPassEdit>;
}): Promise<FinalPassCounters> => {
  let processedChunks = 0;
  let candidateEdits = 0;
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
    previousChunkTail = result.nextTail;
  }

  return { processedChunks, candidateEdits };
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
      segment.fileData.finalPassTranscript = "";
      continue;
    }
    const replacement = (edit.text ?? "").trim();
    if (!replacement) {
      continue;
    }
    segment.fileData.finalPassTranscript = replacement;
  }
};

const defaultDependencies: FinalPassDependencies = {
  ensureTempDir: async (meeting) => await ensureMeetingTempDir(meeting),
  getAudioDurationSeconds,
  renderAudioChunk,
  transcribeChunk: async (input) => {
    const { prompt, langfusePrompt } = await getTranscriptionPrompt(
      input.meeting,
    );
    const promptValue = prompt.trim();
    const continuityTail = input.previousChunkTail.trim();
    const continuationPrompt = continuityTail
      ? `Previous chunk transcript tail (context only):\n${continuityTail}`
      : "";
    const combinedPrompt = [promptValue, continuationPrompt]
      .filter(Boolean)
      .join("\n\n")
      .trim();

    const modelChoice = getModelChoice(
      "transcription",
      getMeetingModelOverrides(input.meeting),
    );

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

    const request: TranscriptionCreateParamsNonStreaming<"json"> = {
      file: createReadStream(input.chunkFilePath),
      model: modelChoice.model,
      language: "en",
      temperature: 0,
      response_format: "json",
      include: ["logprobs"],
      ...(combinedPrompt ? { prompt: combinedPrompt } : {}),
    };

    const result = await openAIClient.audio.transcriptions.create(request);
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

    const { messages, langfusePrompt } = await getTranscriptionFinalPassPrompt(
      input.meeting,
      {
        chunkIndex: input.chunkIndex,
        chunkCount: input.chunkCount,
        chunkTranscript: input.chunkTranscript,
        previousChunkTail: input.previousChunkTail,
        chunkLogprobSummary: input.chunkLogprobSummary,
        baselineSegments: promptSegments,
      },
    );

    const modelChoice = getModelChoice(
      "transcriptionCoalesce",
      getMeetingModelOverrides(input.meeting),
    );

    const raw = await chat(
      input.meeting,
      {
        messages: [...messages],
      },
      {
        model: modelChoice.model,
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

export async function runTranscriptionFinalPass(
  meeting: MeetingData,
  options: {
    audioFilePath: string;
  },
  dependencyOverrides: Partial<FinalPassDependencies> = {},
): Promise<TranscriptionFinalPassResult> {
  const enabled = meeting.runtimeConfig?.transcription.finalPassEnabled ?? true;
  if (!enabled) {
    return createResult({ enabled: false });
  }

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
    const chunkSeconds = estimateChunkSeconds();
    const fallbackDurationSeconds = meeting.endTime
      ? Math.max(
          1,
          (meeting.endTime.getTime() - meeting.startTime.getTime()) / 1000,
        )
      : baselineSegments[baselineSegments.length - 1].offsetSeconds + 1;
    const detectedDurationSeconds =
      (await dependencies.getAudioDurationSeconds(options.audioFilePath)) ??
      fallbackDurationSeconds;
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

    if (acceptedEdits.size === 0) {
      return createResult({
        enabled: true,
        processedChunks: counters.processedChunks,
        totalChunks: chunkWindows.length,
        totalSegments: baselineSegments.length,
        candidateEdits: counters.candidateEdits,
      });
    }

    const editSummary = summarizeAcceptedEdits(
      acceptedEdits,
      baselineSegments.length,
    );

    if (
      editSummary.dropRatio > TRANSCRIPTION_FINAL_PASS_MAX_DROP_RATIO ||
      editSummary.changeRatio > TRANSCRIPTION_FINAL_PASS_MAX_CHANGE_RATIO
    ) {
      return createResult({
        enabled: true,
        processedChunks: counters.processedChunks,
        totalChunks: chunkWindows.length,
        totalSegments: baselineSegments.length,
        candidateEdits: counters.candidateEdits,
        acceptedEdits: acceptedEdits.size,
        replacedSegments: editSummary.replacedSegments,
        droppedSegments: editSummary.droppedSegments,
        fallbackApplied: true,
        fallbackReason: "guardrail_threshold",
      });
    }

    applyAcceptedEdits(baselineSegments, acceptedEdits);

    return createResult({
      enabled: true,
      applied: true,
      processedChunks: counters.processedChunks,
      totalChunks: chunkWindows.length,
      totalSegments: baselineSegments.length,
      candidateEdits: counters.candidateEdits,
      acceptedEdits: acceptedEdits.size,
      replacedSegments: editSummary.replacedSegments,
      droppedSegments: editSummary.droppedSegments,
    });
  } catch (error) {
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
