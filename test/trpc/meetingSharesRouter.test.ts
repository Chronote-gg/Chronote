import type { Request, Response } from "express";
import type { MeetingHistory } from "../../src/types/db";
import { getMockUser } from "../../src/repositories/mockStore";
import { appRouter } from "../../src/trpc/router";
import {
  ensureBotInGuild,
  ensureManageGuildWithUserToken,
  ensureUserInGuild,
} from "../../src/services/guildAccessService";
import {
  ensureUserCanManageChannel,
  ensureUserCanViewChannel,
} from "../../src/services/discordPermissionsService";
import {
  getSnapshotEnum,
  resolveConfigSnapshot,
} from "../../src/services/unifiedConfigService";
import { getMeetingHistoryService } from "../../src/services/meetingHistoryService";
import {
  buildSharedMeetingPayloadService,
  type SharedMeetingPayload,
} from "../../src/services/meetingSharePayloadService";
import {
  getMeetingShareRecordByShareIdService,
  getMeetingShareStateForMeetingService,
  setMeetingShareVisibilityService,
} from "../../src/services/meetingShareService";

jest.mock("../../src/services/guildAccessService", () => ({
  ensureManageGuildWithUserToken: jest.fn(),
  ensureUserInGuild: jest.fn(),
  ensureBotInGuild: jest.fn(),
}));

jest.mock("../../src/services/discordPermissionsService", () => ({
  ensureUserCanViewChannel: jest.fn(),
  ensureUserCanManageChannel: jest.fn(),
}));

jest.mock("../../src/services/unifiedConfigService", () => ({
  resolveConfigSnapshot: jest.fn(),
  getSnapshotEnum: jest.fn(),
}));

jest.mock("../../src/services/meetingHistoryService", () => ({
  getMeetingHistoryService: jest.fn(),
  listRecentMeetingsForGuildService: jest.fn(),
  updateMeetingNotesService: jest.fn(),
  updateMeetingArchiveService: jest.fn(),
  updateMeetingNameService: jest.fn(),
}));

jest.mock("../../src/services/meetingSharePayloadService", () => ({
  buildSharedMeetingPayloadService: jest.fn(),
}));

jest.mock("../../src/services/meetingShareService", () => ({
  getMeetingShareRecordByShareIdService: jest.fn(),
  getMeetingShareStateForMeetingService: jest.fn(),
  setMeetingShareVisibilityService: jest.fn(),
}));

const buildCaller = (user = getMockUser()) =>
  appRouter.createCaller({
    req: { session: {} } as Request,
    res: { setHeader: jest.fn() } as unknown as Response,
    user,
  });

const buildMeeting = (
  overrides: Partial<MeetingHistory> = {},
): MeetingHistory => ({
  guildId: "guild-1",
  channelId_timestamp: "channel-1#2025-01-01T00:00:00.000Z",
  meetingId: "meeting-1",
  channelId: "channel-1",
  timestamp: "2025-01-01T00:00:00.000Z",
  participants: [{ id: "user-1", username: "Tester" }],
  duration: 120,
  transcribeMeeting: true,
  generateNotes: true,
  notes: "# Notes",
  ...overrides,
});

const sharedPayload: SharedMeetingPayload = {
  meeting: {
    title: "Weekly sync",
    timestamp: "2025-01-01T00:00:00.000Z",
    duration: 120,
    tags: [],
    notes: "# Notes",
    transcript: "hello",
    attendees: ["Tester"],
    events: [],
  },
};

describe("meetingShares router", () => {
  const mockedEnsureUserInGuild = jest.mocked(ensureUserInGuild);
  const mockedEnsureBotInGuild = jest.mocked(ensureBotInGuild);
  const mockedEnsureManageGuild = jest.mocked(ensureManageGuildWithUserToken);
  const mockedEnsureUserCanManageChannel = jest.mocked(
    ensureUserCanManageChannel,
  );
  const mockedEnsureUserCanViewChannel = jest.mocked(ensureUserCanViewChannel);
  const mockedResolveConfigSnapshot = jest.mocked(resolveConfigSnapshot);
  const mockedGetSnapshotEnum = jest.mocked(getSnapshotEnum);
  const mockedGetMeetingHistory = jest.mocked(getMeetingHistoryService);
  const mockedBuildSharedPayload = jest.mocked(
    buildSharedMeetingPayloadService,
  );
  const mockedGetShareById = jest.mocked(getMeetingShareRecordByShareIdService);
  const mockedGetShareState = jest.mocked(
    getMeetingShareStateForMeetingService,
  );
  const mockedSetVisibility = jest.mocked(setMeetingShareVisibilityService);

  beforeEach(() => {
    jest.resetAllMocks();
    mockedEnsureUserInGuild.mockResolvedValue(true);
    mockedEnsureBotInGuild.mockResolvedValue(true);
    mockedEnsureManageGuild.mockResolvedValue(true);
    mockedEnsureUserCanManageChannel.mockResolvedValue(true);
    mockedEnsureUserCanViewChannel.mockResolvedValue(true);
    mockedResolveConfigSnapshot.mockResolvedValue({
      values: {},
      missingRequired: [],
      experimentalEnabled: false,
    });
    mockedGetSnapshotEnum.mockReturnValue("public");
    mockedGetMeetingHistory.mockResolvedValue(buildMeeting());
    mockedBuildSharedPayload.mockResolvedValue(sharedPayload);
    mockedGetShareById.mockResolvedValue({
      pk: "GUILD#guild-1",
      sk: "SHARE#share-1",
      type: "meetingShare",
      guildId: "guild-1",
      meetingId: "meeting-1",
      shareId: "share-1",
      visibility: "public",
      sharedAt: "2025-01-01T00:00:00.000Z",
      sharedByUserId: "user-1",
      sharedByTag: "tester",
    });
    mockedGetShareState.mockResolvedValue({
      visibility: "server",
      shareId: "share-1",
      rotated: false,
      sharedAt: "2025-01-01T00:00:00.000Z",
      sharedByUserId: "user-1",
      sharedByTag: "tester",
    });
    mockedSetVisibility.mockResolvedValue({
      visibility: "server",
      shareId: "share-2",
      rotated: true,
      sharedAt: "2025-01-01T00:00:00.000Z",
      sharedByUserId: "user-1",
      sharedByTag: "tester",
    });
  });

  test("requires public acknowledgment before enabling public sharing", async () => {
    mockedGetSnapshotEnum.mockReturnValue("public");

    await expect(
      buildCaller().meetingShares.setVisibility({
        serverId: "guild-1",
        meetingId: "meeting-1",
        visibility: "public",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(mockedSetVisibility).not.toHaveBeenCalled();
  });

  test("rotate downgrades existing public links to server when policy is server", async () => {
    mockedGetSnapshotEnum.mockReturnValue("server");
    mockedGetShareState.mockResolvedValue({
      visibility: "public",
      shareId: "share-public",
      rotated: false,
    });

    await buildCaller().meetingShares.rotate({
      serverId: "guild-1",
      meetingId: "meeting-1",
    });

    expect(mockedSetVisibility).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: "guild-1",
        meetingId: "meeting-1",
        visibility: "server",
        forceRotate: true,
      }),
    );
  });

  test("requires manage channel permission for auto-record meetings", async () => {
    mockedEnsureManageGuild.mockResolvedValue(false);
    mockedEnsureUserCanManageChannel.mockResolvedValue(false);
    mockedGetMeetingHistory.mockResolvedValue(
      buildMeeting({
        isAutoRecording: true,
        meetingCreatorId: "user-2",
      }),
    );

    await expect(
      buildCaller().meetingShares.setVisibility({
        serverId: "guild-1",
        meetingId: "meeting-1",
        visibility: "server",
      }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Manage channel permission required",
    });
  });

  test("allows auto-record meeting creator to share without manage channel", async () => {
    const user = getMockUser();
    mockedEnsureManageGuild.mockResolvedValue(false);
    mockedEnsureUserCanManageChannel.mockResolvedValue(false);
    mockedGetMeetingHistory.mockResolvedValue(
      buildMeeting({
        isAutoRecording: true,
        meetingCreatorId: user.id,
      }),
    );

    await expect(
      buildCaller(user).meetingShares.setVisibility({
        serverId: "guild-1",
        meetingId: "meeting-1",
        visibility: "server",
      }),
    ).resolves.toBeDefined();
    expect(mockedSetVisibility).toHaveBeenCalled();
  });

  test("requires share permission before returning share state", async () => {
    mockedEnsureManageGuild.mockResolvedValue(false);
    mockedGetMeetingHistory.mockResolvedValue(
      buildMeeting({
        meetingCreatorId: "someone-else",
        isAutoRecording: false,
      }),
    );

    await expect(
      buildCaller().meetingShares.getShareState({
        serverId: "guild-1",
        meetingId: "meeting-1",
      }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Only the meeting starter can share this meeting",
    });
    expect(mockedGetShareState).not.toHaveBeenCalled();
  });

  test("public endpoint returns not found for non-public share records", async () => {
    mockedGetShareById.mockResolvedValue({
      pk: "GUILD#guild-1",
      sk: "SHARE#share-1",
      type: "meetingShare",
      guildId: "guild-1",
      meetingId: "meeting-1",
      shareId: "share-1",
      visibility: "server",
      sharedAt: "2025-01-01T00:00:00.000Z",
      sharedByUserId: "user-1",
    });

    await expect(
      buildCaller().meetingShares.getPublicMeeting({
        serverId: "guild-1",
        shareId: "share-1",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  test("shared endpoint returns not found for public share when policy is server", async () => {
    mockedGetSnapshotEnum.mockReturnValue("server");
    mockedGetShareById.mockResolvedValue({
      pk: "GUILD#guild-1",
      sk: "SHARE#share-1",
      type: "meetingShare",
      guildId: "guild-1",
      meetingId: "meeting-1",
      shareId: "share-1",
      visibility: "public",
      sharedAt: "2025-01-01T00:00:00.000Z",
      sharedByUserId: "user-1",
    });

    await expect(
      buildCaller().meetingShares.getSharedMeeting({
        serverId: "guild-1",
        shareId: "share-1",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  test("shared endpoint requires channel view access", async () => {
    mockedEnsureUserCanViewChannel.mockResolvedValue(false);

    await expect(
      buildCaller().meetingShares.getSharedMeeting({
        serverId: "guild-1",
        shareId: "share-1",
      }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Channel access required",
    });
  });
});
