import { config } from "../../src/services/configService";
import { fixture, message, summaryId } from "./meetingUpdatePlan.fixture";
import { recordingCheckpointSchema } from "../../src/types/recordingCheckpoint";
import { buildMeetingNotesEmbeds } from "../../src/utils/meetingNotes";
import { withMeetingCaptureNotice } from "../../src/utils/meetingCaptureNotice";
import { buildPortalMeetingUrl } from "../../src/utils/portalLinks";

export function recoveredFixture(
  options: {
    linked?: boolean;
    notes?: string;
    beforeNotes?: string;
    complete?: boolean;
  } = {},
) {
  const input = fixture(
    "Saved original notes",
    options.notes ?? "Edited notes",
  );
  const row = input.history;
  const folder = "synthetic-recording/";
  row.ownerInstanceId = "recovery-owner";
  row.executionVersion = 2;
  row.status = "interrupted";
  row.capture = {
    kind: "interrupted",
    startedAt: row.timestamp,
    detectedAt: "2026-10-22T12:01:00.000Z",
    endedAt: null,
  };
  row.captureCoverage = { kind: "unknown" };
  row.processing = {
    transcription: "partial",
    notes: "generated",
    summary: "generated",
  };
  if (options.complete) {
    row.status = "complete";
    row.capture = {
      kind: "complete",
      startedAt: row.timestamp,
      endedAt: "2026-10-22T12:01:00.000Z",
    };
    row.processing.transcription = "ready";
  }
  row.checkpoint = recordingCheckpointSchema.parse({
    schemaVersion: 1,
    revision: 2,
    artifactFolder: folder,
    capture: {
      guildId: row.guildId,
      channelId: row.channelId,
      channelId_timestamp: row.channelId_timestamp,
      meetingId: row.meetingId,
      ownerInstanceId: "original-owner",
      executionVersion: 1,
      reservedAt: row.timestamp,
      captureStartedAt: row.timestamp,
      requested: { transcribeMeeting: true, generateNotes: true },
    },
    manifest: {
      key: folder + "manifest.json",
      checksumSha256: "a".repeat(64),
      byteLength: 100,
    },
  });
  row.recovery = {
    disposition: "done",
    outcome: "completed",
    stage: "export",
    attempt: 1,
    executionVersion: 2,
    retry: { maxAttempts: 4, nextAttemptAt: null },
  };
  row.recoveryTranscript = {
    checkpointRevision: 2,
    object: {
      key: folder + "recovery/2/transcript.json",
      checksumSha256: "b".repeat(64),
      byteLength: 100,
    },
  };
  row.transcriptS3Key = row.recoveryTranscript.object.key;
  row.recoveryExport = {
    checkpointRevision: 2,
    intentExecutionVersion: 2,
    state: "skipped",
  };
  const notes = buildMeetingNotesEmbeds({
    ...row,
    notesBody: options.beforeNotes ?? "Saved original notes",
    meetingName: options.complete
      ? "Recovered meeting notes"
      : "Recovered partial notes",
  });
  const summary = {
    title: options.complete ? "Recovered meeting" : "Recovered partial meeting",
    description: withMeetingCaptureNotice("Saved summary", row),
  };
  const portalUrl = buildPortalMeetingUrl({
    baseUrl: config.frontend.siteUrl,
    guildId: row.guildId,
    meetingId: row.channelId_timestamp,
  });
  const notesMessages = notes.map((embed, index) =>
    message(String(999990 + index), [
      {
        ...embed.toJSON(),
        ...(options.linked === false ? {} : { url: portalUrl }),
        color: 123,
        timestamp: row.timestamp,
      },
    ]),
  );
  row.notesMessageIds = notesMessages.map((value) => value.id);
  row.delivery = {
    summary: { intended: 1, sent: 1, errors: [], outcome: "complete" },
    notes: {
      intended: notes.length,
      sent: notes.length,
      errors: [],
      outcome: "complete",
    },
  };
  input.messages = [
    ...notesMessages,
    message(summaryId, [
      {
        ...summary,
        ...(options.linked === false ? {} : { url: portalUrl }),
        color: 456,
        timestamp: row.timestamp,
      },
    ]),
  ];
  return input;
}
