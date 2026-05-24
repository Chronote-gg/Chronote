import { jest } from "@jest/globals";
import type { MeetingHistory } from "../../src/types/db";
import type {
  NotionAutomationConfig,
  NotionAutomationMeetingExport,
} from "../../src/types/notionIntegration";

const mockRepository = {
  writeConnection: jest.fn(async () => undefined),
  getConnection: jest.fn(async () => undefined),
  deleteConnection: jest.fn(async () => undefined),
  writeAutomationConfig: jest.fn(async () => undefined),
  getAutomationConfig: jest.fn(async () => undefined),
  reserveMeetingExport: jest.fn(async () => true),
  writeMeetingExport: jest.fn(async () => undefined),
  deleteMeetingExport: jest.fn(async () => undefined),
  getMeetingExport: jest.fn(async () => undefined),
  reserveAutomationMeetingExport: jest.fn(async () => true),
  writeAutomationMeetingExport: jest.fn(async () => undefined),
  deleteAutomationMeetingExport: jest.fn(async () => undefined),
  getAutomationMeetingExport: jest.fn(async () => undefined),
};

jest.mock("../../src/services/configService", () => ({
  config: { notion: { enabled: true } },
}));

jest.mock("../../src/repositories/notionIntegrationRepository", () => ({
  getNotionIntegrationRepository: () => mockRepository,
}));

jest.mock("../../src/services/notionService", () => ({
  NotionApiError: class NotionApiError extends Error {
    constructor(
      readonly status: number,
      readonly code: string,
      message: string,
    ) {
      super(message);
      this.name = "NotionApiError";
    }
  },
  exportMeetingToNotionAutomation: jest.fn(),
  syncMeetingToNotionAutomation: jest.fn(),
}));

import { config } from "../../src/services/configService";
import {
  exportMeetingToNotionAutomation,
  syncMeetingToNotionAutomation,
} from "../../src/services/notionService";
import {
  maybeAutoExportCompletedMeeting,
  maybeAutoSyncMeetingNotes,
  retryNotionAutomationExport,
} from "../../src/services/notionAutomationService";

const meeting: MeetingHistory = {
  guildId: "guild-1",
  channelId_timestamp: "channel-1#2026-05-08T12:00:00.000Z",
  meetingId: "meeting-1",
  channelId: "channel-1",
  timestamp: "2026-05-08T12:00:00.000Z",
  notes: "Meeting notes",
  notesVersion: 4,
  participants: [],
  duration: 600,
  transcribeMeeting: true,
  generateNotes: true,
};

const automationConfig: NotionAutomationConfig = {
  guildId: meeting.guildId,
  ownerUserId: "user-1",
  workspaceId: "workspace-1",
  workspaceName: "Workspace One",
  destinationType: "page",
  destinationPageId: "parent-page-1",
  destinationTitle: "Meeting archive",
  autoExportEnabled: true,
  channelIds: [],
  tags: [],
  createdAt: "2026-05-08T12:00:00.000Z",
  updatedAt: "2026-05-08T12:00:00.000Z",
};

const existingExport: NotionAutomationMeetingExport = {
  guildId: meeting.guildId,
  channelId_timestamp: meeting.channelId_timestamp,
  ownerUserId: automationConfig.ownerUserId,
  notionPageId: "notion-page-1",
  notionPageUrl: "https://notion.so/notion-page-1",
  notionWorkspaceId: automationConfig.workspaceId,
  exportedNotesVersion: 2,
  status: "failed",
  attemptCount: 2,
  lastAttemptAt: "2026-05-08T12:05:00.000Z",
  lastExportedAt: "2026-05-08T12:02:00.000Z",
};

describe("notionAutomationService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    config.notion.enabled = true;
    mockRepository.getAutomationConfig.mockResolvedValue(automationConfig);
    mockRepository.getAutomationMeetingExport.mockResolvedValue(undefined);
    mockRepository.reserveAutomationMeetingExport.mockResolvedValue(true);
  });

  it("syncs the existing Notion page when retrying an automation export", async () => {
    const syncedExport: NotionAutomationMeetingExport = {
      ...existingExport,
      status: "exported",
      exportedNotesVersion: meeting.notesVersion ?? 1,
      attemptCount: existingExport.attemptCount + 1,
      lastAttemptAt: "2026-05-08T12:10:00.000Z",
      lastExportedAt: "2026-05-08T12:10:00.000Z",
      lastError: undefined,
    };
    mockRepository.getAutomationMeetingExport.mockResolvedValue(existingExport);
    jest.mocked(syncMeetingToNotionAutomation).mockResolvedValue(syncedExport);

    await expect(retryNotionAutomationExport(meeting)).resolves.toBe(
      syncedExport,
    );
    expect(syncMeetingToNotionAutomation).toHaveBeenCalledWith({
      userId: automationConfig.ownerUserId,
      meeting,
      existing: existingExport,
    });
    expect(exportMeetingToNotionAutomation).not.toHaveBeenCalled();
  });

  it("fails forced retries when another retry already reserved the export", async () => {
    mockRepository.reserveAutomationMeetingExport.mockResolvedValue(false);

    await expect(retryNotionAutomationExport(meeting)).rejects.toMatchObject({
      status: 409,
      code: "automation_retry_conflict",
      message:
        "Notion automation retry is already in progress. Try again shortly.",
    });
    expect(exportMeetingToNotionAutomation).not.toHaveBeenCalled();
    expect(syncMeetingToNotionAutomation).not.toHaveBeenCalled();
  });

  it("skips background exports and syncs when Notion is disabled", async () => {
    config.notion.enabled = false;

    await maybeAutoExportCompletedMeeting(meeting);
    await maybeAutoSyncMeetingNotes(meeting);

    expect(mockRepository.getAutomationConfig).not.toHaveBeenCalled();
    expect(exportMeetingToNotionAutomation).not.toHaveBeenCalled();
    expect(syncMeetingToNotionAutomation).not.toHaveBeenCalled();
  });
});
