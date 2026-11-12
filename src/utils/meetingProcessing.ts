import type { MeetingData } from "../types/meeting-data";
import { getAudioTranscriptionFacts } from "./audioTranscript";
import type {
  MeetingProcessingOutcome,
  ProcessingNotice,
  TranscriptionFacts,
  TranscriptionOutcome,
} from "../types/meetingProcessing";

export const EMPTY_RECORDING_NOTICE =
  "No usable speech was found, so no notes were generated.";
export const PROCESSING_FAILED_NOTICE =
  "Chronote could not finish processing this meeting. The saved audio is kept and processing can be retried from the portal.";
export const PARTIAL_TRANSCRIPT_NOTICE =
  "Some audio could not be transcribed. These notes may be incomplete.";
/** What a meeting that failed before notes records, so the portal offers a retry. */
export const TRANSCRIPTION_FAILED: MeetingProcessingOutcome = {
  transcription: "failed",
  notes: "skipped",
  summary: "skipped",
};

/**
 * Failed per-turn snippets below this count do not demote a Discord recording that has
 * usable speech. The unit matters: a caller whose segments are few and long, such as the
 * personal upload path's 300 second chunks, must pass its own threshold instead.
 * A meeting attempts hundreds of per-turn snippets, so a single failure is one transient
 * provider hiccup rather than a gap worth warning about. Three is a judgement, not a
 * fitted number: six weeks of production held no meeting between one and eight failed
 * snippets, so any floor in that range behaves identically. A percentage is deliberately
 * not used; measured genuine failures sit at 2.65 and 3.64 percent of attempted snippets,
 * so every rate at or above three percent misses one of them, while two percent of a
 * median meeting is about three snippets and only restates this floor with
 * length-dependent wobble.
 */
export const FAILED_SEGMENT_PARTIAL_THRESHOLD = 3;

/**
 * The single rule for whether a recording shows lost transcription work. The floor
 * exists to stop a few lost snippets demoting a recording that otherwise worked, so it
 * does not apply without usable speech: there, any failure is the whole recording.
 */
function hasTranscriptionLoss(
  facts: TranscriptionFacts,
  failedSegmentThreshold: number,
): boolean {
  return facts.usableSegments > 0
    ? facts.failedSegments >= failedSegmentThreshold
    : facts.failedSegments > 0;
}

/**
 * A personal upload is split into few, long chunks rather than hundreds of per-turn
 * snippets, so one lost chunk is a real gap in the audio and not a transient hiccup.
 * Named rather than a threshold argument at the call site, so the unit stays legible.
 */
export function classifyUploadTranscription(
  facts: TranscriptionFacts,
): TranscriptionOutcome {
  return classifyTranscription(facts, 1);
}

export function classifyTranscription(
  facts: TranscriptionFacts,
  failedSegmentThreshold = FAILED_SEGMENT_PARTIAL_THRESHOLD,
): TranscriptionOutcome {
  const incomplete =
    hasTranscriptionLoss(facts, failedSegmentThreshold) ||
    facts.captureIncomplete;
  if (facts.usableSegments > 0) return incomplete ? "partial" : "ready";
  return incomplete ? "failed" : "empty";
}

export function getMeetingProcessingNotice(
  processing: MeetingProcessingOutcome | undefined,
  hasNotes: boolean,
): ProcessingNotice | undefined {
  if (hasNotes) {
    return processing?.transcription === "partial"
      ? { tone: "warning", text: PARTIAL_TRANSCRIPT_NOTICE }
      : undefined;
  }
  if (processing?.transcription === "failed") {
    return {
      tone: "error",
      text: "Audio could not be transcribed, so no notes were generated.",
    };
  }
  if (processing?.notes === "failed") {
    return {
      tone: "error",
      text: "Notes could not be generated for this recording.",
    };
  }
  if (processing?.transcription === "empty" && processing.notes === "skipped") {
    return { tone: "neutral", text: EMPTY_RECORDING_NOTICE };
  }
  return undefined;
}

/** Usable incomplete capture can finish as partial; failed or pending processing cannot. */
export function assertMeetingProcessingSucceeded(meeting: MeetingData): void {
  const facts = getAudioTranscriptionFacts(meeting.audioData);
  if (
    (facts.captureIncomplete && facts.usableSegments === 0) ||
    hasTranscriptionLoss(facts, FAILED_SEGMENT_PARTIAL_THRESHOLD) ||
    Object.values(meeting.processing ?? {}).includes("failed") ||
    (meeting.processing?.transcription === "partial" &&
      !facts.captureIncomplete)
  )
    throw new Error("Meeting processing failed or remains incomplete");
  if (
    meeting.transcribeMeeting &&
    meeting.audioData.audioFiles.some((file) => file.processing)
  )
    throw new Error("Meeting processing remains pending");
}
