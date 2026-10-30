import type { MeetingHistory } from "../types/db";
import type { SessionReservation } from "../types/deploymentControl";
import {
  terminalDeliveryAcknowledged,
  noSpeechNoticeAcknowledged,
} from "./meetingRecoveryAcknowledgment";
type OriginalRecording = Extract<
  SessionReservation,
  { sessionMode: "meeting" }
>;

function originalCaptureMatches(
  original: OriginalRecording,
  row: MeetingHistory,
) {
  const capture = row.checkpoint?.capture;
  return (
    capture?.guildId === original.guildId &&
    capture.channelId_timestamp === original.historyKey.channelId_timestamp &&
    capture.meetingId === original.meetingId &&
    capture.ownerInstanceId === original.ownerInstanceId &&
    capture.executionVersion === original.executionVersion
  );
}
function currentRecoveryMatches(
  original: OriginalRecording,
  row: MeetingHistory,
) {
  return (
    row.guildId === original.guildId &&
    row.channelId_timestamp === original.historyKey.channelId_timestamp &&
    row.meetingId === original.meetingId &&
    row.ownerInstanceId === original.ownerInstanceId &&
    row.executionVersion !== undefined &&
    row.executionVersion > original.executionVersion &&
    row.canonicalWriter?.kind === "recording" &&
    row.canonicalWriter.ownerInstanceId === row.ownerInstanceId &&
    row.canonicalWriter.executionVersion === row.executionVersion &&
    row.recovery?.disposition === "done" &&
    row.recovery.executionVersion === row.executionVersion
  );
}
function exportAcknowledged(original: OriginalRecording, row: MeetingHistory) {
  const receipt = row.recoveryExport;
  return (
    row.recovery?.stage === "export" &&
    receipt !== undefined &&
    receipt.checkpointRevision === row.checkpoint?.revision &&
    // Recovery preserves this intent across later claims, never replacing its identity.
    receipt.intentExecutionVersion > original.executionVersion &&
    receipt.intentExecutionVersion <= row.executionVersion! &&
    ["acknowledged", "skipped"].includes(receipt.state)
  );
}
function transcriptAcknowledged(row: MeetingHistory) {
  return (
    row.recoveryTranscript !== undefined &&
    row.recoveryTranscript.checkpointRevision === row.checkpoint?.revision &&
    row.recoveryTranscript.object.key === row.transcriptS3Key &&
    Boolean(
      row.transcriptS3Key?.startsWith(
        `${row.checkpoint?.artifactFolder}recovery/`,
      ),
    )
  );
}
function outputAcknowledged(original: OriginalRecording, row: MeetingHistory) {
  if (row.recovery?.disposition !== "done") return false;
  switch (row.recovery.outcome) {
    case "completed":
      return (
        exportAcknowledged(original, row) &&
        transcriptAcknowledged(row) &&
        terminalDeliveryAcknowledged(row)
      );
    case "no_usable_speech":
      return transcriptAcknowledged(row) && noSpeechNoticeAcknowledged(row);
    case "disabled":
      return disabledOutputAcknowledged(row);
    default:
      return false;
  }
}
function disabledOutputAcknowledged(row: MeetingHistory) {
  const requested = row.checkpoint?.capture.requested;
  return (
    requested?.transcribeMeeting === false ||
    (requested?.generateNotes === false &&
      transcriptAcknowledged(row) &&
      row.processing?.notes === "skipped" &&
      row.processing.summary === "skipped")
  );
}

/** Exact surviving capture and current canonical recovery acknowledgment, including a preserved export intent. */
export function matchesRecoveredRecording(
  original: OriginalRecording,
  row: MeetingHistory,
): boolean {
  return Boolean(
    originalCaptureMatches(original, row) &&
    currentRecoveryMatches(original, row) &&
    ["complete", "interrupted"].includes(row.status ?? "") &&
    outputAcknowledged(original, row),
  );
}
