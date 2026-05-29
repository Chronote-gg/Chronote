import { jest } from "@jest/globals";
import { TRPCError } from "@trpc/server";
import type { MeetingHistory } from "../../types/db";
import type { TrpcContext } from "../context";
import { notionRouter } from "./notion";
import {
  ensureManageGuildWithUserToken,
  ensureUserInGuild,
} from "../../services/guildAccessService";
import { ensureUserCanAccessMeeting } from "../../services/meetingAccessService";
import { getMeetingHistoryService } from "../../services/meetingHistoryService";
import {
  exportMeetingToNotion,
  getEffectiveMeetingNotionExportStatus,
  getNotionAutomationStatus,
  getNotionStatus,
  listNotionDestinationPages,
  NotionApiError,
  saveNotionAutomationConfig,
  setNotionAutomationEnabled,
} from "../../services/notionService";
import { retryNotionAutomationExport } from "../../services/notionAutomationService";

jest.mock("../../services/guildAccessService", () => ({
  ensureManageGuildWithUserToken: jest.fn(),
  ensureUserInGuild: jest.fn(),
}));

jest.mock("../../services/configService", () => ({
  config: { notion: { enabled: true } },
}));

jest.mock("../../services/meetingAccessService", () => ({
  ensureUserCanAccessMeeting: jest.fn(),
}));

jest.mock("../../services/meetingHistoryService", () => ({
  getMeetingHistoryService: jest.fn(),
}));

jest.mock("../../services/unifiedConfigService", () => ({
  getSnapshotBoolean: jest.fn(() => true),
  resolveConfigSnapshot: jest.fn(async () => ({})),
}));

jest.mock("../../services/notionService", () => ({
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
  exportMeetingToNotion: jest.fn(),
  getEffectiveMeetingNotionExportStatus: jest.fn(),
  getNotionAutomationStatus: jest.fn(),
  getNotionStatus: jest.fn(),
  listNotionDestinationPages: jest.fn(),
  saveNotionAutomationConfig: jest.fn(),
  setNotionAutomationEnabled: jest.fn(),
  syncMeetingToNotion: jest.fn(),
}));

jest.mock("../../services/notionAutomationService", () => ({
  retryNotionAutomationExport: jest.fn(),
}));

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

const personalMeeting: MeetingHistory = {
  ...meeting,
  guildId: "personal:user-1",
  channelId_timestamp: "personal#2026-05-08T12:00:00.000Z",
  channelId: "personal",
  ownershipScope: "personal",
  ownerUserId: "user-1",
  meetingCreatorId: "user-1",
};

const meetingHistoryKey = meeting.channelId_timestamp;

const createCaller = () =>
  notionRouter.createCaller({
    req: { session: {} },
    res: {},
    user: { id: "user-1", accessToken: "discord-access-token" },
  } as TrpcContext);

describe("notionRouter", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(ensureUserInGuild).mockResolvedValue(true);
    jest.mocked(ensureManageGuildWithUserToken).mockResolvedValue(true);
    jest.mocked(ensureUserCanAccessMeeting).mockResolvedValue(true);
    jest.mocked(getMeetingHistoryService).mockResolvedValue(meeting);
  });

  it("returns the authenticated user's Notion connection status", async () => {
    jest.mocked(getNotionStatus).mockResolvedValue({
      configured: true,
      connected: true,
      workspaceName: "Workspace One",
      workspaceId: "workspace-1",
    });

    await expect(createCaller().status()).resolves.toMatchObject({
      connected: true,
      workspaceName: "Workspace One",
    });
    expect(getNotionStatus).toHaveBeenCalledWith("user-1");
  });

  it("uses the meeting notes version when returning export status", async () => {
    jest.mocked(getEffectiveMeetingNotionExportStatus).mockResolvedValue({
      exported: true,
      source: "manual",
      pageUrl: "https://notion.so/page-1",
      pageId: "page-1",
      exportedNotesVersion: 3,
      currentNotesVersion: 4,
      outdated: true,
      lastExportedAt: "2026-05-08T12:10:00.000Z",
    });

    await expect(
      createCaller().exportStatus({
        serverId: "guild-1",
        meetingId: meetingHistoryKey,
      }),
    ).resolves.toMatchObject({ outdated: true });
    expect(getMeetingHistoryService).toHaveBeenCalledWith(
      "guild-1",
      meetingHistoryKey,
    );
    expect(getEffectiveMeetingNotionExportStatus).toHaveBeenCalledWith({
      userId: "user-1",
      guildId: "guild-1",
      meetingId: meetingHistoryKey,
      currentNotesVersion: 4,
    });
    expect(ensureUserCanAccessMeeting).toHaveBeenCalledWith({
      guildId: "guild-1",
      meeting,
      userId: "user-1",
      attendeeOverrideEnabled: true,
    });
  });

  it("rejects Notion actions when the user cannot access the meeting", async () => {
    jest.mocked(ensureUserCanAccessMeeting).mockResolvedValue(false);

    await expect(
      createCaller().exportMeeting({
        serverId: "guild-1",
        meetingId: meetingHistoryKey,
      }),
    ).rejects.toMatchObject<Partial<TRPCError>>({
      code: "FORBIDDEN",
      message: "Meeting access required.",
    });
    expect(exportMeetingToNotion).not.toHaveBeenCalled();
  });

  it("maps missing Notion connections to a user-actionable bad request", async () => {
    jest
      .mocked(exportMeetingToNotion)
      .mockRejectedValue(
        new NotionApiError(401, "not_connected", "Connect Notion first."),
      );

    await expect(
      createCaller().exportMeeting({
        serverId: "guild-1",
        meetingId: meetingHistoryKey,
      }),
    ).rejects.toMatchObject<Partial<TRPCError>>({
      code: "BAD_REQUEST",
      message: "Connect Notion first.",
    });
  });

  it("lists Notion destination pages for server managers", async () => {
    jest.mocked(listNotionDestinationPages).mockResolvedValue([
      {
        id: "page-1",
        title: "Meeting archive",
        url: "https://notion.so/page-1",
      },
    ]);

    await expect(
      createCaller().destinationPages({
        serverId: "guild-1",
        query: "meeting",
      }),
    ).resolves.toEqual({
      pages: [
        {
          id: "page-1",
          title: "Meeting archive",
          url: "https://notion.so/page-1",
        },
      ],
    });
    expect(listNotionDestinationPages).toHaveBeenCalledWith({
      userId: "user-1",
      query: "meeting",
    });
  });

  it("saves and disables Notion automation config for server managers", async () => {
    jest.mocked(saveNotionAutomationConfig).mockResolvedValue({
      guildId: "guild-1",
      ownerUserId: "user-1",
      workspaceId: "workspace-1",
      destinationType: "page",
      destinationPageId: "page-1",
      autoExportEnabled: true,
      channelIds: ["channel-1"],
      tags: ["recap"],
      createdAt: "2026-05-08T12:00:00.000Z",
      updatedAt: "2026-05-08T12:00:00.000Z",
    });
    jest.mocked(setNotionAutomationEnabled).mockResolvedValue(undefined);

    await expect(
      createCaller().saveAutomationConfig({
        serverId: "guild-1",
        destinationPageId: "page-1",
        autoExportEnabled: true,
        channelIds: ["channel-1"],
        tags: ["recap"],
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(saveNotionAutomationConfig).toHaveBeenCalledWith({
      guildId: "guild-1",
      userId: "user-1",
      destinationPageId: "page-1",
      autoExportEnabled: true,
      channelIds: ["channel-1"],
      tags: ["recap"],
    });

    await expect(
      createCaller().disableAutomation({ serverId: "guild-1" }),
    ).resolves.toEqual({ ok: true });
    expect(setNotionAutomationEnabled).toHaveBeenCalledWith({
      guildId: "guild-1",
      enabled: false,
    });
  });

  it("returns Notion automation status for guild members", async () => {
    jest.mocked(getNotionAutomationStatus).mockResolvedValue({
      configured: true,
      userConnected: true,
      workspaceName: "Workspace One",
      workspaceId: "workspace-1",
      automation: {
        enabled: true,
        ownerUserId: "user-1",
        ownerConnected: true,
        workspaceName: "Workspace One",
        workspaceId: "workspace-1",
        destinationType: "page",
        destinationPageId: "page-1",
        destinationTitle: "Meeting archive",
        channelIds: [],
        tags: [],
        updatedAt: "2026-05-08T12:00:00.000Z",
      },
    });

    await expect(
      createCaller().automationStatus({ serverId: "guild-1" }),
    ).resolves.toMatchObject({ automation: { enabled: true } });
    expect(getNotionAutomationStatus).toHaveBeenCalledWith({
      guildId: "guild-1",
      userId: "user-1",
    });
  });

  it("retries Notion automation export for server managers", async () => {
    jest.mocked(retryNotionAutomationExport).mockResolvedValue({
      guildId: "guild-1",
      channelId_timestamp: meetingHistoryKey,
      ownerUserId: "user-1",
      notionPageId: "page-1",
      notionPageUrl: "https://notion.so/page-1",
      notionWorkspaceId: "workspace-1",
      exportedNotesVersion: 4,
      status: "exported",
      attemptCount: 2,
      lastAttemptAt: "2026-05-08T12:10:00.000Z",
      lastExportedAt: "2026-05-08T12:10:00.000Z",
    });

    await expect(
      createCaller().retryAutomationExport({
        serverId: "guild-1",
        meetingId: meetingHistoryKey,
      }),
    ).resolves.toMatchObject({
      ok: true,
      pageUrl: "https://notion.so/page-1",
      exportedNotesVersion: 4,
    });
    expect(retryNotionAutomationExport).toHaveBeenCalledWith(meeting);
  });

  it("maps concurrent Notion automation retries to conflict", async () => {
    jest
      .mocked(retryNotionAutomationExport)
      .mockRejectedValue(
        new NotionApiError(
          409,
          "automation_retry_conflict",
          "Notion automation retry is already in progress. Try again shortly.",
        ),
      );

    await expect(
      createCaller().retryAutomationExport({
        serverId: "guild-1",
        meetingId: meetingHistoryKey,
      }),
    ).rejects.toMatchObject<Partial<TRPCError>>({
      code: "CONFLICT",
      message:
        "Notion automation retry is already in progress. Try again shortly.",
    });
  });

  it("returns personal Notion automation status for the owner without guild checks", async () => {
    jest.mocked(getNotionAutomationStatus).mockResolvedValue({
      configured: true,
      userConnected: true,
      workspaceName: "Workspace One",
      workspaceId: "workspace-1",
    });

    await expect(
      createCaller().automationStatus({ serverId: "personal:user-1" }),
    ).resolves.toMatchObject({ userConnected: true });
    expect(ensureUserInGuild).not.toHaveBeenCalled();
    expect(getNotionAutomationStatus).toHaveBeenCalledWith({
      guildId: "personal:user-1",
      userId: "user-1",
    });
  });

  it("rejects personal Notion automation management for another user scope", async () => {
    await expect(
      createCaller().saveAutomationConfig({
        serverId: "personal:other-user",
        destinationPageId: "page-1",
        autoExportEnabled: true,
      }),
    ).rejects.toMatchObject<Partial<TRPCError>>({
      code: "FORBIDDEN",
      message: "Personal Notion automation can only be managed by its owner.",
    });
    expect(saveNotionAutomationConfig).not.toHaveBeenCalled();
  });

  it("exports accessible personal meetings without Discord guild membership", async () => {
    jest.mocked(getMeetingHistoryService).mockResolvedValue(personalMeeting);
    jest.mocked(exportMeetingToNotion).mockResolvedValue({
      userId: "user-1",
      guildId: personalMeeting.guildId,
      channelId_timestamp: personalMeeting.channelId_timestamp,
      notionPageId: "page-1",
      notionPageUrl: "https://notion.so/page-1",
      notionWorkspaceId: "workspace-1",
      exportedNotesVersion: 4,
      lastExportedAt: "2026-05-08T12:10:00.000Z",
    });

    await expect(
      createCaller().exportMeeting({
        serverId: personalMeeting.guildId,
        meetingId: personalMeeting.channelId_timestamp,
      }),
    ).resolves.toMatchObject({ ok: true, pageUrl: "https://notion.so/page-1" });
    expect(ensureUserInGuild).not.toHaveBeenCalled();
    expect(ensureUserCanAccessMeeting).toHaveBeenCalledWith({
      guildId: personalMeeting.guildId,
      meeting: personalMeeting,
      userId: "user-1",
      attendeeOverrideEnabled: true,
    });
  });
});
