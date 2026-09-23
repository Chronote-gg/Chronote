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

export function classifyTranscription(
  facts: TranscriptionFacts,
): TranscriptionOutcome {
  const incomplete = facts.failedSegments > 0 || facts.captureIncomplete;
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
