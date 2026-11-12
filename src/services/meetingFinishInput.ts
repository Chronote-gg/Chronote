import { promises as fs } from "node:fs";
import path from "node:path";
import type { Client } from "discord.js";
import type { MeetingHistory } from "../types/db";
import type { MeetingData, MeetingNotesInput } from "../types/meeting-data";
import type { MeetingProcessingOutcome } from "../types/meetingProcessing";
import type { Participant } from "../types/participants";
import type { TranscriptPayload, TranscriptSegment } from "../types/transcript";
import {
  buildMeetingRecording,
  captionMeetingImagesStep,
  compileCancelledTranscript,
  compileFinalTranscript,
  compileTranscriptForUpload,
  resolveMeetingCancellation,
  settleCapturedAudio,
  type MeetingCancellation,
} from "./meetingCaptureWrapUp";
import { createMeetingTranscriptCompiler } from "./transcriptCompilationService";
import { assertMeetingProcessingSucceeded } from "../utils/meetingProcessing";
import {
  liveMeetingNotesInput,
  prepareLiveMeetingNotesInput,
} from "./liveMeetingNotesService";
import {
  ensureSpeakerParticipants,
  meetingTranscriptObject,
} from "./uploadService";
import { ensureTempBaseDir, getMeetingTempDir } from "./tempFileService";
import {
  liveShapedNotesInput,
  readRecoveryContent,
  recoveredTranscriptionOutcome,
  recoverTranscript,
  recoveryNotesInput,
  type RecoveryContent,
  type RecoveryReader,
} from "./meetingRecoveryContent";
import { writeVerifiedTracks } from "./recoveryTranscriptionProcessing";
import { renderMixedPcmTracks } from "./mixedPcmService";
import {
  completionSnapshot,
  resolveCompletionPolicy,
} from "./meetingCompletionPolicyService";
import type { CompletionPolicy } from "../types/meetingCompletionPolicy";
import { decideAutoRecordCancellation } from "./autoRecordCancellationService";
import type { ChatEntry } from "../types/chat";
import type { RecordingLimitState } from "./recordingLimitService";
import { createRecordingCheckpointService } from "./recordingCheckpointService";
import { fetchJsonFromS3 } from "./storageService";
import { formatUserMention } from "../utils/participants";
import { summarizeCaptureCoverage } from "../utils/meetingCaptureNotice";
import type { CaptureCoverageSummary } from "../types/recordingCheckpoint";

export type FinishInput = {
  source: "normal" | "recovery";
  notesInput: MeetingNotesInput;
  /** "" when nothing usable was said or transcription is off. */
  transcript: string;
  /** Absent when the transcript key is already recorded. */
  transcriptUpload?: { key: string; body: Buffer };
  processing: MeetingProcessingOutcome;
  participants: Participant[];
  hasSavedAudio: boolean;
  cancel?: { reason?: string };
  /**
   * Auto-record notices a cancellation deletes. The normal loader's only
   * (recovery has no ids), and carried whatever the loader decided, because a
   * cancel close wrote on the row overrides a loader that would proceed.
   */
  noticeMessageIds?: string[];
  /** The completion policy snapshot the proceed-or-cancel decision is written onto. */
  completionPolicy?: CompletionPolicy;
  /** Live chat, normal loader only; a checkpoint keeps chat context text, not entries. */
  chatEntries?: ChatEntry[];
  /** The in-meeting limit notice state, so the weekly notice does not repeat it. */
  recordingLimitNotice?: RecordingLimitState;
  recordingPath?: string;
  /** Deleted by the pipeline once the meeting is finished. */
  localDirectory?: string;
  /** Saved audio as the checkpoint confirms it, which an interrupted meeting's notice reports. */
  captureCoverage?: CaptureCoverageSummary;
};

const MS_PER_SECOND = 1000;

const runEffect = <T>(run: () => Promise<T>): Promise<T> => run();

function withSignal(
  input: MeetingNotesInput,
  signal: AbortSignal,
): MeetingNotesInput {
  return {
    ...input,
    signal: input.signal ? AbortSignal.any([input.signal, signal]) : signal,
  };
}

function cancelReason(
  meeting: MeetingData,
  cancellation: Exclude<MeetingCancellation, { kind: "proceed" }>,
): NonNullable<FinishInput["cancel"]> {
  return {
    reason:
      cancellation.kind === "automatic"
        ? cancellation.decision.reason
        : meeting.cancellationReason,
  };
}

async function normalFinishInput(
  meeting: MeetingData,
  fields: Pick<FinishInput, "notesInput" | "transcript" | "recordingPath"> &
    Pick<FinishInput, "cancel">,
): Promise<FinishInput> {
  await ensureSpeakerParticipants(meeting);
  let transcriptUpload: FinishInput["transcriptUpload"];
  if (fields.transcript && !meeting.transcriptS3Key) {
    const object = meetingTranscriptObject(meeting, fields.transcript);
    transcriptUpload = { key: object.key, body: Buffer.from(object.body) };
  }
  return {
    source: "normal",
    ...fields,
    ...(transcriptUpload ? { transcriptUpload } : {}),
    processing: meeting.processing ?? {},
    participants: [...meeting.participants.values()],
    // A live capture with no speech is an empty recording, not a missing one:
    // the empty-transcript rules apply, never the silent no-audio failure.
    hasSavedAudio: true,
    completionPolicy: completionSnapshot(meeting),
    chatEntries: meeting.chatLog,
    noticeMessageIds: meeting.messagesToDelete,
    recordingLimitNotice: meeting.recordingLimitNotice,
    localDirectory: getMeetingTempDir(meeting),
    ...(meeting.recordingPreservationFailure?.coverage
      ? {
          captureCoverage: summarizeCaptureCoverage(
            meeting.recordingPreservationFailure.coverage,
          ),
        }
      : {}),
  };
}

/**
 * Builds the finish input from what the closing worker holds: the in-memory
 * transcript compile, the final pass and the locally mixed recording.
 */
export async function loadNormalFinishInput(
  meeting: MeetingData,
  client: Client,
  signal: AbortSignal,
): Promise<FinishInput> {
  signal.throwIfAborted();
  await settleCapturedAudio(meeting, signal);
  signal.throwIfAborted();
  const cancellation = await resolveMeetingCancellation(meeting);
  signal.throwIfAborted();
  if (cancellation.kind !== "proceed") {
    const transcript =
      (await compileCancelledTranscript(client, meeting)) ?? "";
    signal.throwIfAborted();
    return normalFinishInput(meeting, {
      notesInput: withSignal(liveMeetingNotesInput(meeting), signal),
      transcript,
      recordingPath: meeting.audioData.outputFileName,
      cancel: cancelReason(meeting, cancellation),
    });
  }

  const recordingPath = await buildMeetingRecording(meeting);
  signal.throwIfAborted();
  let transcript = "";
  if (meeting.transcribeMeeting) {
    const compile = createMeetingTranscriptCompiler(client, meeting);
    await compileFinalTranscript(meeting, compile, recordingPath);
    // Failed, partial-on-complete or lossy transcription throws, as the old
    // path does, so the attempt is retried rather than saved as terminal.
    assertMeetingProcessingSucceeded(meeting);
    signal.throwIfAborted();
    if (meeting.generateNotes) await captionMeetingImagesStep(meeting);
    signal.throwIfAborted();
    transcript = await compileTranscriptForUpload(meeting, compile);
    signal.throwIfAborted();
  }
  const notesInput = await prepareLiveMeetingNotesInput(meeting);
  signal.throwIfAborted();
  return normalFinishInput(meeting, {
    notesInput: withSignal(notesInput, signal),
    transcript,
    recordingPath,
  });
}

/** Shapes the input from the row alone, for outcomes that generate no notes. */
function savedRowNotesInput(
  history: MeetingHistory,
  signal: AbortSignal,
  finalTranscript = "",
): MeetingNotesInput {
  return {
    meetingId: history.meetingId,
    guildId: history.guildId,
    channelId: history.channelId,
    generateNotes: history.generateNotes,
    transcribeMeeting: history.transcribeMeeting,
    startTime: new Date(history.timestamp),
    finalTranscript,
    meetingName: history.meetingName,
    tags: history.tags,
    participants: new Map(history.participants.map((p) => [p.id, p])),
    attendance: new Set(
      history.participants.map((p) => formatUserMention(p.id)),
    ),
    creator: { id: history.meetingCreatorId ?? "" },
    guild: { id: history.guildId, name: "", description: "" },
    voiceChannel: { id: history.channelId, name: "" },
    signal,
  };
}

function withoutSavedAudio(
  history: MeetingHistory,
  signal: AbortSignal,
): FinishInput {
  return {
    source: "recovery",
    notesInput: savedRowNotesInput(history, signal),
    transcript: "",
    processing: {},
    participants: history.participants,
    hasSavedAudio: false,
  };
}

/** The cancel the policy decides, evaluating an undecided auto-recording over its spoken text. */
async function recoveredCancel(
  history: MeetingHistory,
  snapshot: CompletionPolicy | undefined,
  policy: ReturnType<typeof resolveCompletionPolicy>,
  spokenText: string | undefined,
  signal: AbortSignal,
): Promise<FinishInput["cancel"]> {
  if (policy === "cancel") return {};
  if (policy !== "unknown" || !snapshot) return undefined;
  return recoveredAutoRecordCancellation(history, snapshot, spokenText, signal);
}

/**
 * The row alone does not prove silence: close also records a complete capture
 * when its final flush failed and it kept the audio for a local finish. Only a
 * completed final flush leaves a manifest recording the capture as complete.
 */
function endedCompleteSilent(
  history: MeetingHistory,
  content: RecoveryContent,
) {
  return (
    history.capture?.kind === "complete" &&
    content.manifest.captureState.kind === "complete"
  );
}

/**
 * A capture the checkpoint proves ended complete, with no audio piece saved,
 * is a recording in which nobody spoke, so it takes the empty-transcript rules
 * a live capture with no speech takes, never the silent no-audio failure.
 */
async function emptyRecording(
  history: MeetingHistory,
  content: RecoveryContent,
  signal: AbortSignal,
): Promise<FinishInput> {
  const snapshot = history.completionPolicy ?? content.context.completion;
  const policy = resolveCompletionPolicy(snapshot, false);
  const transcribe =
    policy !== "cancel" && content.manifest.capture.requested.transcribeMeeting;
  const cancel = await recoveredCancel(history, snapshot, policy, "", signal);
  signal.throwIfAborted();
  const processing: MeetingProcessingOutcome = transcribe
    ? { transcription: "empty" }
    : {};
  const notesInput = savedRowNotesInput(history, signal);
  notesInput.processing = processing;
  return {
    source: "recovery",
    notesInput,
    transcript: "",
    processing,
    participants: content.context.participants,
    hasSavedAudio: true,
    captureCoverage: summarizeCaptureCoverage(content.coverage),
    ...(cancel ? { cancel } : {}),
  };
}

/** The recorded terminal capture kind, else the one the manifest proves. */
function interruptedCapture(history: MeetingHistory, content: RecoveryContent) {
  if (history.capture?.kind === "complete") return false;
  if (history.capture?.kind === "interrupted") return true;
  return content.manifest.captureState.kind !== "complete";
}

type RecoveredTranscript = {
  text: string;
  upload?: FinishInput["transcriptUpload"];
  /**
   * The segments' own text joined as the live path joins per-file text, with
   * no speaker or time prefix. Absent when a stored transcript has no segments.
   */
  spokenText?: string;
};

const joinSegmentText = (segments: TranscriptSegment[]) =>
  segments
    .map((segment) => segment.text)
    .filter((text): text is string => Boolean(text?.trim()))
    .join(" ");

async function recoveredTranscript(
  history: MeetingHistory,
  content: RecoveryContent,
  reader: RecoveryReader,
  signal: AbortSignal,
): Promise<RecoveredTranscript> {
  if (history.transcriptS3Key) {
    const stored = await fetchJsonFromS3<TranscriptPayload>(
      history.transcriptS3Key,
      signal,
    );
    if (stored?.text !== undefined)
      return {
        text: stored.text,
        ...(stored.segments
          ? { spokenText: joinSegmentText(stored.segments) }
          : {}),
      };
  }
  const { text, segments } = await recoverTranscript(
    content,
    reader,
    signal,
    runEffect,
  );
  const spokenText = joinSegmentText(segments);
  if (!text.trim() || history.transcriptS3Key) return { text, spokenText };
  const body = Buffer.from(
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      guildId: history.guildId,
      channelId: history.channelId,
      meetingId: history.meetingId,
      text,
      processing: content.processing,
      segments,
      timingBasis: "sample_cursor_with_observed_gaps",
      coverage: content.coverage,
    }),
  );
  return {
    text,
    spokenText,
    upload: {
      key: `${content.manifest.artifactFolder}transcript.json`,
      body,
    },
  };
}

/**
 * Mixes the verified pieces into a temporary directory directly under the
 * shared temp base, so deleting it removes everything the loader created.
 * The recording upload is best effort, so a failed render yields no recording
 * rather than failing the finish; only cancellation propagates.
 */
async function renderRecoveredRecording(
  history: MeetingHistory,
  content: RecoveryContent,
  reader: RecoveryReader,
  signal: AbortSignal,
): Promise<Pick<FinishInput, "recordingPath" | "localDirectory">> {
  const directory = await fs.mkdtemp(
    path.join(await ensureTempBaseDir(), `recovery-mix-${history.meetingId}-`),
  );
  try {
    const tracks = await writeVerifiedTracks(
      content,
      reader,
      directory,
      signal,
    );
    signal.throwIfAborted();
    const recordingPath = await renderMixedPcmTracks(
      tracks,
      path.join(directory, "mixed.mp3"),
      signal,
    );
    return {
      ...(recordingPath ? { recordingPath } : {}),
      localDirectory: directory,
    };
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    signal.throwIfAborted();
    console.error("Recovered recording render failed", {
      guildId: history.guildId,
      meetingId: history.meetingId,
      error,
    });
    return {};
  }
}

/**
 * The normal loader's automatic evaluation for an undecided auto-recording,
 * over the row's snapshot and the recovered content. A check that cannot run
 * or fails proceeds: it must never fail the finish or cancel by default.
 * The model configuration is the role default, since the checkpoint freezes
 * no cancellation model. Only a meeting with no chat messages is evaluated:
 * the checkpoint keeps formatted chat context, not the messages, and the
 * model must not judge content it cannot see. An abort of the attempt is
 * rethrown, never treated as proceed.
 */
async function recoveredAutoRecordCancellation(
  history: MeetingHistory,
  snapshot: CompletionPolicy,
  transcriptText: string | undefined,
  signal: AbortSignal,
): Promise<FinishInput["cancel"]> {
  if (!snapshot.isAutoRecording || snapshot.dismissed) return undefined;
  try {
    if (snapshot.elapsedMilliseconds === undefined)
      throw new Error("Original auto-record duration is unavailable");
    if (transcriptText === undefined)
      throw new Error("Stored transcript has no segments to evaluate");
    if (snapshot.chatMessageCount > 0)
      throw new Error("Original chat messages are unavailable");
    const decision = await decideAutoRecordCancellation({
      policy: snapshot.policy,
      durationSeconds: Math.floor(snapshot.elapsedMilliseconds / MS_PER_SECOND),
      chatMessageCount: snapshot.chatMessageCount,
      content: async () => ({ transcriptText, chatLines: [] }),
      meetingId: history.meetingId,
      guildId: history.guildId,
      channelId: history.channelId,
      signal,
    });
    return decision.cancel ? { reason: decision.reason } : undefined;
  } catch (error) {
    signal.throwIfAborted();
    console.warn(
      "Recovered auto-record cancellation check failed; proceeding",
      {
        guildId: history.guildId,
        meetingId: history.meetingId,
        error,
      },
    );
    return undefined;
  }
}

/**
 * Rebuilds the finish input from the history row and the checkpoint in S3,
 * transcribing only audio pieces that have no transcript yet.
 */
export async function loadRecoveryFinishInput(
  history: MeetingHistory,
  signal: AbortSignal,
  reader: RecoveryReader = createRecordingCheckpointService(),
): Promise<FinishInput> {
  signal.throwIfAborted();
  if (!history.checkpoint) return withoutSavedAudio(history, signal);
  const content = await readRecoveryContent(history, reader, signal);
  signal.throwIfAborted();
  if (!content.verified.some((item) => item.kind === "audio"))
    return endedCompleteSilent(history, content)
      ? emptyRecording(history, content, signal)
      : withoutSavedAudio(history, signal);

  const interrupted = interruptedCapture(history, content);
  const snapshot = history.completionPolicy ?? content.context.completion;
  const policy = resolveCompletionPolicy(snapshot, interrupted);
  const transcribe =
    policy !== "cancel" && content.manifest.capture.requested.transcribeMeeting;
  const transcript = transcribe
    ? await recoveredTranscript(history, content, reader, signal)
    : { text: "", spokenText: "" };
  signal.throwIfAborted();
  // "unknown" is never returned for an interrupted capture, which always proceeds.
  const cancel = await recoveredCancel(
    history,
    snapshot,
    policy,
    transcript.spokenText,
    signal,
  );
  signal.throwIfAborted();

  const spoken = transcribe && Boolean(transcript.text.trim());
  // Saved generation inputs are read only when notes will be generated, as
  // today's recovery does, so unavailable prompts cannot fail other outcomes.
  const notesInput =
    !cancel && spoken && content.manifest.capture.requested.generateNotes
      ? liveShapedNotesInput(
          recoveryNotesInput(
            history,
            content,
            transcript.text,
            signal,
            interrupted,
          ),
          history,
          interrupted,
        )
      : savedRowNotesInput(history, signal, transcript.text);
  const processing: MeetingProcessingOutcome = !transcribe
    ? {}
    : !spoken
      ? { transcription: "empty" }
      : (notesInput.processing ?? {
          transcription: recoveredTranscriptionOutcome(content, interrupted),
        });
  notesInput.processing = processing;

  const recording = await renderRecoveredRecording(
    history,
    content,
    reader,
    signal,
  );
  return {
    source: "recovery",
    notesInput,
    transcript: transcript.text,
    ...(transcript.upload ? { transcriptUpload: transcript.upload } : {}),
    processing,
    participants: content.context.participants,
    hasSavedAudio: true,
    captureCoverage: summarizeCaptureCoverage(content.coverage),
    ...(cancel ? { cancel } : {}),
    ...recording,
  };
}
