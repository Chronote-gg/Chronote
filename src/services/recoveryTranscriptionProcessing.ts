import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { AudioFileData } from "../types/audio";
import type { RecoveryContent, RecoveryReader } from "./meetingRecoveryContent";
import {
  InvalidRecoveryContent,
  transcriptionInput,
} from "./meetingRecoveryContent";
import { compileSavedChatPrompt } from "./savedRecordingPrompt";
import {
  cleanupContentTranscription,
  retainCleanupTranscript,
} from "./transcriptionCleanupService";
import type { TranscriptionContentInput } from "./transcriptionService";
import {
  runContentTranscriptionFinalPass,
  type FinalPassContent,
} from "./transcriptionFinalPassService";
import { renderMixedPcmTracks } from "./mixedPcmService";
import { ensureMeetingTempDir } from "./tempFileService";
import { resolveAudioFileText } from "../utils/audioTranscript";
import { getTranscriptionTextQuality } from "../utils/transcriptionText";
import { formatParticipantLabel } from "../utils/participants";

function formattedTranscript(content: RecoveryContent, files: AudioFileData[]) {
  return files
    .filter(
      (file) =>
        !getTranscriptionTextQuality(resolveAudioFileText(file)).trivial,
    )
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((file) => {
      const label =
        content.entries?.find(
          (entry) =>
            entry.userId === file.userId && entry.timestamp === file.timestamp,
        )?.speakerLabel ??
        formatParticipantLabel(
          content.context.participants.find((p) => p.id === file.userId),
          { includeUsername: true, fallbackName: file.userId },
        );
      return `[${label} @ ${new Date(file.timestamp).toLocaleString()}]: ${resolveAudioFileText(file)}`;
    })
    .join("\n");
}
function originalSettings(content: RecoveryContent) {
  if (content.context.settings.availability !== "available")
    throw new InvalidRecoveryContent(
      "Original processing settings unavailable",
    );
  return content.context.settings.value;
}
function transcriptionVariables(content: RecoveryContent) {
  const context = content.context;
  if (
    context.context.availability !== "available" ||
    context.context.transcriptionFormattedContext === undefined ||
    context.context.transcriptionMaxContextLength === undefined
  )
    throw new InvalidRecoveryContent(
      "Original transcription context unavailable",
    );
  return {
    formattedContext: context.context.transcriptionFormattedContext,
    attendees: context.attendees,
    serverName: context.serverName,
    serverDescription: context.serverDescription,
    voiceChannelName: context.voiceChannelName,
    roles: context.cleanupRoleNames ?? "",
    events: context.events,
    channelNames: context.channelNames,
  };
}
function completeVerifiedAudio(content: RecoveryContent) {
  return (
    content.manifest.captureState.kind === "complete" &&
    !content.context.captureIncomplete &&
    content.missing.length === 0
  );
}
async function originalFinalPass(
  content: RecoveryContent,
  reader: RecoveryReader,
  files: AudioFileData[],
  signal: AbortSignal,
  effect: TranscriptionContentInput["effect"],
) {
  const settings = originalSettings(content);
  const saved = content.context.prompts.finalPass;
  if (!settings.processing || saved?.availability !== "available")
    throw new InvalidRecoveryContent(
      "Original finalized-pass inputs unavailable",
    );
  const variables = transcriptionVariables(content);
  const transcription = transcriptionInput(content.context, signal, effect);
  const startedAt = content.manifest.capture.captureStartedAt;
  if (!startedAt)
    throw new InvalidRecoveryContent("Finalized capture start unavailable");
  const input: FinalPassContent = {
    meetingId: content.manifest.capture.meetingId,
    creator: { id: content.context.creatorId },
    guild: { id: content.manifest.capture.guildId },
    voiceChannel: { id: content.manifest.capture.channelId },
    startTime: new Date(startedAt),
    participants: new Map(content.context.participants.map((p) => [p.id, p])),
    audioData: { audioFiles: files },
    signal,
    effect,
    enabled: true,
    settings: settings.processing.finalPass,
    transcriptionModel: settings.models.transcription.model,
    reconcileModel: settings.models.transcriptionCoalesce,
    prompt: transcription.prompt,
    finalPassPrompt: async (request) => ({
      ...compileSavedChatPrompt(saved.value, {
        ...variables,
        chunkIndex: String(request.chunkIndex),
        chunkCount: String(request.chunkCount),
        chunkTranscript: request.chunkTranscript,
        previousChunkTail: request.previousChunkTail.trim() || "None.",
        chunkLogprobSummary: request.chunkLogprobSummary,
        baselineSegmentsBlock: request.baselineSegments
          .map(
            (segment) =>
              `[${segment.segmentId}] [${segment.speaker} @ ${segment.startedAt}] ${segment.text}`,
          )
          .join("\n"),
      }),
      source: "langfuse",
    }),
  };
  const base = await ensureMeetingTempDir(input);
  const directory = await fs.mkdtemp(path.join(base, "recovery-final-pass-"));
  try {
    const tracks = await writeVerifiedTracks(
      content,
      reader,
      directory,
      signal,
    );
    if (!tracks.length)
      throw new InvalidRecoveryContent(
        "Complete finalized-pass audio unavailable",
      );
    const mixed = await renderMixedPcmTracks(
      tracks,
      path.join(directory, "mixed.mp3"),
      signal,
    );
    if (!mixed) throw new Error("Recovery audio rendering failed");
    return await runContentTranscriptionFinalPass(
      input,
      { audioFilePath: mixed },
      { ensureTempDir: async () => directory },
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}
async function writePcmInterval(
  handle: import("node:fs/promises").FileHandle,
  bytes: Uint8Array,
  position: number,
) {
  let written = 0;
  while (written < bytes.byteLength) {
    const result = await handle.write(
      bytes,
      written,
      bytes.byteLength - written,
      position + written,
    );
    if (result.bytesWritten === 0)
      throw new Error("PCM write made no progress");
    written += result.bytesWritten;
  }
}
async function writeVerifiedTracks(
  content: RecoveryContent,
  reader: RecoveryReader,
  directory: string,
  signal: AbortSignal,
) {
  const tracks = new Map<string, { filePath: string }>();
  const lastEnd = new Map<string, number>();
  for (const item of content.verified.filter((row) => row.kind === "audio")) {
    if (
      item.coverage.kind !== "known" ||
      item.format.sampleRate !== 48000 ||
      item.format.channels !== 2 ||
      item.object.byteLength > 64 * 1024 * 1024
    )
      throw new InvalidRecoveryContent("Finalized PCM layout unavailable");
    const bytes = await reader.readVerifiedObject(item.object, signal);
    if (!bytes)
      throw new InvalidRecoveryContent("Finalized PCM verification changed");
    const filePath = path.join(
      directory,
      `${createHash("sha256").update(item.sourceId).digest("hex")}.pcm`,
    );
    const handle = await fs.open(
      filePath,
      tracks.has(item.sourceId) ? "r+" : "w+",
    );
    tracks.set(item.sourceId, { filePath });
    let cursor = 0;
    try {
      for (const interval of item.coverage.intervals) {
        signal.throwIfAborted();
        if (interval.startOffsetMs + interval.durationMs > 2 * 60 * 60 * 1000)
          throw new InvalidRecoveryContent(
            "Finalized PCM exceeds recording duration",
          );
        if (interval.startOffsetMs < (lastEnd.get(item.sourceId) ?? 0))
          throw new InvalidRecoveryContent(
            "Overlapping finalized PCM intervals",
          );
        lastEnd.set(
          item.sourceId,
          interval.startOffsetMs + interval.durationMs,
        );
        const length = Math.round((interval.durationMs * 192) / 4) * 4;
        const position = Math.round((interval.startOffsetMs * 192) / 4) * 4;
        const intervalBytes = bytes.subarray(cursor, cursor + length);
        if (intervalBytes.byteLength !== length)
          throw new InvalidRecoveryContent(
            "Finalized PCM interval exceeds saved bytes",
          );
        await writePcmInterval(handle, intervalBytes, position);
        cursor += length;
      }
      if (cursor !== bytes.byteLength)
        throw new InvalidRecoveryContent(
          "Finalized PCM coverage size mismatch",
        );
    } finally {
      await handle.close();
    }
  }
  return [...tracks.values()];
}
type FinalPassOutcome =
  "acknowledged" | "fallback" | "disabled" | "not_applicable";
type CleanupOutcome = "acknowledged" | "fallback" | "disabled";

async function applyOriginalFinalPass(
  content: RecoveryContent,
  reader: RecoveryReader,
  files: AudioFileData[],
  signal: AbortSignal,
  effect: TranscriptionContentInput["effect"],
  runFinalPass: boolean,
): Promise<FinalPassOutcome> {
  if (!originalSettings(content).transcription.finalPassEnabled)
    return "disabled";
  if (!runFinalPass || !completeVerifiedAudio(content)) return "not_applicable";
  const result = await originalFinalPass(
    content,
    reader,
    files,
    signal,
    effect,
  );
  return result.fallbackApplied ? "fallback" : "acknowledged";
}

/**
 * Cleans a transcript with the meeting's saved cleanup prompt, model and
 * retention ratio. A provider failure keeps the original text.
 */
export async function cleanupWithSavedSettings(
  content: RecoveryContent,
  original: string,
  signal: AbortSignal,
): Promise<{ finalText: string; cleanup: CleanupOutcome }> {
  const settings = originalSettings(content);
  if (
    !original.trim() ||
    !settings.premiumTranscription.enabled ||
    !settings.premiumTranscription.cleanupEnabled
  )
    return { finalText: original, cleanup: "disabled" };
  const prompt = content.context.prompts.cleanup;
  if (
    !settings.processing ||
    prompt?.availability !== "available" ||
    content.context.cleanupRoleNames === undefined
  )
    throw new InvalidRecoveryContent("Original cleanup inputs unavailable");
  const prepared = compileSavedChatPrompt(prompt.value, {
    ...transcriptionVariables(content),
    transcription: original,
  });
  try {
    const cleaned = await cleanupContentTranscription(
      {
        meetingId: content.manifest.capture.meetingId,
        creator: { id: content.context.creatorId },
        guild: { id: content.manifest.capture.guildId },
        voiceChannel: { id: content.manifest.capture.channelId },
        signal,
      },
      prepared,
      settings.models.transcriptionCleanup,
    );
    signal.throwIfAborted();
    const finalText = retainCleanupTranscript(
      original,
      cleaned,
      settings.processing.cleanupMinimumRetainedLineRatio,
    );
    return {
      finalText,
      cleanup: finalText === cleaned ? "acknowledged" : "fallback",
    };
  } catch {
    signal.throwIfAborted();
    return { finalText: original, cleanup: "fallback" };
  }
}

export async function processRecoveryTranscript(
  content: RecoveryContent,
  reader: RecoveryReader,
  files: AudioFileData[],
  signal: AbortSignal,
  effect: TranscriptionContentInput["effect"],
  runFinalPass: boolean,
) {
  if (!files.length) return "";
  const finalPass = await applyOriginalFinalPass(
    content,
    reader,
    files,
    signal,
    effect,
    runFinalPass,
  );
  const { finalText, cleanup } = await cleanupWithSavedSettings(
    content,
    formattedTranscript(content, files),
    signal,
  );
  content.processing = { finalPass, cleanup, finalText };
  return finalText;
}
