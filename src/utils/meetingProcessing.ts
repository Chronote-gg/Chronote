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
export const PARTIAL_TRANSCRIPT_NOTICE =
  "Some audio could not be transcribed. These notes may be incomplete.";

/**
 * Failed snippets below this count do not demote a recording that has usable speech.
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
function hasTranscriptionLoss(facts: TranscriptionFacts): boolean {
  return facts.usableSegments > 0
    ? facts.failedSegments >= FAILED_SEGMENT_PARTIAL_THRESHOLD
    : facts.failedSegments > 0;
}

export function classifyTranscription(
  facts: TranscriptionFacts,
): TranscriptionOutcome {
  const incomplete = hasTranscriptionLoss(facts) || facts.captureIncomplete;
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

/** Empty/suppressed speech is successful processing; known lost capture/provider work is not. */
export function assertMeetingProcessingSucceeded(meeting: MeetingData): void {
  const facts = getAudioTranscriptionFacts(meeting.audioData);
  if (
    facts.captureIncomplete ||
    hasTranscriptionLoss(facts) ||
    Object.values(meeting.processing ?? {}).includes("failed") ||
    meeting.processing?.transcription === "partial"
  )
    throw new Error("Meeting processing failed or remains incomplete");
  if (
    meeting.transcribeMeeting &&
    meeting.audioData.audioFiles.some((file) => file.processing)
  )
    throw new Error("Meeting processing remains pending");
}
