/** @jest-environment node */
import { matchesRecoveredRecording } from "../../src/services/recoveredRecordingProof";
import type { MeetingHistory } from "../../src/types/db";
import type { SessionReservation } from "../../src/types/deploymentControl";

function fixture() {
  const original = {
    guildId: "guild",
    meetingId: "meeting",
    ownerInstanceId: "worker",
    executionVersion: 1,
    historyKey: { guildId: "guild", channelId_timestamp: "voice#start" },
  } as SessionReservation & { sessionMode: "meeting" };
  const row = {
    guildId: "guild",
    channelId_timestamp: "voice#start",
    meetingId: "meeting",
    ownerInstanceId: "worker",
    executionVersion: 2,
    status: "interrupted",
    checkpoint: {
      revision: 3,
      artifactFolder: "saved/",
      capture: {
        ...original.historyKey,
        meetingId: "meeting",
        ownerInstanceId: "worker",
        executionVersion: 1,
      },
    },
    recovery: {
      disposition: "done",
      outcome: "completed",
      executionVersion: 2,
      stage: "export",
    },
    canonicalWriter: {
      kind: "recording",
      ownerInstanceId: "worker",
      executionVersion: 2,
    },
    recoveryExport: {
      checkpointRevision: 3,
      intentExecutionVersion: 2,
      state: "skipped",
    },
    recoveryTranscript: {
      checkpointRevision: 3,
      object: { key: "saved/recovery/2/transcript.json" },
    },
    transcriptS3Key: "saved/recovery/2/transcript.json",
    notes: "saved",
    summarySentence: "saved",
    processing: { notes: "generated", summary: "generated" },
    delivery: {
      summary: { outcome: "complete", intended: 1, sent: 1, errors: [] },
      notes: { outcome: "complete", intended: 1, sent: 1, errors: [] },
    },
    summaryMessageId: "summary",
    notesMessageIds: ["notes"],
    notesChannelId: "text",
  } as unknown as MeetingHistory;
  return { original, row };
}
test("only the exact original capture and acknowledged next recovery match", () => {
  const { original, row } = fixture();
  expect(matchesRecoveredRecording(original, row)).toBe(true);
  for (const alter of [
    (r: MeetingHistory) => {
      r.ownerInstanceId = "new";
    },
    (r: MeetingHistory) => {
      r.executionVersion = 3;
    },
    (r: MeetingHistory) => {
      r.checkpoint!.capture.executionVersion = 2;
    },
    (r: MeetingHistory) => {
      r.recoveryExport!.state = "submitted";
    },
    (r: MeetingHistory) => {
      r.recoveryTranscript!.checkpointRevision = 2;
    },
    (r: MeetingHistory) => {
      r.delivery!.notes!.outcome = "failed";
    },
    (r: MeetingHistory) => {
      r.recovery!.stage = "verification";
    },
  ]) {
    const changed = structuredClone(row);
    alter(changed);
    expect(matchesRecoveredRecording(original, changed)).toBe(false);
  }
});
test("a later exact terminal recovery may reuse its preserved earlier export intent", () => {
  const { original, row } = fixture();
  row.executionVersion = 3;
  row.recovery!.executionVersion = 3;
  row.canonicalWriter = {
    kind: "recording",
    ownerInstanceId: "worker",
    executionVersion: 3,
  };
  expect(matchesRecoveredRecording(original, row)).toBe(true);
  row.recoveryExport!.intentExecutionVersion = 4;
  expect(matchesRecoveredRecording(original, row)).toBe(false);
  row.recoveryExport!.intentExecutionVersion = 1;
  expect(matchesRecoveredRecording(original, row)).toBe(false);
});
test.each(["disabled", "no_usable_speech"] as const)(
  "%s requires terminal history status independently of its applicable receipt",
  (outcome) => {
    const { original, row } = fixture();
    row.recovery = { ...row.recovery!, disposition: "done", outcome };
    if (outcome === "disabled")
      row.checkpoint!.capture.requested = {
        transcribeMeeting: false,
        generateNotes: false,
      };
    else
      row.processing = {
        transcription: "empty",
        notes: "skipped",
        summary: "skipped",
      };
    expect(matchesRecoveredRecording(original, row)).toBe(true);
    row.status = "processing";
    expect(matchesRecoveredRecording(original, row)).toBe(false);
    row.status = "starting";
    expect(matchesRecoveredRecording(original, row)).toBe(false);
  },
);
