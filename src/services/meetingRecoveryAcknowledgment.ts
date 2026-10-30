import type { MeetingHistory } from "../types/db";
export function summaryDeliveryAcknowledged(row: MeetingHistory) {
  const summary = row.delivery?.summary;
  return (
    summary?.outcome === "complete" &&
    summary.intended === 1 &&
    summary.sent === 1 &&
    summary.errors.length === 0 &&
    Boolean(row.summaryMessageId?.trim())
  );
}
function notesDeliveryAcknowledged(row: MeetingHistory) {
  const notes = row.delivery?.notes;
  return (
    notes?.outcome === "complete" &&
    notes.intended > 0 &&
    notes.sent === notes.intended &&
    row.notesMessageIds?.length === notes.intended &&
    new Set(row.notesMessageIds).size === notes.intended &&
    row.notesMessageIds.every((id) => Boolean(id.trim())) &&
    notes.errors.length === 0 &&
    Boolean(row.notesChannelId?.trim())
  );
}
export function terminalDeliveryAcknowledged(row: MeetingHistory) {
  return (
    ["complete", "interrupted"].includes(row.status ?? "") &&
    Boolean(row.transcriptS3Key) &&
    row.processing?.notes === "generated" &&
    row.processing.summary === "generated" &&
    Boolean(row.notes?.trim()) &&
    Boolean(row.summarySentence?.trim() || row.summaryLabel?.trim()) &&
    summaryDeliveryAcknowledged(row) &&
    notesDeliveryAcknowledged(row)
  );
}
export function noSpeechNoticeAcknowledged(row: MeetingHistory) {
  return (
    row.processing?.transcription === "empty" &&
    row.processing.notes === "skipped" &&
    row.processing.summary === "skipped" &&
    Boolean(row.recoveryTranscript) &&
    summaryDeliveryAcknowledged(row)
  );
}
