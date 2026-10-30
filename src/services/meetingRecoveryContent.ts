import {
  reserveCheckpointPcm,
  releaseCheckpointPcm,
} from "./recordingCheckpointCapture";
import { processRecoveryTranscript } from "./recoveryTranscriptionProcessing";
import type { TranscriptSegment } from "../types/transcript";
import { resolveAudioFileText } from "../utils/audioTranscript";
import type { AudioFileData } from "../types/audio";
import { isDeepStrictEqual } from "node:util";
import type { MeetingHistory } from "../types/db";
import type { MeetingNotesInput } from "../types/meeting-data";
import {
  generationContextSchema,
  completedTranscriptionSchema,
  type GenerationContextCheckpoint,
} from "../types/recordingContent";
import { recordingCheckpointSchema } from "../types/recordingCheckpoint";
import type {
  CheckpointArtifact,
  RecordingCheckpoint,
} from "../types/recordingCheckpoint";
import { createRecordingCheckpointService } from "./recordingCheckpointService";
import {
  compileSavedChatPrompt,
  compileSavedPrompt,
} from "./savedRecordingPrompt";
import { getTranscriptionTextQuality } from "../utils/transcriptionText";
import { buildDictionaryPromptLines } from "../utils/dictionary";
import { chatContextVariables } from "./notesPromptService";
import {
  transcribeContentSnippet,
  type TranscriptionContentInput,
} from "./transcriptionService";

export type RecoveryReader = Pick<
  ReturnType<typeof createRecordingCheckpointService>,
  "read" | "readVerifiedObject"
>;
export class InvalidRecoveryContent extends Error {}
export class TranscriptOverlapUnknown extends Error {}
import {
  transcriptCorrespondenceSchema,
  type PcmSpan,
  type TranscriptCorrespondence,
} from "../types/transcriptCorrespondence";
import { normalizePcmSpans } from "../utils/transcriptCorrespondence";
function latest(
  artifacts: CheckpointArtifact[],
  kind: CheckpointArtifact["kind"],
) {
  return artifacts
    .filter((item) => item.kind === kind)
    .sort((a, b) => b.sequence - a.sequence)[0];
}
function boundContent(
  capture: RecordingCheckpoint["capture"],
  actual: RecordingCheckpoint["capture"],
) {
  if (!isDeepStrictEqual(capture, actual))
    throw new InvalidRecoveryContent(
      "Saved content capture differs from manifest",
    );
}
export async function readRecoveryContent(
  history: MeetingHistory,
  reader: RecoveryReader,
  signal: AbortSignal,
) {
  const pointer = history.checkpoint
    ? recordingCheckpointSchema.parse(history.checkpoint)
    : undefined;
  if (
    !pointer ||
    pointer.capture.meetingId !== history.meetingId ||
    pointer.capture.guildId !== history.guildId ||
    pointer.capture.channelId_timestamp !== history.channelId_timestamp ||
    pointer.capture.channelId !== history.channelId
  )
    throw new InvalidRecoveryContent("No bound committed checkpoint");
  if (!(await reader.readVerifiedObject(pointer.manifest, signal)))
    throw new InvalidRecoveryContent(
      "Committed manifest is missing or corrupt",
    );
  const verified = await reader.read(pointer, signal);
  const contextRef = latest(verified.manifest.artifacts, "context");
  if (!contextRef)
    throw new InvalidRecoveryContent("Verified original context unavailable");
  const contextBytes = await reader.readVerifiedObject(
    contextRef.object,
    signal,
  );
  if (!contextBytes)
    throw new InvalidRecoveryContent("Context verification changed");
  const context = generationContextSchema.parse(
    JSON.parse(Buffer.from(contextBytes).toString("utf8")),
  );
  boundContent(pointer.capture, context.capture);
  const latestTranscript = latest(verified.manifest.artifacts, "transcription");
  const transcriptRef =
    latestTranscript &&
    verified.verified.find(
      (item) => item.object.key === latestTranscript.object.key,
    );
  let processing: import("../types/recordingContent").CompletedTranscriptionCheckpoint["processing"];
  let entries:
    | import("../types/recordingContent").CompletedTranscriptionCheckpoint["entries"]
    | undefined;
  let omitted: import("../types/recordingContent").CompletedTranscriptionCheckpoint["omitted"];
  if (transcriptRef) {
    const bytes = await reader.readVerifiedObject(transcriptRef.object, signal);
    if (!bytes)
      throw new InvalidRecoveryContent("Transcription verification changed");
    const transcript = completedTranscriptionSchema.parse(
      JSON.parse(Buffer.from(bytes).toString("utf8")),
    );
    boundContent(pointer.capture, transcript.capture);
    entries = transcript.entries;
    processing = transcript.processing;
    omitted = transcript.omitted;
  }
  signal.throwIfAborted();
  return { ...verified, context, entries, processing, omitted };
}
export type RecoveryContent = Awaited<ReturnType<typeof readRecoveryContent>>;
export const INTERRUPTED_CAPTURE_NOTICE =
  "This recording ended abruptly. The interruption cause is unknown.";
export function recoveryCaptureNotice(
  content: RecoveryContent,
  interrupted: boolean,
) {
  const timing = content.verified.some(
    (item) =>
      item.kind === "audio" &&
      (!item.timing || item.timing.maxCursorAdjustmentMs > 0),
  );
  return [
    interrupted
      ? INTERRUPTED_CAPTURE_NOTICE
      : "These notes were recovered after processing stopped.",
    "Saved content can contain gaps. Describe only confirmed conversation; never invent missing discussion, decisions, or an ending.",
    content.missing.length
      ? `${content.missing.length} checkpoint artifacts could not be verified.`
      : "Only verified saved content is included.",
    content.context.captureIncomplete
      ? "The original receiver recorded capture gaps."
      : "",
    timing
      ? "Audio timing uses sample positions and observed gaps; exact physical wall-clock alignment is uncertain."
      : "Do not infer conversation outside the saved intervals.",
  ].join(" ");
}
export function transcriptionInput(
  context: GenerationContextCheckpoint,
  signal: AbortSignal,
  effect: TranscriptionContentInput["effect"],
): TranscriptionContentInput {
  if (
    context.settings.availability !== "available" ||
    context.context.availability !== "available" ||
    context.prompts.transcription?.availability !== "available" ||
    context.prompts.transcription.value.type !== "text"
  )
    throw new InvalidRecoveryContent(
      "Original transcription inputs unavailable",
    );
  const settings = context.settings.value;
  const saved = context.prompts.transcription.value;
  const dictionary = buildDictionaryPromptLines(
    context.context.dictionaryEntries,
    settings.dictionary,
  ).transcriptionLines;
  const compiled = compileSavedPrompt(saved, {
    serverName: context.serverName,
    channelName: context.voiceChannelName,
    serverDescriptionLine: context.serverDescription
      ? `Server Description: ${context.serverDescription}`
      : "",
    attendeesLine: `Attendees: ${context.attendees}`,
    botNamesLine: context.botNames.length
      ? `Bot Names: ${context.botNames.join(", ")}`
      : "",
    dictionaryBlock: dictionary.length
      ? `Dictionary terms:\n${dictionary.join("\n")}`
      : "",
    meetingContextLine: context.context.meetingContext
      ? `Meeting Context: ${context.context.meetingContext}`
      : "",
  });
  if (typeof compiled !== "string")
    throw new InvalidRecoveryContent("Transcription prompt type changed");
  return {
    meetingId: context.capture.meetingId,
    creator: { id: context.creatorId },
    guild: { id: context.capture.guildId },
    voiceChannel: { id: context.capture.channelId },
    signal,
    effect,
    runtimeConfig: {
      transcription: settings.transcription,
      modelChoices: { transcription: settings.models.transcription.model },
    },
    prompt: async () => ({
      source: "langfuse",
      prompt: compiled,
      langfusePrompt: {
        name: saved.name,
        version: saved.version,
        isFallback: false,
      },
    }),
  };
}
const RECOVERY_CHUNK_FRAMES = 48000 * 30;
type RecoveryAudioSlice = {
  artifact: Extract<CheckpointArtifact, { kind: "audio" }>;
  startFrame: number;
  frames: number;
  byteOffset: number;
};
type RecoveryAudioGroup = {
  sourceId: string;
  startFrame: number;
  endFrame: number;
  slices: RecoveryAudioSlice[];
};
function alignedFrame(milliseconds: number) {
  const frames = milliseconds * 48;
  const rounded = Math.round(frames);
  if (
    !Number.isSafeInteger(rounded) ||
    rounded < 0 ||
    Math.abs(frames - rounded) > 0.000001
  )
    throw new InvalidRecoveryContent("PCM coverage is not frame aligned");
  return rounded;
}
type ByteRange = { startByte: number; endByte: number };
function audioGroups(
  item: Extract<CheckpointArtifact, { kind: "audio" }>,
  byteLength: number,
  residual: readonly ByteRange[],
) {
  if (item.coverage.kind !== "known")
    throw new InvalidRecoveryContent("PCM coverage unavailable");
  const intervals: Array<{
    startFrame: number;
    startByte: number;
    endByte: number;
  }> = [];
  let offset = 0;
  let lastEnd = 0;
  for (const interval of item.coverage.intervals) {
    const startFrame = alignedFrame(interval.startOffsetMs);
    const frames = alignedFrame(interval.durationMs);
    if (interval.sourceId !== item.sourceId || !frames || startFrame < lastEnd)
      throw new InvalidRecoveryContent(
        "PCM interval coverage is invalid or overlapping",
      );
    intervals.push({
      startFrame,
      startByte: offset,
      endByte: offset + frames * 4,
    });
    offset += frames * 4;
    lastEnd = startFrame + frames;
  }
  if (offset !== byteLength)
    throw new InvalidRecoveryContent(
      "PCM interval coverage differs from saved bytes",
    );
  const groups: RecoveryAudioGroup[] = [];
  for (const range of residual) {
    // An excluded represented range is a hard split, never padded back into ASR.
    let group: RecoveryAudioGroup | undefined;
    for (const interval of intervals) {
      let byteOffset = Math.max(range.startByte, interval.startByte);
      const endByte = Math.min(range.endByte, interval.endByte);
      let startFrame =
        interval.startFrame + (byteOffset - interval.startByte) / 4;
      while (byteOffset < endByte) {
        if (!group || startFrame >= group.startFrame + RECOVERY_CHUNK_FRAMES) {
          group = {
            sourceId: item.sourceId,
            startFrame,
            endFrame: startFrame,
            slices: [],
          };
          groups.push(group);
        }
        const frames = Math.min(
          (endByte - byteOffset) / 4,
          group.startFrame + RECOVERY_CHUNK_FRAMES - startFrame,
        );
        group.slices.push({ artifact: item, startFrame, frames, byteOffset });
        group.endFrame = startFrame + frames;
        byteOffset += frames * 4;
        startFrame += frames;
      }
    }
  }
  return groups;
}
function correspondenceSpans(
  value: TranscriptCorrespondence | undefined,
  content: RecoveryContent,
  sourceId?: string,
): PcmSpan[] {
  if (!value) return [];
  const parsed = transcriptCorrespondenceSchema.parse(value);
  if (parsed.kind === "text_only") return [];
  for (const span of parsed.spans) {
    if (sourceId && sourceId !== span.sourceId)
      throw new InvalidRecoveryContent(
        "Transcript receipt source differs from entry",
      );
    const pieces = content.manifest.artifacts.filter(
      (item) =>
        item.kind === "audio" &&
        item.sourceId === span.sourceId &&
        item.sequence === span.sequence,
    );
    if (pieces.length > 1)
      throw new InvalidRecoveryContent("Ambiguous PCM piece identity");
    // An open or unverified piece proves no coverage of a different saved piece.
    if (pieces[0] && span.endByte > pieces[0].object.byteLength)
      throw new InvalidRecoveryContent(
        "Transcript receipt exceeds saved PCM bytes",
      );
  }
  return parsed.spans;
}
function residualRanges(
  item: Extract<CheckpointArtifact, { kind: "audio" }>,
  spans: readonly PcmSpan[],
): ByteRange[] {
  const ranges: ByteRange[] = [];
  let cursor = 0;
  for (const span of normalizePcmSpans(
    spans.filter(
      (span) =>
        span.sourceId === item.sourceId && span.sequence === item.sequence,
    ),
  )) {
    if (span.endByte > item.object.byteLength)
      throw new InvalidRecoveryContent(
        "Transcript receipt exceeds saved PCM bytes",
      );
    if (cursor < span.startByte)
      ranges.push({ startByte: cursor, endByte: span.startByte });
    cursor = span.endByte;
  }
  if (cursor < item.object.byteLength)
    ranges.push({ startByte: cursor, endByte: item.object.byteLength });
  return ranges;
}
async function transcribeAudioGroup(
  group: RecoveryAudioGroup,
  readAudio: (object: CheckpointArtifact["object"]) => Promise<Uint8Array>,
  input: TranscriptionContentInput,
  userId: string,
  timestamp: number,
) {
  input.signal.throwIfAborted();
  const length = (group.endFrame - group.startFrame) * 4;
  if (!reserveCheckpointPcm(length))
    throw new Error("Recovery PCM budget unavailable");
  try {
    // Silence is temporary alignment scratch, never newly claimed capture coverage.
    const buffer = Buffer.alloc(length);
    for (const slice of group.slices) {
      const bytes = await readAudio(slice.artifact.object);
      buffer.set(
        bytes.subarray(slice.byteOffset, slice.byteOffset + slice.frames * 4),
        (slice.startFrame - group.startFrame) * 4,
      );
    }
    const result = await transcribeContentSnippet(
      input,
      { userId, timestamp, chunks: [buffer] },
      { tempSuffix: "recovery" },
    );
    input.signal.throwIfAborted();
    if (result.status === "succeeded") return result.text;
    // Audio the speech gate rejects is empty text, never a failed attempt.
    if (result.status === "skipped") return "";
    throw new Error("Recovery transcription failed");
  } finally {
    // Awaited conversion/provider lifetime has settled, including cancellation/error.
    releaseCheckpointPcm(length);
  }
}
async function recoverAudioIntervals(
  residual: Array<{
    item: Extract<CheckpointArtifact, { kind: "audio" }>;
    ranges: ByteRange[];
  }>,
  reader: RecoveryReader,
  input: TranscriptionContentInput,
  startedAt: number,
): Promise<AudioFileData[]> {
  const signal = input.signal;
  signal.throwIfAborted();
  const groups = residual.flatMap(({ item, ranges }) => {
    if (
      item.format.sampleRate !== 48000 ||
      item.format.channels !== 2 ||
      item.object.byteLength > 64 * 1024 * 1024 ||
      item.coverage.kind !== "known"
    )
      throw new InvalidRecoveryContent(
        "Unsupported or unaligned PCM checkpoint",
      );
    return audioGroups(item, item.object.byteLength, ranges);
  });
  groups.sort(
    (a, b) =>
      a.sourceId.localeCompare(b.sourceId) || a.startFrame - b.startFrame,
  );
  const batches: RecoveryAudioGroup[] = [];
  for (const group of groups) {
    const previous = batches[batches.length - 1];
    // Only exact adjacency joins artifacts; gaps and represented ranges stay split.
    if (
      previous?.sourceId === group.sourceId &&
      previous.endFrame === group.startFrame &&
      group.endFrame - previous.startFrame <= RECOVERY_CHUNK_FRAMES
    ) {
      previous.endFrame = group.endFrame;
      previous.slices.push(...group.slices);
    } else batches.push(group);
  }
  const files: AudioFileData[] = [];
  let loaded:
    { object: CheckpointArtifact["object"]; bytes: Uint8Array } | undefined;
  const readAudio = async (object: CheckpointArtifact["object"]) => {
    signal.throwIfAborted();
    if (loaded?.object !== object) {
      loaded = undefined;
      const bytes = await reader.readVerifiedObject(object, signal);
      if (!bytes)
        throw new InvalidRecoveryContent("Audio verification changed");
      loaded = { object, bytes };
    }
    return loaded.bytes;
  };
  for (const group of batches) {
    const userId = group.sourceId.split(":").slice(1).join(":");
    if (!/^[a-zA-Z0-9_-]+$/.test(userId))
      throw new InvalidRecoveryContent("Invalid saved source identity");
    const timestamp = startedAt + group.startFrame / 48;
    const text = await transcribeAudioGroup(
      group,
      readAudio,
      input,
      userId,
      timestamp,
    );
    if (!getTranscriptionTextQuality(text).trivial)
      files.push({
        userId,
        timestamp,
        transcript: text,
        transcriptCorrespondence: {
          kind: "pcm",
          spans: normalizePcmSpans(
            group.slices.map((slice) => ({
              sourceId: slice.artifact.sourceId,
              sequence: slice.artifact.sequence,
              startByte: slice.byteOffset,
              endByte: slice.byteOffset + slice.frames * 4,
            })),
          ),
        },
        source: group.sourceId.startsWith("bot:") ? "bot" : "voice",
        processing: false,
        audioOnlyProcessing: false,
      });
  }
  return files;
}
/** Validate every selected/omitted input before deciding whether recovery may dispatch. */
function validateTranscriptDispositions(
  content: RecoveryContent,
  entries: NonNullable<RecoveryContent["entries"]>,
) {
  const represented = entries.flatMap((entry) =>
    correspondenceSpans(entry.correspondence, content, entry.sourceId),
  );
  const omitted = correspondenceSpans(content.omitted, content);
  const aggregate = correspondenceSpans(
    content.processing?.correspondence,
    content,
  );
  const dispositions = [...represented, ...omitted].sort(
    (a, b) =>
      a.sourceId.localeCompare(b.sourceId) ||
      a.sequence - b.sequence ||
      a.startByte - b.startByte,
  );
  for (let i = 1; i < dispositions.length; i++) {
    const before = dispositions[i - 1],
      after = dispositions[i];
    if (
      before.sourceId === after.sourceId &&
      before.sequence === after.sequence &&
      before.endByte > after.startByte
    )
      throw new InvalidRecoveryContent("Transcript input dispositions overlap");
  }
  return { represented, dispositions, aggregate };
}
export async function recoverTranscript(
  content: RecoveryContent,
  reader: RecoveryReader,
  signal: AbortSignal,
  effect: TranscriptionContentInput["effect"],
): Promise<{ text: string; segments: TranscriptSegment[] }> {
  const audio = content.verified.filter((item) => item.kind === "audio");
  const acknowledgedText = content.processing?.finalText;
  const entries = content.entries ?? [];
  const { dispositions, aggregate } = validateTranscriptDispositions(
    content,
    entries,
  );
  const savedSegments = entries.map((entry) => ({
    ...entry,
    startedAt: new Date(entry.timestamp).toISOString(),
  }));
  if (acknowledgedText !== undefined) {
    if (
      content.processing?.supplementalEntries ||
      (audio.length && !content.processing?.correspondence) ||
      audio.some((item) => residualRanges(item, aggregate).length)
    )
      throw new TranscriptOverlapUnknown(
        "Acknowledged transcript overlap with uncovered input is unknown",
      );
    return { text: acknowledgedText, segments: savedSegments };
  }
  const { text, segments } = await composeRecoveredTranscript(
    content,
    reader,
    signal,
    effect,
    dispositions,
    false,
  );
  return { text, segments };
}
/**
 * Re-transcribes every saved PCM range no saved entry represents (omitted and
 * never-transcribed audio) and keeps saved entries exactly as stored.
 */
export async function retranscribeOmittedRanges(
  content: RecoveryContent,
  reader: RecoveryReader,
  signal: AbortSignal,
  effect: TranscriptionContentInput["effect"],
): Promise<{
  text: string;
  segments: TranscriptSegment[];
  retranscribedRanges: number;
}> {
  const { represented } = validateTranscriptDispositions(
    content,
    content.entries ?? [],
  );
  return composeRecoveredTranscript(
    content,
    reader,
    signal,
    effect,
    represented,
    true,
  );
}
/**
 * A retry accepts ranges the speech gate skips again and never replays the
 * frozen finalized-audio pass, which would rewrite kept entries and can carry
 * a superseded chunk length.
 */
async function composeRecoveredTranscript(
  content: RecoveryContent,
  reader: RecoveryReader,
  signal: AbortSignal,
  effect: TranscriptionContentInput["effect"],
  covered: readonly PcmSpan[],
  retry: boolean,
) {
  const audio = content.verified.filter((item) => item.kind === "audio");
  const entries = content.entries ?? [];
  if (
    entries.some(
      (entry) =>
        !entry.correspondence &&
        audio.some((item) => item.sourceId === entry.sourceId),
    )
  )
    throw new TranscriptOverlapUnknown(
      "Legacy transcript overlap with saved PCM is unknown",
    );
  const files: AudioFileData[] = entries.map((entry) => ({
    userId: entry.userId,
    timestamp: entry.timestamp,
    transcript: entry.text,
    transcriptCorrespondence: entry.correspondence,
    source: entry.source,
    processing: false,
    audioOnlyProcessing: false,
  }));
  const residual = audio
    .map((item) => ({ item, ranges: residualRanges(item, covered) }))
    .filter(({ ranges }) => ranges.length);
  const savedCount = files.length;
  if (residual.length) {
    const input = transcriptionInput(content.context, signal, effect);
    const startedAt = Date.parse(
      content.manifest.capture.captureStartedAt ?? "",
    );
    if (!Number.isFinite(startedAt))
      throw new InvalidRecoveryContent("Original capture timing unavailable");
    files.push(
      ...(await recoverAudioIntervals(residual, reader, input, startedAt)),
    );
  }
  // Only ranges that came back with text count, so audio the gate rejects
  // again is "nothing to retry" rather than a recovered transcript.
  const retranscribedRanges = files.length - savedCount;
  const text = await processRecoveryTranscript(
    content,
    reader,
    files,
    signal,
    effect,
    !retry,
  );
  // Final-pass corrections mutate these files. Cleanup can alter aggregate text,
  // but cannot invent a more precise speaker/time alignment for a segment.
  const segments = files.map((file): TranscriptSegment => {
    const participant = content.context.participants.find(
      (p) => p.id === file.userId,
    );
    return {
      userId: file.userId,
      username: participant?.username,
      displayName: participant?.displayName,
      serverNickname: participant?.serverNickname,
      startedAt: new Date(file.timestamp).toISOString(),
      text: resolveAudioFileText(file),
      source: file.source,
    };
  });
  return {
    text,
    segments: [...segments].sort(
      (a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt),
    ),
    retranscribedRanges,
  };
}
export function recoveryNotesInput(
  history: MeetingHistory,
  content: RecoveryContent,
  transcript: string,
  signal: AbortSignal,
  interrupted: boolean,
): MeetingNotesInput {
  const context = content.context;
  if (
    context.settings.availability !== "available" ||
    context.context.availability !== "available" ||
    context.prompts.notes?.availability !== "available" ||
    context.prompts.summary?.availability !== "available" ||
    context.recentMeetingNames.availability !== "available"
  )
    throw new InvalidRecoveryContent("Original generation inputs unavailable");
  const settings = context.settings.value;
  const variables = {
    formattedContext: context.context.formattedContext,
    botDisplayName: context.botDisplayName,
    ...chatContextVariables(context.chatContext),
    participantRoster: context.participantRoster,
    serverName: context.serverName,
    serverDescription: context.serverDescription,
    voiceChannelName: context.voiceChannelName,
    attendees: context.attendees,
    roles: context.roleRoster,
    events: context.events,
    channelNames: context.channelNames,
    longStoryTargetChars: settings.notes.longStoryTargetChars,
    transcript,
  };
  return {
    meetingId: history.meetingId,
    guildId: history.guildId,
    channelId: history.channelId,
    ...context.capture.requested,
    startTime: new Date(context.capture.reservedAt),
    creator: { id: context.creatorId },
    guild: {
      id: history.guildId,
      name: context.serverName,
      description: context.serverDescription,
    },
    voiceChannel: { id: history.channelId, name: context.voiceChannelName },
    participants: new Map(context.participants.map((p) => [p.id, p])),
    attendance: new Set(context.attendance),
    tags: context.tags,
    finalTranscript: transcript,
    notesText:
      history.processing?.notes === "generated" ? history.notes : undefined,
    summarySentence:
      history.processing?.summary === "generated"
        ? history.summarySentence
        : undefined,
    summaryLabel:
      history.processing?.summary === "generated"
        ? history.summaryLabel
        : undefined,
    processing: {
      transcription:
        interrupted ||
        content.missing.length ||
        content.context.captureIncomplete
          ? "partial"
          : "ready",
      ...(history.processing?.notes === "generated"
        ? { notes: "generated" as const }
        : {}),
      ...(history.processing?.summary === "generated"
        ? { summary: "generated" as const }
        : {}),
    },
    signal,
    recovered: true,
    captureNotice: recoveryCaptureNotice(content, interrupted),
    notesPrompt: {
      ...compileSavedChatPrompt(context.prompts.notes.value, variables),
      promptVisibleRoleIds: context.promptVisibleRoleIds,
    },
    savedSummary: {
      prompt: context.prompts.summary.value,
      recentMeetingNames: context.recentMeetingNames.value,
    },
    frozenModels: settings.models,
  };
}
