/** @jest-environment node */
jest.mock("../../src/services/notionAutomationService", () => ({
  maybeAutoSyncMeetingNotes: jest.fn(async () => {}),
  maybeAutoExportCompletedMeeting: jest.fn(async () => {}),
}));
jest.mock("../../src/services/meetingUpdateDeliveryWorkerService", () => ({
  verifyMeetingUpdateDeliveryReadiness: jest.fn(async () => {}),
}));
jest.mock("../../src/services/liveMeetingNotesService", () => ({
  ensureLiveMeetingNotes: jest.fn(async () => "Generated original notes"),
  ensureLiveMeetingSummaries: jest.fn(),
}));
import { saveMeetingHistoryToDatabase } from "../../src/commands/saveMeetingHistory";
import { ensureLiveMeetingSummaries } from "../../src/services/liveMeetingNotesService";
import { maybeAutoExportCompletedMeeting } from "../../src/services/notionAutomationService";
import { getMockStore, resetMockStore } from "../../src/repositories/mockStore";
import { createMeetingUpdateService } from "../../src/services/meetingUpdateService";
import { createMockMeetingUpdateDeliveryRepository } from "../../src/repositories/mockMeetingUpdateDeliveryRepository";
import type { MeetingData } from "../../src/types/meeting-data";
import type { MeetingHistory } from "../../src/types/db";
import { history, key } from "../types/meetingUpdateDelivery.fixture";

beforeEach(() => {
  resetMockStore();
  jest.clearAllMocks();
});
test("recording first export consumes committed canonical notes and original completion authority", async () => {
  const row: MeetingHistory = {
    ...history(),
    notes: undefined,
    status: "processing",
    ownerInstanceId: "synthetic-original",
    executionVersion: 1,
    recovery: {
      disposition: "needs_reconciliation",
      reason: "delivery_uncertain",
      stage: "delivery",
    } as MeetingHistory["recovery"],
  };
  const store = getMockStore();
  store.meetingHistoryByGuild.set(key.guildId, [row]);
  const meeting = {
    guildId: row.guildId,
    meetingId: row.meetingId,
    sessionMode: "meeting",
    startTime: new Date(row.timestamp),
    endTime: new Date(Date.parse(row.timestamp) + 60000),
    audioData: { audioFiles: [] },
    creator: { id: "synthetic-generator" },
    voiceChannel: { id: row.channelId },
    textChannel: { id: "synthetic-text" },
    participants: new Map(),
    transcribeMeeting: true,
    generateNotes: true,
    meetingName: "Generated name",
    reservation: {
      ...key,
      historyKey: key,
      sessionMode: "meeting",
      meetingId: row.meetingId,
      ownerInstanceId: row.ownerInstanceId,
      executionVersion: row.executionVersion,
    },
  } as unknown as MeetingData;
  const action = createMeetingUpdateService({
    repository: createMockMeetingUpdateDeliveryRepository(
      store.meetingHistoryByGuild,
      () => true,
    ),
    ready: async () => {},
    syncNotes: jest.fn(async () => {}),
  });
  jest.mocked(ensureLiveMeetingSummaries).mockImplementationOnce(async () => {
    expect(
      (
        await action({
          key,
          actor: { editedBy: "synthetic-editor" },
          mutation: {
            kind: "notes",
            notes: "Manual canonical notes",
            notesDelta: null,
          },
          notesEdit: {
            expectedNotesVersion: 1,
            source: { type: "web_editor" },
          },
        })
      ).kind,
    ).toBe("saved");
    return {
      summarySentence: "Generated summary",
      summaryLabel: "Generated label",
    };
  });
  await saveMeetingHistoryToDatabase(meeting);
  const committed = store.meetingHistoryByGuild.get(key.guildId)?.[0];
  expect(committed).toMatchObject({
    status: "complete",
    notes: "Manual canonical notes",
    notesVersion: 2,
    recovery: { disposition: "needs_reconciliation" },
  });
  expect(meeting.historySaved).toBe(true);
  expect(maybeAutoExportCompletedMeeting).toHaveBeenCalledTimes(1);
  const exported = jest.mocked(maybeAutoExportCompletedMeeting).mock
    .calls[0][0];
  expect(exported).toMatchObject({
    status: "complete",
    notes: committed?.notes,
    notesVersion: 2,
    notesHistory: committed?.notesHistory,
    notesLastEditedBy: "synthetic-editor",
    summarySentence: "Generated summary",
    summaryLabel: "Generated label",
  });
  expect(exported.recovery).toBeUndefined();
  expect(committed?.recovery?.disposition).toBe("needs_reconciliation");
});
