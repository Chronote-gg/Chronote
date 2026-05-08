import { jest } from "@jest/globals";
import { TRPCError } from "@trpc/server";
import type { MeetingHistory } from "../../types/db";
import type { TrpcContext } from "../context";
import { notionRouter } from "./notion";
import { ensureUserInGuild } from "../../services/guildAccessService";
import { ensureUserCanAccessMeeting } from "../../services/meetingAccessService";
import { getMeetingHistoryService } from "../../services/meetingHistoryService";
import {
  exportMeetingToNotion,
  getMeetingNotionExportStatus,
  getNotionStatus,
  NotionApiError,
} from "../../services/notionService";

jest.mock("../../services/guildAccessService", () => ({
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
  getMeetingNotionExportStatus: jest.fn(),
  getNotionStatus: jest.fn(),
  syncMeetingToNotion: jest.fn(),
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

const createCaller = () =>
  notionRouter.createCaller({
    req: { session: {} },
    res: {},
    user: { id: "user-1", accessToken: "discord-access-token" },
  } as TrpcContext);

describe("notionRouter", () => {
  beforeEach(() => {
    jest.mocked(ensureUserInGuild).mockResolvedValue(true);
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
    jest.mocked(getMeetingNotionExportStatus).mockResolvedValue({
      exported: true,
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
        meetingId: meeting.meetingId,
      }),
    ).resolves.toMatchObject({ outdated: true });
    expect(getMeetingNotionExportStatus).toHaveBeenCalledWith({
      userId: "user-1",
      guildId: "guild-1",
      meetingId: meeting.meetingId,
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
        meetingId: meeting.meetingId,
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
        meetingId: meeting.meetingId,
      }),
    ).rejects.toMatchObject<Partial<TRPCError>>({
      code: "BAD_REQUEST",
      message: "Connect Notion first.",
    });
  });
});
