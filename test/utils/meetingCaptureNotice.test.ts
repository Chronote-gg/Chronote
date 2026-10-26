import {
  formatMeetingCaptureNotice,
  projectMeetingCapture,
  resolveCaptureStatus,
} from "../../src/utils/meetingCaptureNotice";
import { buildMeetingNotesEmbeds } from "../../src/utils/meetingNotes";

const capture = {
  kind: "interrupted",
  startedAt: "2026-01-01T00:00:00Z",
  endedAt: null,
  detectedAt: "2026-01-01T01:00:00Z",
} as const;

test("partialNoticeSurvivesModelOutputAndNotesCorrection", () => {
  for (const notesBody of [
    "Generated notes",
    "Corrected notes",
    "Long notes. ".repeat(1500),
  ]) {
    const embeds = buildMeetingNotesEmbeds({ notesBody, capture });
    for (const embed of embeds)
      expect(embed.toJSON().description).toContain(
        "Partial notes: recording was interrupted.",
      );
  }
});
test("partialDeliveryKeepsInterruptedBadge", () => {
  expect(resolveCaptureStatus({ capture, status: "complete" })).toBe(
    "interrupted",
  );
});
test("unknownEndIsNotDetectionTime", () => {
  const projected = projectMeetingCapture({ capture });
  expect(
    projected.capture?.kind === "interrupted" && projected.capture.endedAt,
  ).toBeNull();
  expect(projected.captureNotice).toContain(
    "The exact recording end time is unknown.",
  );
});
test("complete capture retains known missing transcription", () => {
  expect(
    formatMeetingCaptureNotice({
      capture: {
        kind: "complete",
        startedAt: capture.startedAt,
        endedAt: capture.detectedAt,
      },
      processing: { transcription: "partial", notes: "generated" },
    }),
  ).toContain("Some audio could not be transcribed");
});
test("complete capture with processing-only failure is not partial", () => {
  expect(
    formatMeetingCaptureNotice({
      capture: {
        kind: "complete",
        startedAt: capture.startedAt,
        endedAt: capture.detectedAt,
      },
      processing: { notes: "failed" },
    }),
  ).toBeUndefined();
});
test("complete capture with failed transcription still warns when notes exist", () => {
  expect(
    formatMeetingCaptureNotice({
      capture: {
        kind: "complete",
        startedAt: capture.startedAt,
        endedAt: capture.detectedAt,
      },
      processing: { transcription: "failed", notes: "generated" },
      notes: "Generated saved decision.",
    }),
  ).toContain("Some audio could not be transcribed");
});
test("public metadata excludes internal identities", () => {
  const projected = projectMeetingCapture({
    capture,
    recovery: {
      disposition: "claimed",
      stage: "notes",
      attempt: 2,
      executionVersion: 4,
      retry: { maxAttempts: 4, nextAttemptAt: null },
    },
  });
  expect(projected.recovery).toEqual({
    disposition: "claimed",
    stage: "notes",
  });
  expect(JSON.stringify(projected)).not.toMatch(
    /attempt|executionVersion|ownerInstanceId|sourceId/,
  );
});
