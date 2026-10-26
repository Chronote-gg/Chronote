import type { Client, GuildMember, User } from "discord.js";
import { isDeepStrictEqual } from "node:util";
import { updateActiveObservation } from "@langfuse/tracing";
import type { MeetingData } from "../types/meeting-data";
import { TRANSCRIPTION_CLEANUP_LINES_DIFFERENCE_ISSUE } from "../constants";
import { resolveAudioFileText } from "../utils/audioTranscript";
import { formatParticipantLabel } from "../utils/participants";
import { captureRecordingTranscriptScope } from "./recordingContentService";
import { getMeetingProcessingSignal } from "./meetingProcessingLifetime";
import {
  prepareTranscriptionCleanup,
  cleanupContentTranscription,
  retainCleanupTranscript,
  type PreparedTranscriptionCleanup,
} from "./transcriptionCleanupService";

const TRANSCRIPTION_HEADER =
  `NOTICE: Transcription is automatically generated and may not be perfectly accurate!\n` +
  `-----------------------------------------------------------------------------------\n`;

export type CompileTranscriptionsOptions = {
  includeCues?: boolean;
  cleanupAcknowledged?: (
    outcome: "acknowledged" | "fallback" | "disabled",
  ) => void;
};
export type MeetingTranscriptCompiler = (
  options?: CompileTranscriptionsOptions,
) => Promise<string>;

type Segment = { userId: string; timestamp: number; text: string };
type CleanupKey = {
  transcription: string;
  messages: PreparedTranscriptionCleanup["prompt"]["messages"];
  provenance: PreparedTranscriptionCleanup["prompt"]["langfusePrompt"];
  model: PreparedTranscriptionCleanup["model"];
  minimumLineRatio: number;
};
type CompilationLifetime = {
  accepted?: { key: CleanupKey; text: string };
};

function speakerFallbackName(
  member: GuildMember | undefined,
  user: User | undefined,
  userId: string,
): string {
  return (
    member?.nickname ||
    member?.user.globalName ||
    member?.user.username ||
    user?.globalName ||
    user?.username ||
    userId
  );
}
function formatSegment(client: Client, meeting: MeetingData, segment: Segment) {
  const participant = meeting.participants.get(segment.userId);
  const member = meeting.guild.members.cache.get(segment.userId);
  const user = client.users.cache.get(segment.userId);
  const fallbackName = speakerFallbackName(member, user, segment.userId);
  const fallbackUsername = member?.user.username || user?.username || undefined;
  const speakerLabel = formatParticipantLabel(participant, {
    includeUsername: true,
    fallbackName,
    fallbackUsername,
  });

  return `[${speakerLabel} @ ${new Date(
    segment.timestamp,
  ).toLocaleString()}]: ${segment.text}`;
}
function formatCapturedTranscript(
  client: Client,
  meeting: MeetingData,
  options: CompileTranscriptionsOptions,
): string {
  const inputFiles = [...meeting.audioData.audioFiles];
  captureRecordingTranscriptScope(meeting, inputFiles);
  const segments = inputFiles
    .map((fileData) => ({
      userId: fileData.userId,
      timestamp: fileData.timestamp,
      text: resolveAudioFileText(fileData),
    }))
    .filter((segment) => segment.text && segment.text.length > 0);
  if (options.includeCues && meeting.audioData.cueEvents) {
    for (const cue of meeting.audioData.cueEvents) {
      if (!cue.text) continue;
      segments.push({
        userId: cue.userId,
        timestamp: cue.timestamp,
        text: cue.text,
      });
    }
  }
  segments.sort((a, b) => a.timestamp - b.timestamp);
  return segments
    .map((segment) => formatSegment(client, meeting, segment))
    .join("\n");
}
function cleanupKey(
  prepared: PreparedTranscriptionCleanup,
  minimumLineRatio: number,
): CleanupKey {
  const provenance = prepared.prompt.langfusePrompt;
  return {
    transcription: prepared.transcription,
    messages: prepared.prompt.messages.map((message) => ({ ...message })),
    provenance: provenance
      ? {
          name: provenance.name,
          version: provenance.version,
          isFallback: provenance.isFallback,
        }
      : undefined,
    model: { ...prepared.model, params: { ...prepared.model.params } },
    minimumLineRatio,
  };
}
function recordReuse(hit: boolean): void {
  try {
    updateActiveObservation({
      metadata: { transcriptionCleanupReuseHit: hit },
    });
  } catch {
    // Diagnostics must never replace the compilation result.
  }
}
function acknowledgedText(
  meeting: MeetingData,
  options: CompileTranscriptionsOptions,
  text: string,
  outcome: "acknowledged" | "fallback" | "disabled",
): string {
  getMeetingProcessingSignal(meeting).throwIfAborted();
  options.cleanupAcknowledged?.(outcome);
  getMeetingProcessingSignal(meeting).throwIfAborted();
  return text;
}
async function compileTranscript(
  client: Client,
  meeting: MeetingData,
  options: CompileTranscriptionsOptions,
  lifetime: CompilationLifetime,
): Promise<string> {
  getMeetingProcessingSignal(meeting).throwIfAborted();
  const transcription = formatCapturedTranscript(client, meeting, options);
  if (transcription.length === 0)
    return acknowledgedText(meeting, options, transcription, "disabled");
  const premiumConfig = meeting.runtimeConfig?.premiumTranscription;
  if (!premiumConfig?.enabled || !premiumConfig.cleanupEnabled)
    return acknowledgedText(
      meeting,
      options,
      TRANSCRIPTION_HEADER + transcription,
      "disabled",
    );
  try {
    const prepared = await prepareTranscriptionCleanup(meeting, transcription);
    getMeetingProcessingSignal(meeting).throwIfAborted();
    const minimumLineRatio = TRANSCRIPTION_CLEANUP_LINES_DIFFERENCE_ISSUE;
    const key = cleanupKey(prepared, minimumLineRatio);
    const accepted = lifetime.accepted;
    const hit = accepted !== undefined && isDeepStrictEqual(accepted.key, key);
    recordReuse(hit);
    getMeetingProcessingSignal(meeting).throwIfAborted();
    if (hit)
      return acknowledgedText(
        meeting,
        options,
        TRANSCRIPTION_HEADER + accepted.text,
        "acknowledged",
      );
    const cleaned = await cleanupContentTranscription(
      meeting,
      prepared.prompt,
      prepared.model,
      meeting.langfuseParentSpanContext,
    );
    getMeetingProcessingSignal(meeting).throwIfAborted();
    const retained = retainCleanupTranscript(
      transcription,
      cleaned,
      minimumLineRatio,
    );
    if (retained === cleaned) lifetime.accepted = { key, text: retained };
    return acknowledgedText(
      meeting,
      options,
      TRANSCRIPTION_HEADER + retained,
      retained === cleaned ? "acknowledged" : "fallback",
    );
  } catch (error) {
    getMeetingProcessingSignal(meeting).throwIfAborted();
    console.error("Transcription cleanup failed, returning original:", error);
    return acknowledgedText(
      meeting,
      options,
      TRANSCRIPTION_HEADER + transcription,
      "fallback",
    );
  }
}
export function createMeetingTranscriptCompiler(
  client: Client,
  meeting: MeetingData,
): MeetingTranscriptCompiler {
  const lifetime: CompilationLifetime = {};
  return (options = {}) =>
    compileTranscript(client, meeting, options, lifetime);
}
export function compileTranscriptions(
  client: Client,
  meeting: MeetingData,
  options: CompileTranscriptionsOptions = {},
): Promise<string> {
  return createMeetingTranscriptCompiler(client, meeting)(options);
}
