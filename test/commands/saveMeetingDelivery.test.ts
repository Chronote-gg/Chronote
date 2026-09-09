import { saveMeetingHistoryToDatabase } from "../../src/commands/saveMeetingHistory";
import { writeMeetingHistoryService } from "../../src/services/meetingHistoryService";
import type { MeetingData } from "../../src/types/meeting-data";

jest.mock("../../src/services/meetingHistoryService", () => ({
  writeMeetingHistoryService: jest.fn(),
}));
jest.mock("../../src/services/notionAutomationService", () => ({
  maybeAutoExportCompletedMeeting: jest.fn(),
}));
jest.mock("../../src/services/meetingNotesService", () => ({
  ensureMeetingNotes: jest.fn().mockResolvedValue("Generated notes"),
  ensureMeetingSummaries: jest
    .fn()
    .mockResolvedValue({ summarySentence: "Summary", summaryLabel: "Label" }),
}));

it.each([false, true])(
  "persists delivery failure separately from generated artifacts (cancelled=%s)",
  async (cancelled) => {
    const meeting = {
      guildId: "guild",
      meetingId: "meeting",
      voiceChannel: { id: "voice" },
      textChannel: { id: "text" },
      startTime: new Date("2026-09-05T19:00:00Z"),
      endTime: new Date("2026-09-05T20:00:00Z"),
      participants: new Map(),
      creator: { id: "creator" },
      transcribeMeeting: true,
      generateNotes: true,
      transcriptS3Key: "transcript",
      audioS3Key: "audio",
      cancelled,
      delivery: {
        notes: {
          outcome: "failed",
          intended: 1,
          sent: 0,
          errors: [{ code: 50013, status: 403 }],
        },
      },
    } as unknown as MeetingData;
    await saveMeetingHistoryToDatabase(meeting);
    expect(writeMeetingHistoryService).toHaveBeenLastCalledWith(
      expect.objectContaining({
        generateNotes: true,
        transcriptS3Key: "transcript",
        audioS3Key: "audio",
        delivery: {
          notes: {
            outcome: "failed",
            intended: 1,
            sent: 0,
            errors: [{ code: 50013, status: 403 }],
          },
        },
      }),
    );
  },
);
