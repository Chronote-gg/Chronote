import { z } from "zod";
import type { MeetingHistory } from "../types/db";
import type { MeetingNotesInput } from "../types/meeting-data";
import type {
  MeetingProcessingOutcome,
  TranscriptionOutcome,
} from "../types/meetingProcessing";
import type {
  ProcessingRetryFailureReason,
  ProcessingRetryJob,
  ProcessingRetryStage,
} from "../types/meetingProcessingRetry";
import type { TranscriptPayload, TranscriptSegment } from "../types/transcript";
import {
  INTERRUPTED_CAPTURE_NOTICE,
  InvalidRecoveryContent,
  readRecoveryContent,
  recoveryNotesInput,
  retranscribeOmittedRanges,
  TranscriptOverlapUnknown,
  type RecoveryContent,
  type RecoveryReader,
} from "./meetingRecoveryContent";
import {
  ensureMeetingNotes,
  ensureMeetingSummaries,
} from "./meetingNotesService";
import {
  buildCurrentNotesInput,
  cleanupWithCurrentSettings,
} from "./processingRetryNotesInput";
import {
  retryTranscriptKey,
  storeRetryTranscript,
  transcribeMixedRecording,
  UNATTRIBUTED_TRANSCRIPT_NOTICE,
} from "./processingRetryTranscript";
import { hasUsableTranscript } from "./processingRetryEligibility";
import { cleanupWithSavedSettings } from "./recoveryTranscriptionProcessing";
import { fetchJsonFromS3 } from "./storageService";
import type { TranscriptionContentInput } from "./transcriptionService";

type Sources = Pick<ProcessingRetryJob, "settingsSource" | "transcriptSource">;
export type ProcessingRetryChanges = {
  processing: MeetingProcessingOutcome;
  notes?: string;
  summarySentence?: string;
  summaryLabel?: string;
  meetingName?: string;
  transcriptS3Key?: string;
};
export type ProcessingRetryRun =
  | ({ kind: "succeeded"; changes: ProcessingRetryChanges } & Sources)
  | ({ kind: "failed"; reason: ProcessingRetryFailureReason } & Sources);
type RunInput = {
  history: MeetingHistory;
  job: ProcessingRetryJob;
  signal: AbortSignal;
  effect: TranscriptionContentInput["effect"];
  reader: RecoveryReader;
};
type Transcript = {
  text: string;
  source: ProcessingRetryJob["transcriptSource"];
  key?: string;
};

class RetryFailure extends Error {
  constructor(readonly reason: ProcessingRetryFailureReason) {
    super(reason);
  }
}

/** The same classes the recovery worker treats as an invalid saved payload. */
function unreadable(error: unknown) {
  return (
    error instanceof InvalidRecoveryContent ||
    error instanceof z.ZodError ||
    error instanceof SyntaxError
  );
}

async function readCheckpoint(input: RunInput) {
  if (!input.history.checkpoint) return undefined;
  try {
    return await readRecoveryContent(input.history, input.reader, input.signal);
  } catch (error) {
    if (unreadable(error)) return undefined;
    throw error;
  }
}

/** Undefined sends the retry to the mixed recording. */
async function checkpointTranscript(
  input: RunInput,
  content: RecoveryContent,
): Promise<(Transcript & { segments: TranscriptSegment[] }) | undefined> {
  try {
    const result = await retranscribeOmittedRanges(
      content,
      input.reader,
      input.signal,
      input.effect,
    );
    if (result.retranscribedRanges > 0)
      return { ...result, source: "checkpoint" };
  } catch (error) {
    // Provider-side errors, parse failures included, fail the stage.
    if (
      !(error instanceof InvalidRecoveryContent) &&
      !(error instanceof TranscriptOverlapUnknown)
    )
      throw error;
    return undefined;
  }
  // Checkpoint audio that could not be verified may still be in the mixed recording.
  if (content.missing.length && input.history.audioS3Key) return undefined;
  throw new RetryFailure("nothing_to_retry");
}

async function freshTranscript(
  input: RunInput,
  content: RecoveryContent | undefined,
): Promise<Transcript & { segments?: TranscriptSegment[] }> {
  const fromCheckpoint =
    content && (await checkpointTranscript(input, content));
  if (fromCheckpoint) return fromCheckpoint;
  const audioS3Key = input.history.audioS3Key;
  if (!audioS3Key)
    throw new RetryFailure(
      input.history.checkpoint ? "invalid_snapshot" : "source_missing",
    );
  const mixed = await input.effect(() =>
    transcribeMixedRecording(audioS3Key, input.signal),
  );
  if (mixed === "source_missing") throw new RetryFailure("source_missing");
  return {
    text: await cleanupMixedTranscript(input, content, mixed.text),
    source: "mixed",
  };
}

/**
 * Cleanup is part of normal transcript production, so a retry keeps it. It
 * uses the saved settings when the checkpoint holds usable ones.
 */
async function cleanupMixedTranscript(
  input: RunInput,
  content: RecoveryContent | undefined,
  text: string,
): Promise<string> {
  if (content) {
    try {
      const saved = await input.effect(() =>
        cleanupWithSavedSettings(content, text, input.signal),
      );
      return saved.finalText;
    } catch (error) {
      if (!(error instanceof InvalidRecoveryContent)) throw error;
    }
  }
  return input.effect(() =>
    cleanupWithCurrentSettings(input.history, text, input.signal),
  );
}

/** A previous claimant of this job may already have stored its transcript. */
async function retryTranscript(
  input: RunInput,
  content: RecoveryContent | undefined,
): Promise<Transcript> {
  const key = retryTranscriptKey(input.history, input.job.jobId);
  const stored = await fetchJsonFromS3<TranscriptPayload>(key, input.signal);
  if (stored)
    return {
      text: stored.text ?? "",
      // Only a checkpoint retry carries attributed segments.
      source: stored.segments ? "checkpoint" : "mixed",
      key,
    };
  const { text, segments, source } = await freshTranscript(input, content);
  await input.effect(() =>
    storeRetryTranscript(
      key,
      { generatedAt: new Date().toISOString(), segments, text },
      input.signal,
    ),
  );
  return { text, source, key };
}

async function storedTranscript(input: RunInput): Promise<Transcript> {
  const key = input.history.transcriptS3Key;
  const payload = key
    ? await fetchJsonFromS3<TranscriptPayload>(key, input.signal)
    : undefined;
  if (payload?.text === undefined) throw new RetryFailure("source_missing");
  return { text: payload.text, source: "existing" };
}

/**
 * A partial transcript is retried to probe for lost speech, but the probe
 * finding none must not block notes or summary that failed on their own.
 */
function generationCanUseStored(error: unknown, history: MeetingHistory) {
  const processing = history.processing ?? {};
  return (
    error instanceof RetryFailure &&
    error.reason === "nothing_to_retry" &&
    (processing.notes === "failed" || processing.summary === "failed") &&
    hasUsableTranscript(history, processing)
  );
}

async function sourceTranscript(
  input: RunInput,
  content: RecoveryContent | undefined,
): Promise<Transcript> {
  if (!input.job.stages.includes("transcription"))
    return storedTranscript(input);
  try {
    return await retryTranscript(input, content);
  } catch (error) {
    if (!generationCanUseStored(error, input.history)) throw error;
    return storedTranscript(input);
  }
}

function transcriptionOutcome(
  transcript: Transcript,
  history: MeetingHistory,
  content: RecoveryContent | undefined,
): TranscriptionOutcome {
  if (!transcript.text.trim()) return "empty";
  if (history.capture?.kind === "interrupted") return "partial";
  if (transcript.source === "mixed") return "ready";
  return !content || content.missing.length || content.context.captureIncomplete
    ? "partial"
    : "ready";
}

async function notesInputFor(
  input: RunInput,
  content: RecoveryContent | undefined,
  transcript: string,
): Promise<{
  notesInput: MeetingNotesInput;
  settingsSource: Sources["settingsSource"];
}> {
  const { history, signal } = input;
  const interrupted = history.capture?.kind === "interrupted";
  if (content) {
    try {
      const notesInput = recoveryNotesInput(
        history,
        content,
        transcript,
        signal,
        interrupted,
      );
      return {
        notesInput: {
          ...notesInput,
          meetingName: history.meetingName,
          // A retry names an unnamed meeting like a live run does.
          recovered: undefined,
          // A completed capture has no gaps for the recovery notice to describe.
          captureNotice: interrupted ? notesInput.captureNotice : undefined,
        },
        settingsSource: "snapshot",
      };
    } catch (error) {
      if (!(error instanceof InvalidRecoveryContent)) throw error;
    }
  }
  return {
    notesInput: {
      ...(await buildCurrentNotesInput(history, transcript, signal)),
      // Without readable saved content only the interruption itself is known.
      captureNotice: interrupted ? INTERRUPTED_CAPTURE_NOTICE : undefined,
    },
    settingsSource: "current",
  };
}

/**
 * Drops what the input copied from the row for every retried stage, so the
 * ensure functions regenerate it instead of returning the stored value.
 */
export function clearRetriedStages(
  input: Pick<
    MeetingNotesInput,
    "processing" | "notesText" | "summarySentence" | "summaryLabel"
  >,
  history: MeetingHistory,
  stages: ProcessingRetryStage[],
  transcription?: TranscriptionOutcome,
): void {
  const processing: MeetingProcessingOutcome = { ...input.processing };
  for (const stage of stages) delete processing[stage];
  processing.transcription = transcription ?? history.processing?.transcription;
  if (stages.includes("notes")) delete input.notesText;
  else {
    processing.notes = history.processing?.notes;
    input.notesText = history.notes;
  }
  if (stages.includes("summary")) {
    delete input.summarySentence;
    delete input.summaryLabel;
  }
  input.processing = processing;
}

async function generate(input: RunInput, notesInput: MeetingNotesInput) {
  const { stages } = input.job;
  if (stages.includes("notes"))
    await input.effect(() => ensureMeetingNotes(notesInput));
  if (stages.includes("summary"))
    await input.effect(() =>
      ensureMeetingSummaries(notesInput, notesInput.notesText),
    );
  const processing = notesInput.processing ?? {};
  if (processing.notes !== "generated" || processing.summary !== "generated")
    throw new RetryFailure("stage_failed");
}

function changesFrom(
  input: RunInput,
  notesInput: MeetingNotesInput,
  transcriptS3Key: string | undefined,
): ProcessingRetryChanges {
  const { history, job } = input;
  const renamed = !history.meetingName && notesInput.meetingName;
  return {
    processing: notesInput.processing ?? {},
    ...(job.stages.includes("notes") ? { notes: notesInput.notesText } : {}),
    summarySentence: notesInput.summarySentence,
    summaryLabel: notesInput.summaryLabel,
    ...(renamed ? { meetingName: notesInput.meetingName } : {}),
    ...(transcriptS3Key ? { transcriptS3Key } : {}),
  };
}

async function runStages(
  input: RunInput,
  sources: Sources,
): Promise<ProcessingRetryChanges> {
  const content = await readCheckpoint(input);
  const transcript = await sourceTranscript(input, content);
  sources.transcriptSource = transcript.source;
  const { notesInput, settingsSource } = await notesInputFor(
    input,
    content,
    transcript.text,
  );
  sources.settingsSource = settingsSource;
  clearRetriedStages(
    notesInput,
    input.history,
    input.job.stages,
    transcript.source !== "existing"
      ? transcriptionOutcome(transcript, input.history, content)
      : undefined,
  );
  if (transcript.source === "mixed")
    notesInput.captureNotice = [
      notesInput.captureNotice,
      UNATTRIBUTED_TRANSCRIPT_NOTICE,
    ]
      .filter(Boolean)
      .join("\n\n");
  await generate(input, notesInput);
  return changesFrom(input, notesInput, transcript.key);
}

/**
 * Re-runs the failed stages with the existing generation code and returns the
 * content to save, or why nothing may be saved. Saving is the caller's job.
 */
export async function runProcessingRetryStages(
  input: RunInput,
): Promise<ProcessingRetryRun> {
  const sources: Sources = {
    settingsSource: input.job.settingsSource,
    transcriptSource: input.job.transcriptSource,
  };
  try {
    const changes = await runStages(input, sources);
    return { kind: "succeeded", changes, ...sources };
  } catch (error) {
    // A lost lease or shutdown is not an outcome of this job.
    input.signal.throwIfAborted();
    if (error instanceof RetryFailure)
      return { kind: "failed", reason: error.reason, ...sources };
    console.error("Processing retry stage failed", {
      meetingId: input.history.meetingId,
      jobId: input.job.jobId,
      error,
    });
    return { kind: "failed", reason: "stage_failed", ...sources };
  }
}
