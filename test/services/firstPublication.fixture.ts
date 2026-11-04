import { requestMeetingUpdateDelivery } from "../../src/types/meetingUpdateDelivery";
import { createHash } from "node:crypto";
import type { MeetingHistory } from "../../src/types/db";
export const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export function firstPublicationFixture() {
  const id = "11111111-1111-4111-8111-111111111111",
    meetingId = "22222222-2222-4222-8222-222222222222";
  const key = {
    guildId: "123",
    channelId_timestamp: "456#2026-10-12T07:50:22.534Z",
  };
  const prefix = `ops/operator-recovery/${id}/${meetingId}/`;
  const notes = "## Recovered\n\nApproved partial wording.";
  const transcript = JSON.stringify({
    text: "Approved partial wording.",
    segments: [],
  });
  const profile = {
    accountId: "123456789012",
    region: "us-east-1",
    historyTable: "history",
    activeTable: "active",
    controlTable: "control",
    bucket: "private",
    archiveWriters: [{ cluster: "cluster", service: "service" }],
  };
  const row: MeetingHistory = {
    ...key,
    meetingId,
    channelId: "456",
    timestamp: "2026-10-12T07:50:22.534Z",
    participants: [],
    duration: 0,
    transcribeMeeting: true,
    generateNotes: true,
    status: "interrupted",
    notes,
    notesVersion: 2,
    contentRevision: 1,
    textChannelId: "789",
    transcriptS3Key: prefix + "transcript.json",
    capture: {
      kind: "interrupted",
      startedAt: null,
      endedAt: null,
      detectedAt: "2026-11-02T06:22:15.193Z",
    },
    captureCoverage: { kind: "unknown" },
    processing: { transcription: "partial" },
    operatorRecovery: {
      schemaVersion: 2,
      id,
      manifestS3Key: prefix + "manifest.json",
      notesSha256: hash(notes),
      transcriptSha256: hash(transcript),
      previousNotesVersion: null,
      previousTranscriptS3Key: null,
      preparedAt: "2026-11-02T06:22:15.193Z",
      approvedBy: "synthetic operator",
      language: "en",
      classification: "partial_notes",
      completenessVerified: false,
      notificationStatus: "held",
      notionSyncStatus: "held",
    },
  };
  row.updateDelivery = requestMeetingUpdateDelivery({
    history: row,
    mutation: { kind: "notes", notes, notesDelta: null },
    revision: "import",
    now: 1793600535,
    policy: { kind: "held", reason: "stored_only" },
  });
  const manifest = {
    schemaVersion: 2,
    id,
    meetingId,
    key,
    language: "en",
    classification: "partial_notes",
    approvedBy: "synthetic operator",
    preparedAt: "2026-11-02T06:22:15.193Z",
    completenessVerified: false,
    sourceHashes: { sample: hash("source") },
    evidence: {},
    objects: [
      { key: prefix + "notes.md", sha256: hash(notes) },
      { key: prefix + "transcript.json", sha256: hash(transcript) },
      { key: prefix + "before.json", sha256: hash("before") },
    ],
    publication: "stored_only",
    unknowns: ["actual_end", "actual_duration", "historical_delivery"],
  };
  return { row, profile, manifest, objects: { notes, transcript }, key };
}
