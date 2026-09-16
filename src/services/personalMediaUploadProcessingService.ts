import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import ffmpeg from "fluent-ffmpeg";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { TranscriptionCreateParamsNonStreaming } from "openai/resources/audio";
import type {
  MeetingHistory,
  PersonalMediaUploadJobRecord,
  PersonalRecordingSourceRecord,
  PersonalRecordingSegmentRecord,
} from "../types/db";
import type { Participant } from "../types/participants";
import type { TranscriptSegment } from "../types/transcript";
import { MEETING_STATUS } from "../types/meetingLifecycle";
import type { MeetingProcessingOutcome } from "../types/meetingProcessing";
import { classifyTranscription } from "../utils/meetingProcessing";
import {
  PERSONAL_MEDIA_UPLOAD_MAX_PROCESSING_ATTEMPTS,
  TRANSCRIPTION_FAILURE_PLACEHOLDER,
  TRANSCRIPTION_FINAL_PASS_CHUNK_SECONDS,
  TRANSCRIPTION_FINAL_PASS_MAX_REQUEST_BYTES,
} from "../constants";
import {
  getMeetingHistoryService,
  writeMeetingHistoryService,
} from "./meetingHistoryService";
import {
  downloadObjectToFile,
  fetchJsonFromS3,
  uploadObjectToS3,
} from "./storageService";
import { ensureTempBaseDir } from "./tempFileService";
import { createOpenAIClient } from "./openaiClient";
import { getModelChoice } from "./modelFactory";
import { resolveChatParamsForRole } from "./openaiModelParams";
import { getLangfuseChatPrompt } from "./langfusePromptService";
import { NO_ROLES_AVAILABLE_TEXT } from "./notesPromptService";
import { stripUnknownMentions } from "../utils/mentionSanitizer";
import { config } from "./configService";
import {
  generateMeetingSummaries,
  type MeetingSummaries,
} from "./meetingSummaryService";
import { resolveMeetingNameFromSummary } from "./meetingNameService";
import { maybeAutoExportCompletedMeeting } from "./notionAutomationService";
import {
  listPersonalRecordingUploadSegments,
  markPersonalRecordingUploadSegmentFailed,
  markPersonalRecordingUploadSegmentProcessed,
  markPersonalRecordingUploadSegmentProcessing,
  markPersonalRecordingUploadSegmentsFailed,
  updateClaimedPersonalMediaUploadJobProgress,
  updateClaimedPersonalMediaUploadJobRecord,
  updatePersonalMediaUploadJobRecord,
} from "./personalMediaUploadService";
import { buildPersonalMeetingGuildId } from "../utils/meetingOwnership";
import {
  recordPersonalUploadTerminal,
  withPersonalUploadProcessingTrace,
  type PersonalUploadTerminalFacts,
} from "../observability/personalUploadTrace";

const PERSONAL_UPLOAD_CHANNEL_ID = "personal";
const PERSONAL_UPLOAD_CHANNEL_NAME = "Uploaded media";
const PERSONAL_UPLOAD_SERVER_NAME = "Personal";

type PersonalUploadMeetingIdentity = ReturnType<typeof buildJobMeetingKey>;

type PersonalUploadProcessingResult = {
  audioS3Key?: string;
  durationSeconds: number;
  failedChunks: number;
  meetingName?: string;
  notes: string;
  processing: MeetingProcessingOutcome;
  processedSegmentCount?: number;
  segmentCount?: number;
  summaries: MeetingSummaries;
  transcriptS3Key?: string;
  uploadedSegmentCount?: number;
};

type PersonalUploadTranscriptArtifact = {
  segments: TranscriptSegment[];
  text: string;
};

type ProcessedPersonalRecordingSource = {
  audioPath: string;
  durationSeconds: number;
  failedChunks: number;
  segments: TranscriptSegment[];
};

type PersonalTranscriptionResult = {
  text: string;
  failedChunks: number;
};

class PersonalUploadProcessingError extends Error {
  constructor(
    cause: unknown,
    readonly processing: MeetingProcessingOutcome,
    readonly failedChunks = 0,
  ) {
    super(cause instanceof Error ? cause.message : "Processing failed.", {
      cause,
    });
  }
}

const normalizeTranscriptionText = (text: string) => {
  const trimmed = text.trim();
  return trimmed === TRANSCRIPTION_FAILURE_PLACEHOLDER ? "" : trimmed;
};

const buildProviderFailureObservation = (error: unknown) => {
  if (!error || typeof error !== "object") return {};
  const providerError = error as {
    name?: unknown;
    code?: unknown;
    status?: unknown;
  };
  return {
    errorClass:
      typeof providerError.name === "string"
        ? providerError.name.slice(0, 80)
        : undefined,
    code:
      typeof providerError.code === "number" ? providerError.code : undefined,
    status:
      typeof providerError.status === "number"
        ? providerError.status
        : undefined,
  };
};

type PersonalRecordingSegmentTranscriptArtifact = {
  generatedAt: string;
  uploadId: string;
  segmentKey: string;
  sourceId: string;
  sequence: number;
  segment: TranscriptSegment;
  text: string;
};

const buildJobMeetingKey = (job: PersonalMediaUploadJobRecord) => {
  const timestamp = job.createdAt;
  return {
    guildId: buildPersonalMeetingGuildId(job.ownerUserId),
    channelIdTimestamp: `${PERSONAL_UPLOAD_CHANNEL_ID}#${timestamp}`,
    meetingId: job.meetingId ?? job.uploadId,
    timestamp,
  };
};

const buildPersonalUploadParticipants = (
  job: PersonalMediaUploadJobRecord,
): Participant[] => [
  {
    id: job.ownerUserId,
    username: "Me",
    displayName: "Me",
  },
];

const runFfmpeg = (inputPath: string, outputPath: string) =>
  new Promise<void>((resolve, reject) => {
    ffmpeg(inputPath)
      .noVideo()
      .audioCodec("libmp3lame")
      .audioBitrate("64k")
      .audioChannels(1)
      .audioFrequency(16_000)
      .output(outputPath)
      .on("end", () => resolve())
      .on("error", reject)
      .run();
  });

const mixAudioFiles = (inputPaths: string[], outputPath: string) =>
  new Promise<void>((resolve, reject) => {
    if (inputPaths.length === 0) {
      reject(new Error("No audio files were available to mix."));
      return;
    }
    if (inputPaths.length === 1) {
      fs.copyFile(inputPaths[0], outputPath).then(resolve, reject);
      return;
    }

    let command = ffmpeg();
    for (const inputPath of inputPaths) command = command.input(inputPath);
    command
      .complexFilter([
        `amix=inputs=${inputPaths.length}:duration=longest:dropout_transition=0`,
      ])
      .audioCodec("libmp3lame")
      .audioBitrate("64k")
      .audioChannels(1)
      .audioFrequency(16_000)
      .output(outputPath)
      .on("end", () => resolve())
      .on("error", reject)
      .run();
  });

const probeMediaDurationSeconds = (filePath: string) =>
  new Promise<number>((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (error, metadata) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(Math.max(0, metadata.format.duration ?? 0));
    });
  });

const splitAudioFile = async (inputPath: string, outputDir: string) => {
  const pattern = path.join(outputDir, "chunk-%03d.mp3");
  await new Promise<void>((resolve, reject) => {
    ffmpeg(inputPath)
      .outputOptions([
        "-f",
        "segment",
        "-segment_time",
        String(TRANSCRIPTION_FINAL_PASS_CHUNK_SECONDS),
        "-reset_timestamps",
        "1",
      ])
      .output(pattern)
      .on("end", () => resolve())
      .on("error", reject)
      .run();
  });
  const chunkNames = (await fs.readdir(outputDir))
    .filter((name) => /^chunk-\d+\.mp3$/.test(name))
    .sort();
  return chunkNames.map((name) => path.join(outputDir, name));
};

const resolveTranscriptionInputs = async (
  audioPath: string,
  workDir: string,
) => {
  const audioStat = await fs.stat(audioPath);
  if (audioStat.size <= TRANSCRIPTION_FINAL_PASS_MAX_REQUEST_BYTES) {
    return [audioPath];
  }
  const chunkDir = path.join(workDir, "chunks");
  await fs.mkdir(chunkDir, { recursive: true });
  const chunks = await splitAudioFile(audioPath, chunkDir);
  if (chunks.length === 0) {
    throw new Error("Normalized audio could not be split for transcription.");
  }
  return chunks;
};

const transcribeAudioFile = async (filePath: string) => {
  const modelChoice = getModelChoice("transcription");
  const openAIClient = createOpenAIClient({
    traceName: "personal-media-upload-transcription",
    generationName: "personal-media-upload-transcription",
    tags: ["feature:personal_upload", "feature:transcription"],
  });
  const request: TranscriptionCreateParamsNonStreaming<"json"> = {
    file: createReadStream(filePath),
    model: modelChoice.model,
    language: "en",
    temperature: 0,
    response_format: "json",
  };
  const transcription = await openAIClient.audio.transcriptions.create(request);
  return transcription.text ?? "";
};

const transcribeAudioFiles = async (
  filePaths: string[],
  acceptPartial: boolean,
): Promise<PersonalTranscriptionResult> => {
  const chunks: string[] = [];
  let failedChunks = 0;
  for (const filePath of filePaths) {
    let transcript: string;
    try {
      transcript = await transcribeAudioFile(filePath);
    } catch (error) {
      if (!acceptPartial) throw error;
      failedChunks += 1;
      console.error(
        "Personal upload transcription provider failed",
        buildProviderFailureObservation(error),
      );
      continue;
    }
    const usableText = normalizeTranscriptionText(transcript);
    if (usableText) chunks.push(usableText);
  }
  return { text: chunks.join("\n\n"), failedChunks };
};

const acceptsPartialTranscription = (job: PersonalMediaUploadJobRecord) =>
  (job.attempts ?? 1) >= PERSONAL_MEDIA_UPLOAD_MAX_PROCESSING_ATTEMPTS;

const formatTranscriptLine = (segment: TranscriptSegment) =>
  `[${segment.displayName ?? segment.username ?? segment.userId} @ ${new Date(
    segment.startedAt,
  ).toLocaleString()}]: ${segment.text ?? ""}`;

const buildTranscriptArtifactFromSegments = (
  segments: TranscriptSegment[],
): PersonalUploadTranscriptArtifact => ({
  segments,
  text: segments
    .filter((segment) => segment.text?.trim())
    .map(formatTranscriptLine)
    .join("\n"),
});

const generateNotesForTranscript = async (
  job: PersonalMediaUploadJobRecord,
  transcript: string,
) => {
  if (!transcript.trim()) return "";
  const notes = await generatePersonalUploadNotes({
    transcript,
    title: job.title,
  });
  if (!notes.trim())
    throw new Error("Notes generation returned no usable content.");
  return notes;
};

const generateSummariesForNotes = async (
  job: PersonalMediaUploadJobRecord,
  notes: string,
) => {
  if (!notes) return {};
  return generateMeetingSummaries({
    guildId: job.meetingGuildId,
    notes,
    serverName: PERSONAL_UPLOAD_SERVER_NAME,
    channelName: PERSONAL_UPLOAD_CHANNEL_NAME,
    tags: job.tags,
    now: new Date(job.createdAt),
    meetingId: job.meetingId,
  });
};

const getSummaryOutcome = (
  notes: string,
  summaries: MeetingSummaries,
): MeetingProcessingOutcome["summary"] => {
  if (!notes) return "skipped";
  return summaries.summarySentence?.trim() && summaries.summaryLabel?.trim()
    ? "generated"
    : "failed";
};

const resolvePersonalUploadMeetingName = async (
  job: PersonalMediaUploadJobRecord,
  summaries: MeetingSummaries,
) =>
  job.title ||
  (await resolveMeetingNameFromSummary({
    guildId: job.meetingGuildId ?? buildPersonalMeetingGuildId(job.ownerUserId),
    meetingId: job.meetingId ?? job.uploadId,
    summaryLabel: summaries.summaryLabel,
  }));

const buildTranscriptArtifact = (
  job: PersonalMediaUploadJobRecord,
  transcript: PersonalUploadTranscriptArtifact,
) =>
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      uploadId: job.uploadId,
      mediaKind: job.mediaKind,
      segments: transcript.segments,
      text: transcript.text,
    },
    null,
    2,
  );

const uploadPersonalUploadArtifacts = async (
  job: PersonalMediaUploadJobRecord,
  audioPath: string,
  transcript: PersonalUploadTranscriptArtifact,
) => {
  const folder = `personal/${job.ownerUserId}/${job.uploadId}/`;
  const audioS3Key = await uploadObjectToS3(
    `${folder}audio.mp3`,
    await fs.readFile(audioPath),
    "audio/mpeg",
  );
  const transcriptS3Key = await uploadObjectToS3(
    `${folder}transcript.json`,
    buildTranscriptArtifact(job, transcript),
    "application/json",
  );
  return { audioS3Key, transcriptS3Key };
};

const buildRecordingSegmentTranscriptKey = (
  job: PersonalMediaUploadJobRecord,
  segment: PersonalRecordingSegmentRecord,
) =>
  `personal/${job.ownerUserId}/${job.uploadId}/segments/${segment.sourceId}-${String(
    segment.sequence,
  ).padStart(6, "0")}.transcript.json`;

const buildRecordingSegmentTranscriptArtifact = (
  job: PersonalMediaUploadJobRecord,
  segment: PersonalRecordingSegmentRecord,
  transcriptSegment: TranscriptSegment,
): PersonalRecordingSegmentTranscriptArtifact => ({
  generatedAt: new Date().toISOString(),
  uploadId: job.uploadId,
  segmentKey: segment.segmentKey,
  sourceId: segment.sourceId,
  sequence: segment.sequence,
  segment: transcriptSegment,
  text: transcriptSegment.text ?? "",
});

const loadProcessedRecordingSegmentTranscript = async (
  segment: PersonalRecordingSegmentRecord,
) => {
  if (segment.status !== "processed" || !segment.transcriptS3Key) {
    return undefined;
  }
  const artifact =
    await fetchJsonFromS3<PersonalRecordingSegmentTranscriptArtifact>(
      segment.transcriptS3Key,
    );
  return artifact?.segment
    ? {
        ...artifact.segment,
        text: normalizeTranscriptionText(artifact.segment.text ?? ""),
      }
    : undefined;
};

const sortTranscriptSegments = (segments: TranscriptSegment[]) =>
  [...segments].sort((left, right) => {
    const time = left.startedAt.localeCompare(right.startedAt);
    if (time !== 0) return time;
    return left.userId.localeCompare(right.userId);
  });

const buildSingleSourceTranscriptArtifact = (
  job: PersonalMediaUploadJobRecord,
  transcript: string,
) =>
  buildTranscriptArtifactFromSegments([
    {
      userId: job.ownerUserId,
      username: "Uploader",
      displayName: "Uploader",
      startedAt: job.createdAt,
      text: transcript,
      source: "personal_upload",
    },
  ]);

const downloadAndNormalizeMedia = async (
  job: PersonalMediaUploadJobRecord,
  workDir: string,
) => {
  const sourcePath = path.join(workDir, "source");
  const audioPath = path.join(workDir, "audio.mp3");
  const downloaded = await downloadObjectToFile(job.sourceS3Key, sourcePath);
  if (!downloaded) throw new Error("Uploaded media could not be downloaded.");
  const durationSeconds = Math.round(
    await probeMediaDurationSeconds(sourcePath),
  );
  await runFfmpeg(sourcePath, audioPath);
  return { audioPath, durationSeconds };
};

const downloadAndNormalizeRecordingSource = async (
  source: PersonalRecordingSourceRecord,
  workDir: string,
) => {
  if (!source.sourceS3Key) {
    throw new Error("Desktop recording source is missing an S3 object key.");
  }
  const sourceDir = path.join(workDir, source.sourceId);
  await fs.mkdir(sourceDir, { recursive: true });
  const sourcePath = path.join(sourceDir, "source");
  const audioPath = path.join(sourceDir, "audio.mp3");
  const downloaded = await downloadObjectToFile(source.sourceS3Key, sourcePath);
  if (!downloaded) throw new Error("Uploaded media could not be downloaded.");
  const durationSeconds = Math.round(
    await probeMediaDurationSeconds(sourcePath),
  );
  await runFfmpeg(sourcePath, audioPath);
  return { audioPath, durationSeconds };
};

const quoteFfmpegConcatPath = (filePath: string) =>
  filePath.replace(/'/g, "'\\''");

const concatAudioFiles = async (inputPaths: string[], outputPath: string) => {
  if (inputPaths.length === 0) {
    throw new Error("No recording segments were available to assemble.");
  }
  if (inputPaths.length === 1) {
    await fs.copyFile(inputPaths[0], outputPath);
    return;
  }
  const listPath = `${outputPath}.txt`;
  await fs.writeFile(
    listPath,
    inputPaths
      .map((inputPath) => `file '${quoteFfmpegConcatPath(inputPath)}'`)
      .join("\n"),
  );
  await new Promise<void>((resolve, reject) => {
    ffmpeg()
      .input(listPath)
      .inputOptions(["-f", "concat", "-safe", "0"])
      .outputOptions(["-c", "copy"])
      .output(outputPath)
      .on("end", () => resolve())
      .on("error", reject)
      .run();
  });
};

const downloadAndNormalizeRecordingSegment = async (
  segment: PersonalRecordingSegmentRecord,
  sourceDir: string,
) => {
  const segmentDir = path.join(
    sourceDir,
    `segment-${String(segment.sequence).padStart(6, "0")}`,
  );
  await fs.mkdir(segmentDir, { recursive: true });
  const sourcePath = path.join(segmentDir, "source");
  const audioPath = path.join(segmentDir, "audio.mp3");
  const downloaded = await downloadObjectToFile(
    segment.sourceS3Key,
    sourcePath,
  );
  if (!downloaded) {
    throw new Error("Uploaded recording segment could not be downloaded.");
  }
  await runFfmpeg(sourcePath, audioPath);
  return {
    audioPath,
    durationSeconds: Math.round(segment.durationMillis / 1000),
  };
};

const buildRecordingSegment = (input: {
  job: PersonalMediaUploadJobRecord;
  source: PersonalRecordingSourceRecord;
  transcript: string;
  startedAt?: string;
}): TranscriptSegment => ({
  userId:
    input.source.kind === "owner_mic"
      ? input.job.ownerUserId
      : `system:${input.job.uploadId}`,
  username: input.source.label,
  displayName: input.source.label,
  startedAt: input.startedAt ?? input.job.createdAt,
  text: input.transcript,
  source: "desktop_recording",
});

const summarizeRecordingSegmentProgress = (
  segments: PersonalRecordingSegmentRecord[],
) => ({
  segmentCount: segments.length,
  uploadedSegmentCount: segments.filter((segment) =>
    ["uploaded", "submitted", "processing", "processed", "failed"].includes(
      segment.status,
    ),
  ).length,
  processedSegmentCount: segments.filter(
    (segment) => segment.status === "processed",
  ).length,
});

const updatePersonalRecordingProcessingProgress = async (
  job: PersonalMediaUploadJobRecord,
  instanceId: string,
) => {
  const segments = await listPersonalRecordingUploadSegments(job.uploadId);
  Object.assign(job, summarizeRecordingSegmentProgress(segments));
  await updateClaimedPersonalMediaUploadJobProgress({
    uploadId: job.uploadId,
    instanceId,
    ...summarizeRecordingSegmentProgress(segments),
    updatedAt: new Date().toISOString(),
  });
  return segments;
};

const processPersonalRecordingSource = async (
  job: PersonalMediaUploadJobRecord,
  source: PersonalRecordingSourceRecord,
  workDir: string,
): Promise<ProcessedPersonalRecordingSource> => {
  const { audioPath, durationSeconds } =
    await downloadAndNormalizeRecordingSource(source, workDir);
  const transcriptionInputs = await resolveTranscriptionInputs(
    audioPath,
    path.dirname(audioPath),
  );
  const transcription = await transcribeAudioFiles(
    transcriptionInputs,
    acceptsPartialTranscription(job),
  );
  return {
    audioPath,
    durationSeconds,
    failedChunks: transcription.failedChunks,
    segments: [
      buildRecordingSegment({ job, source, transcript: transcription.text }),
    ],
  };
};

const processPersonalRecordingSegment = async (
  job: PersonalMediaUploadJobRecord,
  source: PersonalRecordingSourceRecord,
  segment: PersonalRecordingSegmentRecord,
  sourceDir: string,
) => {
  const { audioPath, durationSeconds } =
    await downloadAndNormalizeRecordingSegment(segment, sourceDir);
  const cachedTranscript =
    await loadProcessedRecordingSegmentTranscript(segment);
  if (cachedTranscript) {
    return {
      audioPath,
      durationSeconds,
      failedChunks: 0,
      segment: cachedTranscript,
    };
  }

  let processingSegment = segment;
  try {
    processingSegment =
      await markPersonalRecordingUploadSegmentProcessing(segment);
    const transcriptionInputs = await resolveTranscriptionInputs(
      audioPath,
      path.dirname(audioPath),
    );
    const transcription = await transcribeAudioFiles(
      transcriptionInputs,
      acceptsPartialTranscription(job),
    );
    const transcriptSegment = buildRecordingSegment({
      job,
      source,
      transcript: transcription.text,
      startedAt: segment.startedAt,
    });
    if (transcription.failedChunks > 0) {
      await markPersonalRecordingUploadSegmentFailed(
        processingSegment,
        new Error("One or more transcription chunks failed."),
      );
      return {
        audioPath,
        durationSeconds,
        failedChunks: transcription.failedChunks,
        segment: transcriptSegment,
      };
    }
    const transcriptArtifact = buildRecordingSegmentTranscriptArtifact(
      job,
      segment,
      transcriptSegment,
    );
    const transcriptS3Key = await uploadObjectToS3(
      buildRecordingSegmentTranscriptKey(job, segment),
      JSON.stringify(transcriptArtifact, null, 2),
      "application/json",
    );
    await markPersonalRecordingUploadSegmentProcessed(processingSegment, {
      transcriptS3Key,
    });
    return {
      audioPath,
      durationSeconds,
      failedChunks: 0,
      segment: transcriptSegment,
    };
  } catch (error) {
    await markPersonalRecordingUploadSegmentFailed(processingSegment, error);
    throw error;
  }
};

const processPersonalRecordingSegmentSource = async (
  job: PersonalMediaUploadJobRecord,
  source: PersonalRecordingSourceRecord,
  segments: PersonalRecordingSegmentRecord[],
  workDir: string,
  instanceId: string,
): Promise<ProcessedPersonalRecordingSource> => {
  const sourceDir = path.join(workDir, source.sourceId);
  await fs.mkdir(sourceDir, { recursive: true });
  const processedSegments: Array<{
    audioPath: string;
    durationSeconds: number;
    failedChunks: number;
    segment: TranscriptSegment;
  }> = [];
  for (const segment of segments) {
    processedSegments.push(
      await processPersonalRecordingSegment(job, source, segment, sourceDir),
    );
    await updatePersonalRecordingProcessingProgress(job, instanceId);
  }
  const audioPath = path.join(sourceDir, "audio.mp3");
  await concatAudioFiles(
    processedSegments.map((segment) => segment.audioPath),
    audioPath,
  );
  return {
    audioPath,
    durationSeconds: processedSegments.reduce(
      (sum, segment) => sum + segment.durationSeconds,
      0,
    ),
    failedChunks: processedSegments.reduce(
      (sum, segment) => sum + segment.failedChunks,
      0,
    ),
    segments: processedSegments.map((segment) => segment.segment),
  };
};

const finalizePersonalUploadContent = async (
  job: PersonalMediaUploadJobRecord,
  audioPath: string,
  transcriptArtifact: PersonalUploadTranscriptArtifact,
  transcription: MeetingProcessingOutcome["transcription"],
  failedChunks: number,
  includeSegmentProgress: boolean,
): Promise<Omit<PersonalUploadProcessingResult, "durationSeconds">> => {
  const processing: MeetingProcessingOutcome = {
    transcription,
    notes: "failed",
    summary: "skipped",
  };
  try {
    const notes = await generateNotesForTranscript(
      job,
      transcriptArtifact.text,
    );
    processing.notes = notes ? "generated" : "skipped";
    processing.summary = notes ? "failed" : "skipped";
    const summaries = await generateSummariesForNotes(job, notes);
    processing.summary = getSummaryOutcome(notes, summaries);
    const meetingName = await resolvePersonalUploadMeetingName(job, summaries);
    const artifacts = await uploadPersonalUploadArtifacts(
      job,
      audioPath,
      transcriptArtifact,
    );
    const progress = includeSegmentProgress
      ? summarizeRecordingSegmentProgress(
          await listPersonalRecordingUploadSegments(job.uploadId),
        )
      : {};
    return {
      ...artifacts,
      ...progress,
      failedChunks,
      meetingName,
      notes,
      processing,
      summaries,
    };
  } catch (error) {
    throw new PersonalUploadProcessingError(error, processing, failedChunks);
  }
};

const processPersonalRecordingContent = async (
  job: PersonalMediaUploadJobRecord,
  workDir: string,
  instanceId: string,
): Promise<PersonalUploadProcessingResult> => {
  const sources = job.sourceManifest ?? [];
  if (sources.length === 0) {
    throw new Error("Desktop recording upload has no source manifest.");
  }

  const processedSources: ProcessedPersonalRecordingSource[] = [];
  const segments = await listPersonalRecordingUploadSegments(job.uploadId);
  Object.assign(job, summarizeRecordingSegmentProgress(segments));
  const submittedSegments = segments.filter((segment) =>
    ["submitted", "processing", "processed", "failed"].includes(segment.status),
  );
  for (const source of sources) {
    const sourceSegments = submittedSegments
      .filter((segment) => segment.sourceId === source.sourceId)
      .sort((left, right) => left.sequence - right.sequence);
    if (sourceSegments.length === 0 && !source.sourceS3Key) {
      continue;
    }
    processedSources.push(
      sourceSegments.length > 0
        ? await processPersonalRecordingSegmentSource(
            job,
            source,
            sourceSegments,
            workDir,
            instanceId,
          )
        : await processPersonalRecordingSource(job, source, workDir),
    );
  }
  if (processedSources.length === 0) {
    throw new Error("No recording segments were available to assemble.");
  }

  const audioPath = path.join(workDir, "audio.mp3");
  await mixAudioFiles(
    processedSources.map((source) => source.audioPath),
    audioPath,
  );
  const transcriptArtifact = buildTranscriptArtifactFromSegments(
    sortTranscriptSegments(
      processedSources.flatMap((source) => source.segments),
    ),
  );
  const failedChunks = processedSources.reduce(
    (sum, source) => sum + source.failedChunks,
    0,
  );
  const transcription = classifyTranscription({
    usableSegments: transcriptArtifact.segments.filter((segment) =>
      Boolean(segment.text?.trim()),
    ).length,
    failedSegments: failedChunks,
    captureIncomplete: false,
  });
  if (transcription === "failed") {
    throw new PersonalUploadProcessingError(
      new Error("All transcription attempts failed."),
      { transcription: "failed", notes: "skipped", summary: "skipped" },
      failedChunks,
    );
  }
  return {
    ...(await finalizePersonalUploadContent(
      job,
      audioPath,
      transcriptArtifact,
      transcription,
      failedChunks,
      true,
    )),
    durationSeconds: Math.max(
      0,
      ...processedSources.map((source) => source.durationSeconds),
    ),
  };
};

const processPersonalMediaContent = async (
  job: PersonalMediaUploadJobRecord,
  workDir: string,
  instanceId: string,
): Promise<PersonalUploadProcessingResult> => {
  if (job.uploadOrigin === "desktop_recording" || job.sourceManifest?.length) {
    return processPersonalRecordingContent(job, workDir, instanceId);
  }

  const { audioPath, durationSeconds } = await downloadAndNormalizeMedia(
    job,
    workDir,
  );
  const transcriptionInputs = await resolveTranscriptionInputs(
    audioPath,
    workDir,
  );
  const transcriptionResult = await transcribeAudioFiles(
    transcriptionInputs,
    acceptsPartialTranscription(job),
  );
  const transcription = classifyTranscription({
    usableSegments: transcriptionResult.text.trim() ? 1 : 0,
    failedSegments: transcriptionResult.failedChunks,
    captureIncomplete: false,
  });
  if (transcription === "failed") {
    throw new PersonalUploadProcessingError(
      new Error("All transcription attempts failed."),
      { transcription: "failed", notes: "skipped", summary: "skipped" },
      transcriptionResult.failedChunks,
    );
  }
  const transcriptArtifact = buildSingleSourceTranscriptArtifact(
    job,
    transcriptionResult.text,
  );
  return {
    ...(await finalizePersonalUploadContent(
      job,
      audioPath,
      transcriptArtifact,
      transcription,
      transcriptionResult.failedChunks,
      false,
    )),
    durationSeconds,
  };
};

const generatePersonalUploadNotes = async (input: {
  transcript: string;
  title?: string;
}) => {
  const { messages, langfusePrompt } = await getLangfuseChatPrompt({
    name: config.langfuse.notesPromptName,
    variables: {
      formattedContext: input.title
        ? `User supplied title: ${input.title}`
        : "No extra context supplied.",
      botDisplayName: "Chronote",
      chatContextInstruction:
        "No participant chat was captured; rely on transcript and provided context.",
      chatContextBlock: "",
      participantRoster:
        "Uploaded personal media. Speaker identities may be unknown.",
      serverName: PERSONAL_UPLOAD_SERVER_NAME,
      serverDescription: "Personal Chronote upload.",
      voiceChannelName: PERSONAL_UPLOAD_CHANNEL_NAME,
      attendees: "Uploader",
      roles: NO_ROLES_AVAILABLE_TEXT,
      events: "",
      channelNames: PERSONAL_UPLOAD_CHANNEL_NAME,
      longStoryTargetChars: config.notes.longStoryTargetChars,
      transcript: input.transcript,
    },
  });
  const modelChoice = getModelChoice("notes");
  const chatParams = resolveChatParamsForRole({
    role: "notes",
    model: modelChoice.model,
  });
  const openAIClient = createOpenAIClient({
    traceName: "personal-media-upload-notes",
    generationName: "personal-media-upload-notes",
    tags: ["feature:personal_upload", "feature:notes"],
    langfusePrompt,
  });
  const completion = await openAIClient.chat.completions.create({
    model: modelChoice.model,
    messages: messages as ChatCompletionMessageParam[],
    ...chatParams,
  });
  // This prompt supplies no mention strings at all, so every allowlist is
  // empty: any mention in the output was invented, including one that happens
  // to match the uploader.
  return stripUnknownMentions(
    completion.choices[0]?.message?.content?.trim() ?? "",
    { userIds: [], roleIds: [] },
  );
};

const writeProcessingMeeting = async (job: PersonalMediaUploadJobRecord) => {
  const identity = buildJobMeetingKey(job);
  await writeMeetingHistoryService({
    guildId: identity.guildId,
    channelId_timestamp: identity.channelIdTimestamp,
    meetingId: identity.meetingId,
    channelId: PERSONAL_UPLOAD_CHANNEL_ID,
    timestamp: identity.timestamp,
    tags: job.tags,
    participants: buildPersonalUploadParticipants(job),
    duration: job.durationSeconds ?? 0,
    transcribeMeeting: true,
    generateNotes: true,
    ownershipScope: "personal",
    ownerUserId: job.ownerUserId,
    meetingCreatorId: job.ownerUserId,
    status: MEETING_STATUS.PROCESSING,
    meetingName: job.title,
  });
  return identity;
};

export async function createPersonalMediaProcessingMeeting(
  job: PersonalMediaUploadJobRecord,
  instanceId?: string,
) {
  const identity = await writeProcessingMeeting(job);
  const next = {
    ...job,
    meetingGuildId: identity.guildId,
    meetingId: identity.meetingId,
    channelId_timestamp: identity.channelIdTimestamp,
    updatedAt: new Date().toISOString(),
  };
  if (instanceId) {
    await updateClaimedPersonalMediaUploadJobRecord(next, instanceId);
  } else {
    await updatePersonalMediaUploadJobRecord(next);
  }
  return next;
}

const buildNotesHistory = (
  notes: string,
  ownerUserId: string,
  completedAt: string,
) => {
  if (!notes) return undefined;

  return [
    {
      version: 1,
      notes,
      editedBy: ownerUserId,
      editedAt: completedAt,
    },
  ];
};

const buildCompletedMeetingHistory = (
  job: PersonalMediaUploadJobRecord,
  identity: PersonalUploadMeetingIdentity,
  result: PersonalUploadProcessingResult,
  completedAt: string,
): MeetingHistory => ({
  guildId: identity.guildId,
  channelId_timestamp: identity.channelIdTimestamp,
  meetingId: identity.meetingId,
  channelId: PERSONAL_UPLOAD_CHANNEL_ID,
  timestamp: identity.timestamp,
  tags: job.tags,
  notes: result.notes,
  meetingName: result.meetingName,
  summarySentence: result.summaries.summarySentence,
  summaryLabel: result.summaries.summaryLabel,
  participants: buildPersonalUploadParticipants(job),
  duration: result.durationSeconds,
  transcribeMeeting: true,
  generateNotes: true,
  ownershipScope: "personal",
  ownerUserId: job.ownerUserId,
  meetingCreatorId: job.ownerUserId,
  status: MEETING_STATUS.COMPLETE,
  notesVersion: result.notes ? 1 : undefined,
  notesLastEditedBy: result.notes ? job.ownerUserId : undefined,
  notesLastEditedAt: result.notes ? completedAt : undefined,
  notesHistory: buildNotesHistory(result.notes, job.ownerUserId, completedAt),
  transcriptS3Key: result.transcriptS3Key,
  audioS3Key: result.audioS3Key,
  processing: result.processing,
});

const markPersonalMediaUploadComplete = async (
  job: PersonalMediaUploadJobRecord,
  identity: PersonalUploadMeetingIdentity,
  result: PersonalUploadProcessingResult,
  completedAt: string,
  instanceId: string,
) =>
  updateClaimedPersonalMediaUploadJobRecord(
    {
      ...job,
      status: "complete",
      meetingGuildId: identity.guildId,
      meetingId: identity.meetingId,
      channelId_timestamp: identity.channelIdTimestamp,
      durationSeconds: result.durationSeconds,
      segmentCount: result.segmentCount ?? job.segmentCount,
      uploadedSegmentCount:
        result.uploadedSegmentCount ?? job.uploadedSegmentCount,
      processedSegmentCount:
        result.processedSegmentCount ?? job.processedSegmentCount,
      errorMessage: undefined,
      retryable: undefined,
      claimExpiresAt: undefined,
      processingOwnerInstanceId: undefined,
      completedAt,
      updatedAt: completedAt,
    },
    instanceId,
  );

const markPersonalMediaUploadFailed = async (
  job: PersonalMediaUploadJobRecord,
  error: unknown,
  instanceId: string,
) => {
  const now = new Date().toISOString();
  const attempts = job.attempts ?? 1;
  const retryable = attempts < PERSONAL_MEDIA_UPLOAD_MAX_PROCESSING_ATTEMPTS;
  await updateClaimedPersonalMediaUploadJobRecord(
    {
      ...job,
      status: retryable ? "queued" : "failed",
      errorMessage:
        error instanceof Error ? error.message : "Processing failed.",
      retryable,
      claimExpiresAt: undefined,
      processingOwnerInstanceId: undefined,
      queuedAt: retryable ? now : job.queuedAt,
      updatedAt: now,
    },
    instanceId,
  );
};

const writeTerminalFailureMeeting = async (
  job: PersonalMediaUploadJobRecord,
  error: unknown,
) => {
  const attempts = job.attempts ?? 1;
  if (attempts < PERSONAL_MEDIA_UPLOAD_MAX_PROCESSING_ATTEMPTS) return;

  const identity = buildJobMeetingKey(job);
  const existing = await getMeetingHistoryService(
    identity.guildId,
    identity.channelIdTimestamp,
  );
  if (
    existing?.status === MEETING_STATUS.COMPLETE &&
    existing.processing?.transcription &&
    existing.processing.transcription !== "failed"
  ) {
    return;
  }
  const processing =
    error instanceof PersonalUploadProcessingError
      ? error.processing
      : ({
          transcription: "failed",
          notes: "skipped",
          summary: "skipped",
        } as const);
  await writeMeetingHistoryService({
    ...(existing ?? {
      guildId: identity.guildId,
      channelId_timestamp: identity.channelIdTimestamp,
      meetingId: identity.meetingId,
      channelId: PERSONAL_UPLOAD_CHANNEL_ID,
      timestamp: identity.timestamp,
      participants: buildPersonalUploadParticipants(job),
      duration: job.durationSeconds ?? 0,
      transcribeMeeting: true,
      generateNotes: true,
      ownershipScope: "personal" as const,
      ownerUserId: job.ownerUserId,
      meetingCreatorId: job.ownerUserId,
    }),
    status: MEETING_STATUS.COMPLETE,
    processing,
  });
};

const readTerminalSegmentCounts = async (job: PersonalMediaUploadJobRecord) => {
  if (job.uploadOrigin !== "desktop_recording") {
    return { processedSegmentCount: 0, segmentCount: 0 };
  }
  try {
    return summarizeRecordingSegmentProgress(
      await listPersonalRecordingUploadSegments(job.uploadId),
    );
  } catch (error) {
    console.error("Failed to read terminal personal upload segment progress", {
      uploadId: job.uploadId,
      error: buildProviderFailureObservation(error),
    });
    // Keep the last observed counts. Null explicitly means no count was available.
    return {
      processedSegmentCount: job.processedSegmentCount ?? null,
      segmentCount: job.segmentCount ?? null,
    };
  }
};

export async function processPersonalMediaUpload(
  job: PersonalMediaUploadJobRecord,
  instanceId: string,
) {
  // Progress observations belong to this attempt, not the caller's job object.
  job = { ...job };
  await withPersonalUploadProcessingTrace(job, async () => {
    const tempRoot = await ensureTempBaseDir();
    const workDir = path.join(tempRoot, "personal-upload", job.uploadId);
    await fs.mkdir(workDir, { recursive: true });
    let terminalFacts: PersonalUploadTerminalFacts | undefined;
    let result: PersonalUploadProcessingResult | undefined;
    try {
      result = await processPersonalMediaContent(job, workDir, instanceId);
      const identity = buildJobMeetingKey(job);
      const completedAt = new Date().toISOString();
      const meetingHistory = buildCompletedMeetingHistory(
        job,
        identity,
        result,
        completedAt,
      );
      await writeMeetingHistoryService(meetingHistory);
      await maybeAutoExportCompletedMeeting(meetingHistory);
      await markPersonalMediaUploadComplete(
        job,
        identity,
        result,
        completedAt,
        instanceId,
      );
      terminalFacts = {
        processing: result.processing,
        failedChunks: result.failedChunks,
        processedSegmentCount: result.processedSegmentCount ?? 0,
        segmentCount: result.segmentCount ?? 0,
        jobStatus: "complete",
      };
    } catch (error) {
      if (job.uploadOrigin === "desktop_recording") {
        await markPersonalRecordingUploadSegmentsFailed(job.uploadId, error);
      }
      const resolvedError = result
        ? new PersonalUploadProcessingError(
            error,
            result.processing,
            result.failedChunks,
          )
        : error;
      try {
        await writeTerminalFailureMeeting(job, resolvedError);
      } catch (historyError) {
        console.error("Failed to finalize personal upload meeting history", {
          uploadId: job.uploadId,
          error: buildProviderFailureObservation(historyError),
        });
      }
      await markPersonalMediaUploadFailed(job, error, instanceId);
      console.error("Failed to process personal media upload", {
        uploadId: job.uploadId,
        error: buildProviderFailureObservation(error),
      });
      if (
        (job.attempts ?? 1) >= PERSONAL_MEDIA_UPLOAD_MAX_PROCESSING_ATTEMPTS
      ) {
        const progress = await readTerminalSegmentCounts(job);
        terminalFacts = {
          processing:
            resolvedError instanceof PersonalUploadProcessingError
              ? resolvedError.processing
              : {
                  transcription: "failed",
                  notes: "skipped",
                  summary: "skipped",
                },
          failedChunks:
            resolvedError instanceof PersonalUploadProcessingError
              ? resolvedError.failedChunks
              : 0,
          processedSegmentCount:
            result?.processedSegmentCount ?? progress.processedSegmentCount,
          segmentCount: result?.segmentCount ?? progress.segmentCount,
          jobStatus: "failed",
        };
      }
    } finally {
      if (terminalFacts) {
        recordPersonalUploadTerminal(job.uploadId, terminalFacts);
      }
      await fs.rm(workDir, { recursive: true, force: true });
    }
  });
}
