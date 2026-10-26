import type { MeetingHistory } from "../../src/types/db";
import { buildSharedMeetingPayloadService } from "../../src/services/meetingSharePayloadService";
import { buildMeetingNotionMarkdown } from "../../src/services/notionService";
import { buildMeetingDetails } from "../../src/frontend/utils/meetingLibrary";
import { buildMeetingExport } from "../../src/frontend/pages/library/components/meetingExport";
import {
  projectMeetingCapture,
  summarizeCaptureCoverage,
} from "../../src/utils/meetingCaptureNotice";

jest.mock("../../src/services/meetingArtifactAccessService", () => ({
  resolveMeetingArtifactAccess: async () => ({
    transcriptAccessEnabled: false,
    audioAccessEnabled: false,
  }),
}));
jest.mock("../../src/services/meetingMentionService", () => ({
  createMeetingMentionReplacer: async () => ({
    toMarkdown: (text: string) => text,
    toText: (text: string) => text,
  }),
  buildParticipantMap: () => new Map(),
}));
const history: MeetingHistory = {
  guildId: "synthetic",
  meetingId: "synthetic",
  channelId: "synthetic",
  channelId_timestamp: "synthetic#2026-01-01T00:00:00Z",
  timestamp: "2026-01-01T00:00:00Z",
  duration: 0,
  participants: [],
  transcribeMeeting: true,
  generateNotes: true,
  notes: "Generated saved decision.",
  status: "interrupted",
  ownerInstanceId: "private-owner",
  executionVersion: 2,
  capture: {
    kind: "interrupted",
    startedAt: "2026-01-01T00:00:00Z",
    detectedAt: "2026-01-01T01:00:00Z",
    endedAt: null,
  },
  recovery: {
    disposition: "done",
    outcome: "completed",
    stage: "delivery",
    attempt: 1,
    executionVersion: 2,
    retry: { maxAttempts: 4, nextAttemptAt: null },
  },
};
test("allReadExportSurfacesRetainWarning", async () => {
  const share = await buildSharedMeetingPayloadService(history);
  expect(share.meeting.captureNotice).toContain(
    "These notes cover only the saved recording.",
  );
  expect(share.meeting.notes).toBe(history.notes);
  expect(JSON.stringify(share)).not.toMatch(
    /private-owner|executionVersion|attempt|checkpoint/,
  );
  const markdownExport = await buildMeetingNotionMarkdown(history);
  expect(markdownExport).toContain(
    "These notes cover only the saved recording.",
  );
  const detail = {
    ...history,
    ...projectMeetingCapture(history),
    id: history.channelId_timestamp,
  };
  const meeting = buildMeetingDetails(detail, new Map());
  expect(meeting.durationLabel).toBe("Unknown duration");
  const exported = buildMeetingExport(detail, meeting);
  expect(exported.meeting.notes).toContain(
    "These notes cover only the saved recording.",
  );
  expect(exported.meeting.status).toBe("interrupted");
  expect(exported.meeting.audioUrl).toBeUndefined();
  expect(history.notes).toBe("Generated saved decision.");
});
test("coverage summary strips source intervals and preserves only proved scalar timing", () => {
  expect(
    summarizeCaptureCoverage({
      kind: "verified",
      intervals: [
        { sourceId: "private-source", startOffsetMs: 10, durationMs: 1500 },
      ],
      savedDurationMs: 1500,
      lastConfirmedCaptureAt: "2026-01-01T00:00:02Z",
    }),
  ).toEqual({
    kind: "verified",
    savedDurationMs: 1500,
    lastConfirmedCaptureAt: "2026-01-01T00:00:02Z",
  });
  expect(
    summarizeCaptureCoverage({
      kind: "unknown",
      detectedAt: "2026-01-01T01:00:00Z",
      reason: "verification_failed",
    }),
  ).toEqual({ kind: "unknown" });
});
