import type { Client } from "discord.js";
import {
  buildMixedAudio,
  closeOutputFile,
  waitForAudioOnlyFinishProcessing,
  waitForFinishProcessing,
} from "../audio";
import {
  withMeetingEndStep,
  type MeetingEndStepOptions,
} from "../observability/meetingTrace";
import type { MeetingData } from "../types/meeting-data";
import { MEETING_END_REASONS } from "../types/meetingLifecycle";
import { getAudioTranscriptionFacts } from "../utils/audioTranscript";
import {
  assertMeetingProcessingSucceeded,
  classifyTranscription,
} from "../utils/meetingProcessing";
import { evaluateAutoRecordCancellation } from "./autoRecordCancellationService";
import { captionMeetingImages } from "./imageCaptionService";
import {
  completionSnapshot,
  resolveCompletionPolicy,
} from "./meetingCompletionPolicyService";
import {
  checkpointCompletedTranscription,
  guardRecordingFinalization,
} from "./recordingContentService";
import {
  compileTranscriptions,
  type MeetingTranscriptCompiler,
} from "./transcriptCompilationService";
import { runTranscriptionFinalPass } from "./transcriptionFinalPassService";

const DISMISSED_AUTO_RECORD_COMPLETE_MIN_DURATION_MS = 10 * 60 * 1000;
const DISMISSED_AUTO_RECORD_COMPLETE_MIN_CHAT_MESSAGES = 2;

async function runMeetingEndStep<T>(
  meeting: MeetingData,
  name: string,
  run: () => Promise<T>,
  options: MeetingEndStepOptions = {},
): Promise<T> {
  const startedAt = Date.now();
  const result = await withMeetingEndStep(meeting, name, run, options);
  const durationMs = Date.now() - startedAt;
  console.log(`Meeting end step completed: ${name} durationMs=${durationMs}`);
  return result;
}

function shouldFinalizeDismissedAutoRecording(meeting: MeetingData): boolean {
  if (!meeting.cancelled) return false;
  if (!meeting.isAutoRecording) return false;
  if (meeting.endReason !== MEETING_END_REASONS.DISMISSED) return false;
  if (!meeting.endTime) {
    throw new Error(
      "Dismissed auto-record finalization requires meeting.endTime",
    );
  }

  const originalPolicy = completionSnapshot(meeting);
  if (originalPolicy) {
    const decision = resolveCompletionPolicy(originalPolicy, false);
    if (decision === "unknown")
      throw new Error("Original dismissal policy is unavailable");
    return decision === "proceed";
  }
  const durationMs = meeting.endTime.getTime() - meeting.startTime.getTime();
  if (durationMs >= DISMISSED_AUTO_RECORD_COMPLETE_MIN_DURATION_MS) {
    return true;
  }

  const chatMessageCount = meeting.chatLog.filter(
    (entry) => entry.type === "message",
  ).length;
  return chatMessageCount >= DISMISSED_AUTO_RECORD_COMPLETE_MIN_CHAT_MESSAGES;
}

/**
 * Stops waiting, not the work, once the attempt is stopped. The wait starts
 * only after the abort check, so an already stopped attempt leaves none unhandled.
 */
function untilAborted<T>(
  start: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    start()
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

/** Waits for captured audio to be processed and closes the combined file. */
export async function settleCapturedAudio(
  meeting: MeetingData,
  signal: AbortSignal,
): Promise<void> {
  await runMeetingEndStep(meeting, "wait-audio-only", () =>
    waitForAudioOnlyFinishProcessing(meeting),
  );

  await runMeetingEndStep(meeting, "close-output-file", () =>
    closeOutputFile(meeting),
  );

  if (meeting.transcribeMeeting)
    await runMeetingEndStep(meeting, "wait-finalization-processing", () =>
      untilAborted(() => waitForFinishProcessing(meeting), signal),
    );
  assertMeetingProcessingSucceeded(meeting);
}

export type MeetingCancellation =
  | { kind: "proceed" }
  | { kind: "cancelled" }
  | { kind: "automatic"; decision: { cancel: boolean; reason?: string } };

/** Applies the dismissal rule, then the automatic auto-record evaluation. */
export async function resolveMeetingCancellation(
  meeting: MeetingData,
): Promise<MeetingCancellation> {
  const finalizeDismissedAutoRecording =
    shouldFinalizeDismissedAutoRecording(meeting);
  if (finalizeDismissedAutoRecording) {
    meeting.cancelled = false;
    meeting.cancellationReason = undefined;
  }

  if (meeting.cancelled) return { kind: "cancelled" };
  if (finalizeDismissedAutoRecording) return { kind: "proceed" };

  const decision = await runMeetingEndStep(
    meeting,
    "auto-record-cancellation",
    () => evaluateAutoRecordCancellation(meeting),
    {
      metadata: {
        audioFiles: meeting.audioData.audioFiles.length,
      },
    },
  );
  assertMeetingProcessingSucceeded(meeting);
  return decision.cancel
    ? { kind: "automatic", decision }
    : { kind: "proceed" };
}

/** Returns the mixed recording, or the combined file when no mix was built. */
export async function buildMeetingRecording(
  meeting: MeetingData,
): Promise<string> {
  const combinedAudioFile = meeting.audioData.outputFileName!;
  const mixedAudioFile = await runMeetingEndStep(
    meeting,
    "build-mixed-audio",
    () => buildMixedAudio(meeting),
    {
      metadata: {
        speakerTrackCount: meeting.audioData.speakerTracks?.size ?? 0,
      },
    },
  );
  return mixedAudioFile ?? combinedAudioFile;
}

/** How many audio files are still transcribing, or undefined when none are. */
function pendingTranscriptionCount(meeting: MeetingData): number | undefined {
  const transcriptionsReady = meeting.audioData.audioFiles.every(
    (file) => !file.processing,
  );
  if (transcriptionsReady) return undefined;
  return meeting.audioData.audioFiles.filter((file) => file.processing).length;
}

/**
 * Runs the final pass and compile, sets the final transcript and the
 * transcription outcome, and preserves the processed transcription.
 */
export async function compileFinalTranscript(
  meeting: MeetingData,
  compile: MeetingTranscriptCompiler,
  audioFilePath: string,
): Promise<void> {
  const pending = pendingTranscriptionCount(meeting);
  if (pending !== undefined) {
    console.log(
      `Waiting for transcriptions to finish: pending=${pending} meetingId=${meeting.meetingId}`,
    );
    await runMeetingEndStep(
      meeting,
      "wait-transcriptions",
      () => waitForFinishProcessing(meeting),
      {
        metadata: {
          pending,
        },
      },
    );
  }

  await meeting.recordingContentTask;
  checkpointCompletedTranscription(meeting);
  if (
    meeting.recordingCapture &&
    !(await meeting.recordingCapture.drainContent())
  )
    throw new Error("Completed transcript preservation failed");

  guardRecordingFinalization(meeting);
  const finalPassResult = await runMeetingEndStep(
    meeting,
    "transcription-final-pass",
    () => runTranscriptionFinalPass(meeting, { audioFilePath }),
  );
  console.log("Transcription final pass completed.", {
    meetingId: meeting.meetingId,
    ...finalPassResult,
  });

  let cleanupAcknowledged: "acknowledged" | "fallback" | "disabled" | undefined;
  const transcriptions = await runMeetingEndStep(
    meeting,
    "compile-transcriptions",
    () =>
      compile({
        cleanupAcknowledged: (outcome) => {
          cleanupAcknowledged = outcome;
        },
      }),
  );
  meeting.finalTranscript = transcriptions;
  const transcriptionStillPending = meeting.audioData.audioFiles.some(
    (file) => file.processing,
  );
  if (transcriptionStillPending) {
    console.error(
      "Cannot classify meeting transcription while required work is pending",
      { meetingId: meeting.meetingId },
    );
  }
  meeting.processing = {
    ...meeting.processing,
    transcription: transcriptionStillPending
      ? "failed"
      : classifyTranscription(getAudioTranscriptionFacts(meeting.audioData)),
  };

  if (!transcriptionStillPending && cleanupAcknowledged) {
    checkpointCompletedTranscription(meeting, {
      finalPass: !finalPassResult.enabled
        ? "disabled"
        : finalPassResult.fallbackApplied
          ? "fallback"
          : "acknowledged",
      cleanup: cleanupAcknowledged,
      finalText: transcriptions,
    });
    if (
      meeting.recordingCapture &&
      !(await meeting.recordingCapture.drainContent())
    )
      throw new Error("Processed transcription preservation failed");
  }
}

export function captionMeetingImagesStep(meeting: MeetingData) {
  return runMeetingEndStep(
    meeting,
    "caption-images",
    () => captionMeetingImages(meeting),
    {
      metadata: {
        chatEntries: meeting.chatLog.length,
      },
    },
  );
}

export function compileTranscriptForUpload(
  meeting: MeetingData,
  compile: MeetingTranscriptCompiler,
): Promise<string> {
  return runMeetingEndStep(meeting, "compile-transcriptions-upload", () =>
    compile({
      includeCues: true,
    }),
  );
}

/** Cancelled meetings keep a best-effort transcript without the final pass. */
export async function compileCancelledTranscript(
  client: Client,
  meeting: MeetingData,
): Promise<string | undefined> {
  if (!meeting.transcribeMeeting) return undefined;
  // Cancelled-meeting uploads are best-effort recovery artifacts, so we skip
  // the slower final transcription pass that only runs for fully finalized meetings.
  const pending = pendingTranscriptionCount(meeting);
  if (pending !== undefined) {
    console.log(
      `Waiting for cancelled meeting transcriptions to finish: pending=${pending} meetingId=${meeting.meetingId}`,
    );
    await runMeetingEndStep(meeting, "wait-cancelled-transcriptions", () =>
      waitForFinishProcessing(meeting),
    );
  }

  const transcriptions = await runMeetingEndStep(
    meeting,
    "compile-cancelled-transcriptions",
    () => compileTranscriptions(client, meeting),
  );
  meeting.finalTranscript = transcriptions;
  return transcriptions;
}
