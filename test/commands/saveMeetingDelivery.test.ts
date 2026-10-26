import { saveMeetingHistoryToDatabase } from "../../src/commands/saveMeetingHistory";
import { saveOwnedMeetingHistoryService } from "../../src/services/meetingHistoryService";
import type { MeetingData } from "../../src/types/meeting-data";

jest.mock("../../src/services/meetingHistoryService", () => ({
  saveOwnedMeetingHistoryService: jest.fn(),
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

beforeEach(() => {
  jest.clearAllMocks();
});

it.each([
  {
    cancelled: false,
    generationEnabled: true,
    deliveryFailed: true,
    processingFailed: false,
  },
  {
    cancelled: false,
    generationEnabled: true,
    deliveryFailed: false,
    processingFailed: true,
  },
  {
    cancelled: true,
    generationEnabled: true,
    deliveryFailed: false,
    processingFailed: true,
  },
  { cancelled: true, generationEnabled: true, deliveryFailed: true },
  {
    cancelled: true,
    generationEnabled: true,
    deliveryFailed: false,
    timingInvalid: true,
  },
  {
    cancelled: false,
    generationEnabled: true,
    deliveryFailed: false,
    timingInvalid: true,
  },
  { cancelled: false, generationEnabled: false, deliveryFailed: false },
])(
  "persists processing independently ($cancelled, $generationEnabled, $deliveryFailed)",
  async ({
    cancelled,
    generationEnabled,
    deliveryFailed,
    processingFailed,
    timingInvalid,
  }) => {
    const meeting = {
      guildId: "guild",
      guild: { id: "guild", name: "Fixture guild" },
      meetingId: "meeting",
      voiceChannel: { id: "voice" },
      textChannel: { id: "text" },
      startTime: new Date("2026-09-05T19:00:00Z"),
      endTime: new Date("2026-09-05T20:00:00Z"),
      participants: new Map(),
      audioData: { audioFiles: [] },
      creator: { id: "creator" },
      transcribeMeeting: true,
      generateNotes: generationEnabled,
      processing: {
        transcription: "ready",
        notes: "generated",
        summary: processingFailed ? "failed" : "generated",
      },
      notesDeliveryTiming: timingInvalid
        ? JSON.parse('{"kind":"legacy"}')
        : {
            kind: "first",
            notesVersion: 1,
            path: "live",
            firstAcknowledgedAt: "2026-09-05T20:00:30.000Z",
          },
      transcriptS3Key: "transcript",
      audioS3Key: "audio",
      cancelled,
      delivery: deliveryFailed
        ? {
            notes: {
              outcome: "failed",
              intended: 1,
              sent: 0,
              errors: [{ code: 50013, status: 403 }],
            },
          }
        : undefined,
    } as unknown as MeetingData;
    if (processingFailed) {
      await expect(saveMeetingHistoryToDatabase(meeting)).rejects.toThrow(
        "processing",
      );
      expect(saveOwnedMeetingHistoryService).not.toHaveBeenCalled();
      expect(meeting.historySaved).toBe(false);
      return;
    }
    await saveMeetingHistoryToDatabase(meeting);
    expect(meeting.historySaved).toBe(true);
    expect(saveOwnedMeetingHistoryService).toHaveBeenLastCalledWith(
      meeting,
      expect.objectContaining({
        generateNotes: generationEnabled,
        notesDeliveryTiming: timingInvalid
          ? undefined
          : meeting.notesDeliveryTiming,
        ...(cancelled
          ? {}
          : {
              processing: {
                transcription: "ready",
                notes: "generated",
                summary: "generated",
              },
            }),
        transcriptS3Key: "transcript",
        audioS3Key: "audio",
        delivery: deliveryFailed
          ? {
              notes: {
                outcome: "failed",
                intended: 1,
                sent: 0,
                errors: [{ code: 50013, status: 403 }],
              },
            }
          : undefined,
      }),
    );
  },
);
