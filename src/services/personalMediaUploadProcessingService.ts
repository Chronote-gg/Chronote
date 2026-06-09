import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import ffmpeg from "fluent-ffmpeg";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { TranscriptionCreateParamsNonStreaming } from "openai/resources/audio";
import type {
  MeetingHistory,
  PersonalMediaUploadJobRecord,
  PersonalRecordingSourceRecord,
} from "../types/db";
import type { Participant } from "../types/participants";
import type { TranscriptSegment } from "../types/transcript";
import { MEETING_STATUS } from "../types/meetingLifecycle";
import {
  PERSONAL_MEDIA_UPLOAD_MAX_PROCESSING_ATTEMPTS,
  TRANSCRIPTION_FINAL_PASS_CHUNK_SECONDS,
  TRANSCRIPTION_FINAL_PASS_MAX_REQUEST_BYTES,
} from "../constants";
import { writeMeetingHistoryService } from "./meetingHistoryService";
import { downloadObjectToFile, uploadObjectToS3 } from "./storageService";
import { ensureTempBaseDir } from "./tempFileService";
import { createOpenAIClient } from "./openaiClient";
import { getModelChoice } from "./modelFactory";
import { resolveChatParamsForRole } from "./openaiModelParams";
import { getLangfuseChatPrompt } from "./langfusePromptService";
import { config } from "./configService";
import {
  generateMeetingSummaries,
  type MeetingSummaries,
} from "./meetingSummaryService";
import { resolveMeetingNameFromSummary } from "./meetingNameService";
import { maybeAutoExportCompletedMeeting } from "./notionAutomationService";
import {
  updateClaimedPersonalMediaUploadJobRecord,
  updatePersonalMediaUploadJobRecord,
} from "./personalMediaUploadService";
import { buildPersonalMeetingGuildId } from "../utils/meetingOwnership";

const PERSONAL_UPLOAD_CHANNEL_ID = "personal";
const PERSONAL_UPLOAD_CHANNEL_NAME = "Uploaded media";
const PERSONAL_UPLOAD_SERVER_NAME = "Personal";

type PersonalUploadMeetingIdentity = ReturnType<typeof buildJobMeetingKey>;

type PersonalUploadProcessingResult = {
  audioS3Key?: string;
  durationSeconds: number;
  meetingName?: string;
  notes: string;
  summaries: MeetingSummaries;
  transcriptS3Key?: string;
};

type PersonalUploadTranscriptArtifact = {
  segments: TranscriptSegment[];
  text: string;
};

type ProcessedPersonalRecordingSource = {
  audioPath: string;
  durationSeconds: number;
  segment: TranscriptSegment;
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

const transcribeAudioFiles = async (filePaths: string[]) => {
  const chunks: string[] = [];
  for (const filePath of filePaths) {
    const transcript = await transcribeAudioFile(filePath);
    if (transcript.trim()) chunks.push(transcript.trim());
  }
  return chunks.join("\n\n");
};

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
  return generatePersonalUploadNotes({ transcript, title: job.title });
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

const buildRecordingSegment = (input: {
  job: PersonalMediaUploadJobRecord;
  source: PersonalRecordingSourceRecord;
  transcript: string;
}): TranscriptSegment => ({
  userId:
    input.source.kind === "owner_mic"
      ? input.job.ownerUserId
      : `system:${input.job.uploadId}`,
  username: input.source.label,
  displayName: input.source.label,
  startedAt: input.job.createdAt,
  text: input.transcript,
  source: "desktop_recording",
});

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
  const transcript = await transcribeAudioFiles(transcriptionInputs);
  return {
    audioPath,
    durationSeconds,
    segment: buildRecordingSegment({ job, source, transcript }),
  };
};

const processPersonalRecordingContent = async (
  job: PersonalMediaUploadJobRecord,
  workDir: string,
): Promise<PersonalUploadProcessingResult> => {
  const sources = job.sourceManifest ?? [];
  if (sources.length === 0) {
    throw new Error("Desktop recording upload has no source manifest.");
  }

  const processedSources: ProcessedPersonalRecordingSource[] = [];
  for (const source of sources) {
    processedSources.push(
      await processPersonalRecordingSource(job, source, workDir),
    );
  }

  const audioPath = path.join(workDir, "audio.mp3");
  await mixAudioFiles(
    processedSources.map((source) => source.audioPath),
    audioPath,
  );
  const transcriptArtifact = buildTranscriptArtifactFromSegments(
    processedSources.map((source) => source.segment),
  );
  const notes = await generateNotesForTranscript(job, transcriptArtifact.text);
  const summaries = await generateSummariesForNotes(job, notes);
  const meetingName = await resolvePersonalUploadMeetingName(job, summaries);
  const artifacts = await uploadPersonalUploadArtifacts(
    job,
    audioPath,
    transcriptArtifact,
  );

  return {
    ...artifacts,
    durationSeconds: Math.max(
      0,
      ...processedSources.map((source) => source.durationSeconds),
    ),
    meetingName,
    notes,
    summaries,
  };
};

const processPersonalMediaContent = async (
  job: PersonalMediaUploadJobRecord,
  workDir: string,
): Promise<PersonalUploadProcessingResult> => {
  if (job.uploadOrigin === "desktop_recording" || job.sourceManifest?.length) {
    return processPersonalRecordingContent(job, workDir);
  }

  const { audioPath, durationSeconds } = await downloadAndNormalizeMedia(
    job,
    workDir,
  );
  const transcriptionInputs = await resolveTranscriptionInputs(
    audioPath,
    workDir,
  );
  const transcript = await transcribeAudioFiles(transcriptionInputs);
  const transcriptArtifact = buildSingleSourceTranscriptArtifact(
    job,
    transcript,
  );
  const notes = await generateNotesForTranscript(job, transcriptArtifact.text);
  const summaries = await generateSummariesForNotes(job, notes);
  const meetingName = await resolvePersonalUploadMeetingName(job, summaries);
  const artifacts = await uploadPersonalUploadArtifacts(
    job,
    audioPath,
    transcriptArtifact,
  );

  return {
    ...artifacts,
    durationSeconds,
    meetingName,
    notes,
    summaries,
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
      roles: "",
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
  return completion.choices[0]?.message?.content?.trim() ?? "";
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

export async function processPersonalMediaUpload(
  job: PersonalMediaUploadJobRecord,
  instanceId: string,
) {
  const tempRoot = await ensureTempBaseDir();
  const workDir = path.join(tempRoot, "personal-upload", job.uploadId);
  await fs.mkdir(workDir, { recursive: true });
  try {
    const result = await processPersonalMediaContent(job, workDir);
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
  } catch (error) {
    await markPersonalMediaUploadFailed(job, error, instanceId);
    console.error("Failed to process personal media upload", {
      uploadId: job.uploadId,
      error,
    });
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}
