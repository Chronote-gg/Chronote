import { jest } from "@jest/globals";
import {
  getGuildMemberCached,
  listBotGuildsCached,
  listGuildChannelsCached,
  listGuildRolesCached,
} from "../discordCacheService";
import { checkUserMeetingAccess } from "../meetingAccessService";
import {
  getMeetingHistoryService,
  listMeetingsForGuildInRangeService,
  listRecentMeetingsForGuildService,
} from "../meetingHistoryService";
import { listMeetingUserIndexForUserInRangeService } from "../meetingUserIndexService";
import {
  getMcpMeetingSummary,
  getMcpMeetingTranscript,
  listMcpMeetings,
  listMcpMyMeetings,
  listMcpServersForUser,
} from "../mcpMeetingService";
import { resolveConfigSnapshot } from "../unifiedConfigService";
import { fetchJsonFromS3 } from "../storageService";
import type { MeetingHistory } from "../../types/db";
import { MEETING_STATUS } from "../../types/meetingLifecycle";

jest.mock("../discordService", () => ({
  isDiscordApiError: jest.fn(() => false),
}));

jest.mock("../discordCacheService", () => ({
  getGuildMemberCached: jest.fn(),
  listBotGuildsCached: jest.fn(),
  listGuildChannelsCached: jest.fn(),
  listGuildRolesCached: jest.fn(async () => []),
}));

jest.mock("../meetingAccessService", () => ({
  checkUserMeetingAccess: jest.fn(),
}));

jest.mock("../meetingHistoryService", () => ({
  getMeetingHistoryService: jest.fn(),
  listMeetingsForGuildInRangeService: jest.fn(),
  listRecentMeetingsForGuildService: jest.fn(),
}));

jest.mock("../meetingUserIndexService", () => ({
  listMeetingUserIndexForUserInRangeService: jest.fn(),
}));

jest.mock("../storageService", () => ({
  fetchJsonFromS3: jest.fn(),
}));

jest.mock("../unifiedConfigService", () => ({
  getSnapshotBoolean: jest.fn(() => true),
  resolveConfigSnapshot: jest.fn(() => Promise.resolve({})),
}));

const createMeeting = (
  meetingId: string,
  overrides: Partial<MeetingHistory> = {},
): MeetingHistory => ({
  guildId: overrides.guildId ?? "guild-1",
  channelId: overrides.channelId ?? "channel-1",
  channelId_timestamp:
    overrides.channelId_timestamp ??
    `${overrides.channelId ?? "channel-1"}#${overrides.timestamp ?? "2026-01-01T00:00:00.000Z"}-${meetingId}`,
  meetingId,
  timestamp: overrides.timestamp ?? "2026-01-01T00:00:00.000Z",
  participants: overrides.participants ?? [],
  duration: overrides.duration ?? 120,
  transcribeMeeting: true,
  generateNotes: true,
  ...overrides,
});

describe("mcpMeetingService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(getGuildMemberCached).mockResolvedValue({ roles: [] });
    jest.mocked(listBotGuildsCached).mockResolvedValue([]);
    jest
      .mocked(listGuildChannelsCached)
      .mockResolvedValue([{ id: "channel-1", name: "Meeting Room", type: 2 }]);
  });

  it("skips inaccessible meetings while listing accessible ones", async () => {
    jest
      .mocked(listRecentMeetingsForGuildService)
      .mockResolvedValue([createMeeting("allowed"), createMeeting("blocked")]);
    jest.mocked(checkUserMeetingAccess).mockResolvedValueOnce({
      allowed: true,
      via: "attendee",
    });
    jest.mocked(checkUserMeetingAccess).mockResolvedValueOnce({
      allowed: false,
      missing: ["voice_connect"],
    });

    await expect(
      listMcpMeetings({ userId: "user-1", guildId: "guild-1" }),
    ).resolves.toMatchObject({
      meetings: [{ meetingId: "allowed", channelName: "Meeting Room" }],
    });
  });

  it("applies the meeting limit after access filtering", async () => {
    jest
      .mocked(listRecentMeetingsForGuildService)
      .mockResolvedValue([
        createMeeting("blocked"),
        createMeeting("allowed-1"),
        createMeeting("allowed-2"),
      ]);
    jest.mocked(checkUserMeetingAccess).mockResolvedValueOnce({
      allowed: false,
      missing: ["voice_connect"],
    });
    jest.mocked(checkUserMeetingAccess).mockResolvedValueOnce({
      allowed: true,
      via: "attendee",
    });
    jest.mocked(checkUserMeetingAccess).mockResolvedValueOnce({
      allowed: true,
      via: "attendee",
    });

    await expect(
      listMcpMeetings({ userId: "user-1", guildId: "guild-1", limit: 2 }),
    ).resolves.toMatchObject({
      meetings: [{ meetingId: "allowed-1" }, { meetingId: "allowed-2" }],
    });
    expect(listRecentMeetingsForGuildService).toHaveBeenCalledWith(
      "guild-1",
      10,
      { includeArchived: undefined },
    );
  });

  it("caps date-range scans before access filtering", async () => {
    jest.mocked(listMeetingsForGuildInRangeService).mockResolvedValue([]);

    await expect(
      listMcpMeetings({
        userId: "user-1",
        guildId: "guild-1",
        startDate: "2026-01-01T00:00:00.000Z",
        endDate: "2026-02-01T00:00:00.000Z",
        limit: 10,
      }),
    ).resolves.toEqual({ meetings: [] });
    expect(listMeetingsForGuildInRangeService).toHaveBeenCalledWith(
      "guild-1",
      "2026-01-01T00:00:00.000Z",
      "2026-02-01T00:00:00.000Z",
      50,
    );
  });

  it("returns an empty meeting list when the caller is no longer in the guild", async () => {
    jest
      .mocked(listRecentMeetingsForGuildService)
      .mockResolvedValue([createMeeting("meeting-1")]);
    jest.mocked(getGuildMemberCached).mockRejectedValue(new Error("missing"));

    await expect(
      listMcpMeetings({ userId: "user-1", guildId: "guild-1" }),
    ).resolves.toEqual({ meetings: [] });
    expect(checkUserMeetingAccess).not.toHaveBeenCalled();
  });

  it("returns an empty meeting list for non-positive direct service limits", async () => {
    await expect(
      listMcpMeetings({ userId: "user-1", guildId: "guild-1", limit: 0 }),
    ).resolves.toEqual({ meetings: [] });

    expect(listRecentMeetingsForGuildService).not.toHaveBeenCalled();
    expect(getGuildMemberCached).not.toHaveBeenCalled();
  });

  it("reuses guild membership and config checks while listing meetings", async () => {
    jest
      .mocked(listRecentMeetingsForGuildService)
      .mockResolvedValue([
        createMeeting("meeting-1"),
        createMeeting("meeting-2"),
      ]);
    jest.mocked(checkUserMeetingAccess).mockResolvedValue({
      allowed: true,
      via: "attendee",
    });

    await expect(
      listMcpMeetings({ userId: "user-1", guildId: "guild-1", limit: 2 }),
    ).resolves.toMatchObject({
      meetings: [{ meetingId: "meeting-1" }, { meetingId: "meeting-2" }],
    });

    expect(getGuildMemberCached).toHaveBeenCalledTimes(1);
    expect(resolveConfigSnapshot).toHaveBeenCalledTimes(1);
    expect(checkUserMeetingAccess).toHaveBeenCalledTimes(2);
  });

  it("lists attended meetings across servers in chronological order", async () => {
    const indexedMeeting = createMeeting("indexed", {
      guildId: "guild-2",
      timestamp: "2026-01-03T00:00:00.000Z",
      channelId_timestamp: "channel-1#2026-01-03T00:00:00.000Z",
      participants: [{ id: "user-1", username: "user1" }],
    });
    const fallbackMeeting = createMeeting("fallback", {
      guildId: "guild-1",
      timestamp: "2026-01-02T00:00:00.000Z",
      channelId_timestamp: "channel-1#2026-01-02T00:00:00.000Z",
      participants: [{ id: "user-1", username: "user1" }],
    });
    const inaccessibleByMode = createMeeting("not-attended", {
      guildId: "guild-1",
      timestamp: "2026-01-04T00:00:00.000Z",
      channelId_timestamp: "channel-1#2026-01-04T00:00:00.000Z",
      participants: [{ id: "other-user", username: "other" }],
    });
    jest.mocked(listBotGuildsCached).mockResolvedValue([
      { id: "guild-1", name: "Guild 1", icon: null },
      { id: "guild-2", name: "Guild 2", icon: null },
    ]);
    jest.mocked(listMeetingUserIndexForUserInRangeService).mockResolvedValue([
      {
        userId: "user-1",
        userTimestamp:
          "2026-01-03T00:00:00.000Z#guild-2#channel-1#2026-01-03T00:00:00.000Z",
        guildId: "guild-2",
        channelId_timestamp: "channel-1#2026-01-03T00:00:00.000Z",
        meetingId: "indexed",
        timestamp: "2026-01-03T00:00:00.000Z",
      },
    ]);
    jest.mocked(getMeetingHistoryService).mockResolvedValue(indexedMeeting);
    jest
      .mocked(listMeetingsForGuildInRangeService)
      .mockImplementation((guildId) =>
        Promise.resolve(
          guildId === "guild-1" ? [inaccessibleByMode, fallbackMeeting] : [],
        ),
      );
    jest.mocked(checkUserMeetingAccess).mockResolvedValue({
      allowed: true,
      via: "attendee",
    });

    await expect(
      listMcpMyMeetings({
        userId: "user-1",
        mode: "attended",
        startDate: "2026-01-01T00:00:00.000Z",
        endDate: "2026-01-05T00:00:00.000Z",
        limit: 2,
      }),
    ).resolves.toMatchObject({
      meetings: [
        { meetingId: "indexed", serverName: "Guild 2" },
        { meetingId: "fallback", serverName: "Guild 1" },
      ],
    });
  });

  it("lists indexed personal meetings without resolving Discord channels", async () => {
    const personalMeeting = createMeeting("personal-meeting", {
      guildId: "personal:user-1",
      channelId: "personal",
      channelId_timestamp: "personal#2026-01-03T00:00:00.000Z",
      ownershipScope: "personal",
      ownerUserId: "user-1",
      timestamp: "2026-01-03T00:00:00.000Z",
    });
    jest.mocked(listMeetingUserIndexForUserInRangeService).mockResolvedValue([
      {
        userId: "user-1",
        userTimestamp:
          "2026-01-03T00:00:00.000Z#personal:user-1#personal#2026-01-03T00:00:00.000Z",
        guildId: "personal:user-1",
        channelId_timestamp: "personal#2026-01-03T00:00:00.000Z",
        meetingId: "personal-meeting",
        timestamp: "2026-01-03T00:00:00.000Z",
        accessReason: "owner",
      },
    ]);
    jest.mocked(getMeetingHistoryService).mockResolvedValue(personalMeeting);
    jest.mocked(checkUserMeetingAccess).mockResolvedValue({
      allowed: true,
      via: "owner",
    });

    await expect(
      listMcpMyMeetings({
        userId: "user-1",
        mode: "attended",
        startDate: "2026-01-01T00:00:00.000Z",
        endDate: "2026-01-05T00:00:00.000Z",
        limit: 1,
      }),
    ).resolves.toMatchObject({
      meetings: [
        {
          meetingId: "personal-meeting",
          ownershipScope: "personal",
          serverName: "Personal",
          channelName: "Personal meeting",
        },
      ],
    });

    expect(listGuildChannelsCached).not.toHaveBeenCalled();
  });

  it("excludes cancelled meetings returned by the user index", async () => {
    const cancelledMeeting = createMeeting("cancelled", {
      guildId: "guild-1",
      timestamp: "2026-01-04T00:00:00.000Z",
      channelId_timestamp: "channel-1#2026-01-04T00:00:00.000Z",
      participants: [{ id: "user-1", username: "user1" }],
      status: MEETING_STATUS.CANCELLED,
    });
    const activeMeeting = createMeeting("active", {
      guildId: "guild-1",
      timestamp: "2026-01-03T00:00:00.000Z",
      channelId_timestamp: "channel-1#2026-01-03T00:00:00.000Z",
      participants: [{ id: "user-1", username: "user1" }],
    });
    jest
      .mocked(listBotGuildsCached)
      .mockResolvedValue([{ id: "guild-1", name: "Guild 1", icon: null }]);
    jest.mocked(listMeetingUserIndexForUserInRangeService).mockResolvedValue([
      {
        userId: "user-1",
        userTimestamp:
          "2026-01-04T00:00:00.000Z#guild-1#channel-1#2026-01-04T00:00:00.000Z",
        guildId: "guild-1",
        channelId_timestamp: "channel-1#2026-01-04T00:00:00.000Z",
        meetingId: "cancelled",
        timestamp: "2026-01-04T00:00:00.000Z",
      },
      {
        userId: "user-1",
        userTimestamp:
          "2026-01-03T00:00:00.000Z#guild-1#channel-1#2026-01-03T00:00:00.000Z",
        guildId: "guild-1",
        channelId_timestamp: "channel-1#2026-01-03T00:00:00.000Z",
        meetingId: "active",
        timestamp: "2026-01-03T00:00:00.000Z",
      },
    ]);
    jest
      .mocked(getMeetingHistoryService)
      .mockImplementation((_guildId, channelIdTimestamp) =>
        Promise.resolve(
          channelIdTimestamp === cancelledMeeting.channelId_timestamp
            ? cancelledMeeting
            : activeMeeting,
        ),
      );
    jest.mocked(listMeetingsForGuildInRangeService).mockResolvedValue([]);
    jest.mocked(checkUserMeetingAccess).mockResolvedValue({
      allowed: true,
      via: "attendee",
    });

    await expect(
      listMcpMyMeetings({
        userId: "user-1",
        mode: "attended",
        startDate: "2026-01-01T00:00:00.000Z",
        endDate: "2026-01-05T00:00:00.000Z",
      }),
    ).resolves.toMatchObject({
      meetings: [{ meetingId: "active", serverName: "Guild 1" }],
    });
    expect(checkUserMeetingAccess).toHaveBeenCalledTimes(1);
  });

  it("skips the guild-range fallback when indexed attended results fill the pagination probe", async () => {
    const indexedMeeting = createMeeting("indexed", {
      guildId: "guild-1",
      timestamp: "2026-01-03T00:00:00.000Z",
      channelId_timestamp: "channel-1#2026-01-03T00:00:00.000Z",
      participants: [{ id: "user-1", username: "user1" }],
    });
    const olderIndexedMeeting = createMeeting("older-indexed", {
      guildId: "guild-1",
      timestamp: "2026-01-02T00:00:00.000Z",
      channelId_timestamp: "channel-1#2026-01-02T00:00:00.000Z",
      participants: [{ id: "user-1", username: "user1" }],
    });
    jest
      .mocked(listBotGuildsCached)
      .mockResolvedValue([{ id: "guild-1", name: "Guild 1", icon: null }]);
    jest.mocked(listMeetingUserIndexForUserInRangeService).mockResolvedValue([
      {
        userId: "user-1",
        userTimestamp:
          "2026-01-03T00:00:00.000Z#guild-1#channel-1#2026-01-03T00:00:00.000Z",
        guildId: "guild-1",
        channelId_timestamp: "channel-1#2026-01-03T00:00:00.000Z",
        meetingId: "indexed",
        timestamp: "2026-01-03T00:00:00.000Z",
      },
      {
        userId: "user-1",
        userTimestamp:
          "2026-01-02T00:00:00.000Z#guild-1#channel-1#2026-01-02T00:00:00.000Z",
        guildId: "guild-1",
        channelId_timestamp: "channel-1#2026-01-02T00:00:00.000Z",
        meetingId: "older-indexed",
        timestamp: "2026-01-02T00:00:00.000Z",
      },
    ]);
    jest
      .mocked(getMeetingHistoryService)
      .mockImplementation((_guildId, channelIdTimestamp) =>
        Promise.resolve(
          channelIdTimestamp === indexedMeeting.channelId_timestamp
            ? indexedMeeting
            : olderIndexedMeeting,
        ),
      );
    jest.mocked(checkUserMeetingAccess).mockResolvedValue({
      allowed: true,
      via: "attendee",
    });

    await expect(
      listMcpMyMeetings({
        userId: "user-1",
        mode: "attended",
        startDate: "2026-01-01T00:00:00.000Z",
        endDate: "2026-01-05T00:00:00.000Z",
        limit: 1,
      }),
    ).resolves.toMatchObject({
      meetings: [{ meetingId: "indexed", serverName: "Guild 1" }],
      hasMore: true,
      nextCursor: expect.any(String),
    });
    expect(listMeetingsForGuildInRangeService).not.toHaveBeenCalled();
  });

  it("returns an all-time My Meetings page with a cursor when more visible meetings exist", async () => {
    const newestMeeting = createMeeting("newest", {
      guildId: "guild-page",
      timestamp: "2026-01-03T00:00:00.000Z",
      channelId_timestamp: "channel-1#2026-01-03T00:00:00.000Z",
    });
    const middleMeeting = createMeeting("middle", {
      guildId: "guild-page",
      timestamp: "2026-01-02T00:00:00.000Z",
      channelId_timestamp: "channel-1#2026-01-02T00:00:00.000Z",
    });
    const oldestMeeting = createMeeting("oldest", {
      guildId: "guild-page",
      timestamp: "2026-01-01T00:00:00.000Z",
      channelId_timestamp: "channel-1#2026-01-01T00:00:00.000Z",
    });
    jest
      .mocked(listBotGuildsCached)
      .mockResolvedValue([
        { id: "guild-page", name: "Guild Page", icon: null },
      ]);
    jest
      .mocked(listMeetingsForGuildInRangeService)
      .mockResolvedValue([newestMeeting, middleMeeting, oldestMeeting]);
    jest.mocked(checkUserMeetingAccess).mockResolvedValue({
      allowed: true,
      via: "channel_permissions",
    });

    const firstPage = await listMcpMyMeetings({
      userId: "user-page",
      mode: "accessible",
      range: "all",
      limit: 2,
    });

    expect(firstPage).toMatchObject({
      range: { startDate: "1970-01-01T00:00:00.000Z" },
      meetings: [
        { meetingId: "newest", serverName: "Guild Page" },
        { meetingId: "middle", serverName: "Guild Page" },
      ],
      hasMore: true,
      nextCursor: expect.any(String),
    });
    expect(listMeetingsForGuildInRangeService).toHaveBeenCalledWith(
      "guild-page",
      "1970-01-01T00:00:00.000Z",
      expect.any(String),
      15,
    );
  });

  it("uses a My Meetings cursor to fetch only older visible meetings", async () => {
    const newestMeeting = createMeeting("newest", {
      guildId: "guild-cursor",
      timestamp: "2026-01-03T00:00:00.000Z",
      channelId_timestamp: "channel-1#2026-01-03T00:00:00.000Z",
    });
    const middleMeeting = createMeeting("middle", {
      guildId: "guild-cursor",
      timestamp: "2026-01-02T00:00:00.000Z",
      channelId_timestamp: "channel-1#2026-01-02T00:00:00.000Z",
    });
    const oldestMeeting = createMeeting("oldest", {
      guildId: "guild-cursor",
      timestamp: "2026-01-01T00:00:00.000Z",
      channelId_timestamp: "channel-1#2026-01-01T00:00:00.000Z",
    });
    jest
      .mocked(listBotGuildsCached)
      .mockResolvedValue([
        { id: "guild-cursor", name: "Guild Cursor", icon: null },
      ]);
    jest
      .mocked(listMeetingsForGuildInRangeService)
      .mockResolvedValue([newestMeeting, middleMeeting, oldestMeeting]);
    jest.mocked(checkUserMeetingAccess).mockResolvedValue({
      allowed: true,
      via: "channel_permissions",
    });

    const firstPage = await listMcpMyMeetings({
      userId: "user-cursor",
      mode: "accessible",
      range: "all",
      limit: 2,
    });
    const secondPage = await listMcpMyMeetings({
      userId: "user-cursor",
      limit: 2,
      cursor: firstPage.nextCursor ?? undefined,
    });

    expect(secondPage).toMatchObject({
      meetings: [{ meetingId: "oldest", serverName: "Guild Cursor" }],
      hasMore: false,
      nextCursor: null,
    });
  });

  it("uses permission access mode without requiring participant membership", async () => {
    const accessibleMeeting = createMeeting("accessible", {
      guildId: "guild-1",
      timestamp: "2026-01-02T00:00:00.000Z",
      channelId_timestamp: "channel-1#2026-01-02T00:00:00.000Z",
      participants: [{ id: "other-user", username: "other" }],
    });
    jest
      .mocked(listBotGuildsCached)
      .mockResolvedValue([{ id: "guild-1", name: "Guild 1", icon: null }]);
    jest
      .mocked(listMeetingsForGuildInRangeService)
      .mockResolvedValue([accessibleMeeting]);
    jest.mocked(checkUserMeetingAccess).mockResolvedValue({
      allowed: true,
      via: "channel_permissions",
    });

    await expect(
      listMcpMyMeetings({
        userId: "user-1",
        mode: "accessible",
        startDate: "2026-01-01T00:00:00.000Z",
        endDate: "2026-01-05T00:00:00.000Z",
      }),
    ).resolves.toMatchObject({
      meetings: [{ meetingId: "accessible", serverName: "Guild 1" }],
    });
    expect(listMeetingUserIndexForUserInRangeService).not.toHaveBeenCalled();
  });

  it("filters archived-only My Meetings results before access checks", async () => {
    const activeMeeting = createMeeting("active", {
      guildId: "guild-1",
      timestamp: "2026-01-03T00:00:00.000Z",
      channelId_timestamp: "channel-1#2026-01-03T00:00:00.000Z",
    });
    const archivedMeeting = createMeeting("archived", {
      guildId: "guild-1",
      timestamp: "2026-01-02T00:00:00.000Z",
      channelId_timestamp: "channel-1#2026-01-02T00:00:00.000Z",
      archivedAt: "2026-01-04T00:00:00.000Z",
    });
    jest
      .mocked(listBotGuildsCached)
      .mockResolvedValue([{ id: "guild-1", name: "Guild 1", icon: null }]);
    jest
      .mocked(listMeetingsForGuildInRangeService)
      .mockResolvedValue([activeMeeting, archivedMeeting]);
    jest.mocked(checkUserMeetingAccess).mockResolvedValue({
      allowed: true,
      via: "channel_permissions",
    });

    await expect(
      listMcpMyMeetings({
        userId: "user-1",
        mode: "accessible",
        startDate: "2026-01-01T00:00:00.000Z",
        endDate: "2026-01-05T00:00:00.000Z",
        archivedOnly: true,
      }),
    ).resolves.toMatchObject({
      meetings: [{ meetingId: "archived", serverName: "Guild 1" }],
    });
    expect(checkUserMeetingAccess).toHaveBeenCalledTimes(1);
  });

  it("matches attended fallback meetings from legacy attendee mentions", async () => {
    const legacyMeeting = createMeeting("legacy", {
      guildId: "guild-1",
      timestamp: "2026-01-02T00:00:00.000Z",
      channelId_timestamp: "channel-1#2026-01-02T00:00:00.000Z",
      participants: [],
      attendees: ["<@123>"],
    });
    jest
      .mocked(listBotGuildsCached)
      .mockResolvedValue([{ id: "guild-1", name: "Guild 1", icon: null }]);
    jest
      .mocked(listMeetingUserIndexForUserInRangeService)
      .mockResolvedValue([]);
    jest
      .mocked(listMeetingsForGuildInRangeService)
      .mockResolvedValue([legacyMeeting]);
    jest.mocked(checkUserMeetingAccess).mockResolvedValue({
      allowed: true,
      via: "attendee",
    });

    await expect(
      listMcpMyMeetings({
        userId: "123",
        mode: "attended",
        startDate: "2026-01-01T00:00:00.000Z",
        endDate: "2026-01-05T00:00:00.000Z",
      }),
    ).resolves.toMatchObject({
      meetings: [{ meetingId: "legacy", serverName: "Guild 1" }],
    });
  });

  it("rejects custom My Meetings ranges without a start date", async () => {
    await expect(
      listMcpMyMeetings({ userId: "user-1", range: "custom" }),
    ).rejects.toMatchObject({
      code: "bad_request",
      message: "startDate is required when range is custom.",
    });

    expect(listBotGuildsCached).not.toHaveBeenCalled();
  });

  it("rejects preset My Meetings ranges with explicit date bounds", async () => {
    await expect(
      listMcpMyMeetings({
        userId: "user-1",
        range: "past_7_days",
        startDate: "2026-01-01T00:00:00.000Z",
        endDate: "2026-01-02T00:00:00.000Z",
      }),
    ).rejects.toMatchObject({
      code: "bad_request",
      message: "startDate and endDate are only allowed when range is custom.",
    });

    expect(listBotGuildsCached).not.toHaveBeenCalled();
  });

  it("normalizes custom My Meetings date bounds before querying", async () => {
    jest
      .mocked(listBotGuildsCached)
      .mockResolvedValue([{ id: "guild-1", name: "Guild 1", icon: null }]);
    jest
      .mocked(listMeetingUserIndexForUserInRangeService)
      .mockResolvedValue([]);
    jest.mocked(listMeetingsForGuildInRangeService).mockResolvedValue([]);

    await expect(
      listMcpMyMeetings({
        userId: "offset-user",
        mode: "attended",
        range: "custom",
        startDate: "2026-01-01T00:00:00-05:00",
        endDate: "2026-01-02T00:00:00+02:00",
      }),
    ).resolves.toEqual({
      range: {
        startDate: "2026-01-01T05:00:00.000Z",
        endDate: "2026-01-01T22:00:00.000Z",
      },
      mode: "attended",
      meetings: [],
      hasMore: false,
      nextCursor: null,
    });
    expect(listMeetingUserIndexForUserInRangeService).toHaveBeenCalledWith(
      "offset-user",
      "2026-01-01T05:00:00.000Z",
      "2026-01-01T22:00:00.000Z",
      130,
    );
    expect(listMeetingsForGuildInRangeService).toHaveBeenCalledWith(
      "guild-1",
      "2026-01-01T05:00:00.000Z",
      "2026-01-01T22:00:00.000Z",
      130,
    );
  });

  it("caches accessible server lists for repeated polling", async () => {
    jest.mocked(listBotGuildsCached).mockResolvedValue([
      { id: "guild-1", name: "Guild 1", icon: null },
      { id: "guild-2", name: "Guild 2", icon: null },
    ]);

    await expect(listMcpServersForUser("polling-user")).resolves.toEqual([
      { id: "guild-1", name: "Guild 1", icon: null },
      { id: "guild-2", name: "Guild 2", icon: null },
    ]);
    await expect(listMcpServersForUser("polling-user")).resolves.toEqual([
      { id: "guild-1", name: "Guild 1", icon: null },
      { id: "guild-2", name: "Guild 2", icon: null },
    ]);

    expect(listBotGuildsCached).toHaveBeenCalledTimes(1);
    expect(getGuildMemberCached).toHaveBeenCalledTimes(2);
  });

  it("skips stale indexed meetings when attended mode history fetch fails", async () => {
    const fallbackMeeting = createMeeting("fallback", {
      guildId: "guild-1",
      timestamp: "2026-01-02T00:00:00.000Z",
      channelId_timestamp: "channel-1#2026-01-02T00:00:00.000Z",
      participants: [{ id: "user-1", username: "user1" }],
    });
    jest
      .mocked(listBotGuildsCached)
      .mockResolvedValue([{ id: "guild-1", name: "Guild 1", icon: null }]);
    jest.mocked(listMeetingUserIndexForUserInRangeService).mockResolvedValue([
      {
        userId: "user-1",
        userTimestamp:
          "2026-01-03T00:00:00.000Z#guild-1#channel-1#2026-01-03T00:00:00.000Z",
        guildId: "guild-1",
        channelId_timestamp: "channel-1#2026-01-03T00:00:00.000Z",
        meetingId: "indexed",
        timestamp: "2026-01-03T00:00:00.000Z",
      },
    ]);
    jest.mocked(getMeetingHistoryService).mockRejectedValue(new Error("boom"));
    jest
      .mocked(listMeetingsForGuildInRangeService)
      .mockResolvedValue([fallbackMeeting]);
    jest.mocked(checkUserMeetingAccess).mockResolvedValue({
      allowed: true,
      via: "attendee",
    });

    await expect(
      listMcpMyMeetings({
        userId: "user-1",
        mode: "attended",
        startDate: "2026-01-01T00:00:00.000Z",
        endDate: "2026-01-05T00:00:00.000Z",
      }),
    ).resolves.toMatchObject({
      meetings: [{ meetingId: "fallback", serverName: "Guild 1" }],
    });
  });

  it("falls back to server ranges when attended mode index lookup fails", async () => {
    const fallbackMeeting = createMeeting("fallback", {
      guildId: "guild-1",
      timestamp: "2026-01-02T00:00:00.000Z",
      channelId_timestamp: "channel-1#2026-01-02T00:00:00.000Z",
      participants: [{ id: "user-1", username: "user1" }],
    });
    jest
      .mocked(listBotGuildsCached)
      .mockResolvedValue([{ id: "guild-1", name: "Guild 1", icon: null }]);
    jest
      .mocked(listMeetingUserIndexForUserInRangeService)
      .mockRejectedValue(new Error("index unavailable"));
    jest
      .mocked(listMeetingsForGuildInRangeService)
      .mockResolvedValue([fallbackMeeting]);
    jest.mocked(checkUserMeetingAccess).mockResolvedValue({
      allowed: true,
      via: "attendee",
    });

    await expect(
      listMcpMyMeetings({
        userId: "user-1",
        mode: "attended",
        startDate: "2026-01-01T00:00:00.000Z",
        endDate: "2026-01-05T00:00:00.000Z",
      }),
    ).resolves.toMatchObject({
      meetings: [{ meetingId: "fallback", serverName: "Guild 1" }],
    });

    expect(getMeetingHistoryService).not.toHaveBeenCalled();
  });

  it("skips servers whose My Meetings range fallback fails", async () => {
    const visibleMeeting = createMeeting("visible", {
      guildId: "guild-1",
      timestamp: "2026-01-02T00:00:00.000Z",
      channelId_timestamp: "channel-1#2026-01-02T00:00:00.000Z",
      participants: [{ id: "user-range", username: "userRange" }],
    });
    jest.mocked(listBotGuildsCached).mockResolvedValue([
      { id: "guild-1", name: "Guild 1", icon: null },
      { id: "guild-2", name: "Guild 2", icon: null },
    ]);
    jest
      .mocked(listMeetingUserIndexForUserInRangeService)
      .mockResolvedValue([]);
    jest
      .mocked(listMeetingsForGuildInRangeService)
      .mockImplementation((guildId) => {
        if (guildId === "guild-2") return Promise.reject(new Error("boom"));
        return Promise.resolve([visibleMeeting]);
      });
    jest.mocked(checkUserMeetingAccess).mockResolvedValue({
      allowed: true,
      via: "attendee",
    });

    await expect(
      listMcpMyMeetings({
        userId: "user-range",
        mode: "attended",
        startDate: "2026-01-01T00:00:00.000Z",
        endDate: "2026-01-05T00:00:00.000Z",
      }),
    ).resolves.toMatchObject({
      meetings: [{ meetingId: "visible", serverName: "Guild 1" }],
    });
  });

  it("rejects summary lookup when the caller passes a malformed id", async () => {
    await expect(
      getMcpMeetingSummary({
        userId: "user-1",
        guildId: "guild-1",
        id: "88951d91-4f0f-4897-950d-e9cd5454f944",
      }),
    ).rejects.toMatchObject({
      code: "bad_request",
      message:
        "Use the meeting `id` returned by list tools in `channelId#ISO-timestamp` form.",
    });

    expect(getMeetingHistoryService).not.toHaveBeenCalled();
  });

  it("rejects summary lookup when the id timestamp is malformed", async () => {
    await expect(
      getMcpMeetingSummary({
        userId: "user-1",
        guildId: "guild-1",
        id: "channel-1#not-a-date",
      }),
    ).rejects.toMatchObject({
      code: "bad_request",
      message:
        "Use the meeting `id` returned by list tools in `channelId#ISO-timestamp` form.",
    });

    expect(getMeetingHistoryService).not.toHaveBeenCalled();
  });

  it("rejects summary lookup when the id timestamp is parseable but not canonical ISO", async () => {
    await expect(
      getMcpMeetingSummary({
        userId: "user-1",
        guildId: "guild-1",
        id: "channel-1#2026-01-02",
      }),
    ).rejects.toMatchObject({
      code: "bad_request",
      message:
        "Use the meeting `id` returned by list tools in `channelId#ISO-timestamp` form.",
    });

    expect(getMeetingHistoryService).not.toHaveBeenCalled();
  });

  it("loads a meeting summary by the list item id", async () => {
    const meeting = createMeeting("meeting-1", {
      guildId: "guild-1",
      channelId_timestamp: "channel-1#2026-01-02T00:00:00.000Z",
      notes: "Hello <@123>",
      summarySentence: "Met with <@123>",
      participants: [{ id: "123", username: "user1", displayName: "User 1" }],
      notesVersion: 3,
      notesChannelId: "notes-1",
      notesMessageIds: ["msg-1"],
    });
    jest.mocked(getMeetingHistoryService).mockResolvedValue(meeting);
    jest.mocked(checkUserMeetingAccess).mockResolvedValue({
      allowed: true,
      via: "attendee",
    });

    await expect(
      getMcpMeetingSummary({
        userId: "user-1",
        guildId: "guild-1",
        id: "channel-1#2026-01-02T00:00:00.000Z",
      }),
    ).resolves.toMatchObject({
      meeting: {
        id: "channel-1#2026-01-02T00:00:00.000Z",
        meetingId: "meeting-1",
        notes: "Hello @User 1",
        summarySentence: "Met with @User 1",
        notesVersion: 3,
        notesChannelId: "notes-1",
        notesMessageId: "msg-1",
      },
    });

    expect(getMeetingHistoryService).toHaveBeenCalledWith(
      "guild-1",
      "channel-1#2026-01-02T00:00:00.000Z",
    );
  });
});

describe("mcpMeetingService service account channel allowlist", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(getGuildMemberCached).mockResolvedValue({ roles: [] });
    jest.mocked(listGuildChannelsCached).mockResolvedValue([
      { id: "channel-1", name: "Meeting Room", type: 2 },
      { id: "channel-2", name: "Board Room", type: 2 },
    ]);
    jest.mocked(checkUserMeetingAccess).mockResolvedValue({
      allowed: true,
      via: "attendee",
    });
  });

  it("drops meetings outside the allowlist before any access check runs", async () => {
    jest
      .mocked(listRecentMeetingsForGuildService)
      .mockResolvedValue([
        createMeeting("allowed", { channelId: "channel-1" }),
        createMeeting("blocked", { channelId: "channel-2" }),
      ]);

    await expect(
      listMcpMeetings({
        userId: "bot-1",
        guildId: "guild-1",
        restriction: { guildId: "guild-1", channelIds: ["channel-1"] },
      }),
    ).resolves.toMatchObject({ meetings: [{ meetingId: "allowed" }] });
    expect(checkUserMeetingAccess).toHaveBeenCalledTimes(1);
  });

  it("refuses a direct lookup outside the allowlist even when Discord would allow it", async () => {
    jest.mocked(getMeetingHistoryService).mockResolvedValue(
      createMeeting("blocked", {
        channelId: "channel-2",
        channelId_timestamp: "channel-2#2026-01-02T00:00:00.000Z",
      }),
    );

    await expect(
      getMcpMeetingSummary({
        userId: "bot-1",
        guildId: "guild-1",
        id: "channel-2#2026-01-02T00:00:00.000Z",
        restriction: { guildId: "guild-1", channelIds: ["channel-1"] },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(checkUserMeetingAccess).not.toHaveBeenCalled();
  });

  it("refuses a transcript read outside the allowlist", async () => {
    jest.mocked(getMeetingHistoryService).mockResolvedValue(
      createMeeting("blocked", {
        channelId: "channel-2",
        channelId_timestamp: "channel-2#2026-01-02T00:00:00.000Z",
      }),
    );

    await expect(
      getMcpMeetingTranscript({
        userId: "bot-1",
        guildId: "guild-1",
        id: "channel-2#2026-01-02T00:00:00.000Z",
        restriction: { guildId: "guild-1", channelIds: ["channel-1"] },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(fetchJsonFromS3).not.toHaveBeenCalled();
  });

  it("does not let attendee access outlive a permission change for a service account", async () => {
    // Voice participants are snapshotted without filtering bots, so a bot that
    // once sat in a channel would otherwise keep attendee access to it forever.
    const meeting = createMeeting("bot-attended", {
      channelId: "channel-1",
      participants: [{ id: "bot-1", username: "agent" }],
    });
    jest.mocked(listRecentMeetingsForGuildService).mockResolvedValue([meeting]);

    await listMcpMeetings({
      userId: "bot-1",
      guildId: "guild-1",
      restriction: { guildId: "guild-1" },
    });

    expect(checkUserMeetingAccess).toHaveBeenCalledWith(
      expect.objectContaining({ attendeeOverrideEnabled: false }),
    );
  });

  it("keeps attendee access for an interactive token", async () => {
    jest
      .mocked(listRecentMeetingsForGuildService)
      .mockResolvedValue([createMeeting("attended")]);

    await listMcpMeetings({ userId: "user-1", guildId: "guild-1" });

    expect(checkUserMeetingAccess).toHaveBeenCalledWith(
      expect.objectContaining({ attendeeOverrideEnabled: true }),
    );
  });

  it("leaves reads unfiltered when the token carries no allowlist", async () => {
    jest
      .mocked(listRecentMeetingsForGuildService)
      .mockResolvedValue([
        createMeeting("first", { channelId: "channel-1" }),
        createMeeting("second", { channelId: "channel-2" }),
      ]);

    await expect(
      listMcpMeetings({ userId: "user-1", guildId: "guild-1" }),
    ).resolves.toMatchObject({
      meetings: [{ meetingId: "first" }, { meetingId: "second" }],
    });
  });
});

describe("mcpMeetingService transcripts", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(getGuildMemberCached).mockResolvedValue({ roles: [] });
    jest.mocked(listBotGuildsCached).mockResolvedValue([]);
    jest
      .mocked(listGuildChannelsCached)
      .mockResolvedValue([{ id: "channel-1", name: "Meeting Room", type: 2 }]);
    jest.mocked(listGuildRolesCached).mockResolvedValue([]);
  });

  it("loads a transcript by the list item id", async () => {
    const meeting = createMeeting("meeting-1", {
      guildId: "guild-1",
      channelId_timestamp: "channel-1#2026-01-02T00:00:00.000Z",
      transcriptS3Key: "transcripts/meeting-1.json",
      participants: [{ id: "123", username: "user1", displayName: "User 1" }],
    });
    jest.mocked(getMeetingHistoryService).mockResolvedValue(meeting);
    jest.mocked(checkUserMeetingAccess).mockResolvedValue({
      allowed: true,
      via: "attendee",
    });
    jest.mocked(fetchJsonFromS3).mockResolvedValue({
      text: "Transcript for <@123>",
    });

    await expect(
      getMcpMeetingTranscript({
        userId: "user-1",
        guildId: "guild-1",
        id: "channel-1#2026-01-02T00:00:00.000Z",
      }),
    ).resolves.toMatchObject({
      meetingId: "meeting-1",
      id: "channel-1#2026-01-02T00:00:00.000Z",
      transcript: "Transcript for @User 1",
      transcriptAvailable: true,
      truncated: false,
      offset: 0,
    });
  });

  it("returns a paged transcript slice when maxChars is provided", async () => {
    const meeting = createMeeting("meeting-1", {
      guildId: "guild-1",
      channelId_timestamp: "channel-1#2026-01-02T00:00:00.000Z",
      transcript: "abcdefghijklmnopqrstuvwxyz",
    });
    jest.mocked(getMeetingHistoryService).mockResolvedValue(meeting);
    jest.mocked(checkUserMeetingAccess).mockResolvedValue({
      allowed: true,
      via: "attendee",
    });

    await expect(
      getMcpMeetingTranscript({
        userId: "user-1",
        guildId: "guild-1",
        id: "channel-1#2026-01-02T00:00:00.000Z",
        offset: 5,
        maxChars: 4,
      }),
    ).resolves.toMatchObject({
      transcript: "fghi",
      transcriptAvailable: true,
      offset: 5,
      totalChars: 26,
      truncated: true,
      nextOffset: 9,
    });
  });

  it("keeps transcript paging offsets stable whether or not roles resolve", async () => {
    const roleId = "300000000000000001";
    // Long enough that the mention sits inside the first page.
    const meeting = createMeeting("meeting-1", {
      guildId: "guild-1",
      channelId_timestamp: "channel-1#2026-01-02T00:00:00.000Z",
      transcript: `ping <@&${roleId}> now and then keep talking for a while`,
    });
    jest.mocked(getMeetingHistoryService).mockResolvedValue(meeting);
    jest.mocked(checkUserMeetingAccess).mockResolvedValue({
      allowed: true,
      via: "attendee",
    });
    const args = {
      userId: "user-1",
      guildId: "guild-1",
      id: "channel-1#2026-01-02T00:00:00.000Z",
      offset: 0,
      maxChars: 30,
    };

    jest
      .mocked(listGuildRolesCached)
      .mockResolvedValue([
        { id: roleId, name: "Design", permissions: "0" },
      ] as never);
    const resolved = await getMcpMeetingTranscript(args);

    jest
      .mocked(listGuildRolesCached)
      .mockRejectedValue(new Error("rate limited"));
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const degraded = await getMcpMeetingTranscript(args);
    warn.mockRestore();

    // Offsets describe the stored transcript, so a client following
    // nextOffset is unaffected by role lookup succeeding or failing.
    expect(resolved.totalChars).toBe(degraded.totalChars);
    expect(resolved.nextOffset).toBe(degraded.nextOffset);
    expect(resolved.transcript).toContain("@Design");
    expect(degraded.transcript).toContain(`<@&${roleId}>`);
  });

  it("does not split a mention across transcript pages", async () => {
    const roleId = "300000000000000001";
    const transcript = `abcdefghij <@&${roleId}> tail text here`;
    const meeting = createMeeting("meeting-1", {
      guildId: "guild-1",
      channelId_timestamp: "channel-1#2026-01-02T00:00:00.000Z",
      transcript,
    });
    jest.mocked(getMeetingHistoryService).mockResolvedValue(meeting);
    jest.mocked(checkUserMeetingAccess).mockResolvedValue({
      allowed: true,
      via: "attendee",
    });
    jest
      .mocked(listGuildRolesCached)
      .mockResolvedValue([
        { id: roleId, name: "Design", permissions: "0" },
      ] as never);

    // maxChars lands in the middle of the mention token.
    const first = await getMcpMeetingTranscript({
      userId: "user-1",
      guildId: "guild-1",
      id: "channel-1#2026-01-02T00:00:00.000Z",
      offset: 0,
      maxChars: 15,
    });

    expect(first.transcript).not.toContain("<@&");
    expect(first.transcript).toBe("abcdefghij ");

    const second = await getMcpMeetingTranscript({
      userId: "user-1",
      guildId: "guild-1",
      id: "channel-1#2026-01-02T00:00:00.000Z",
      offset: first.nextOffset ?? 0,
      maxChars: 40,
    });

    // The whole mention lands on the next page and resolves cleanly.
    expect(second.transcript).toContain("@Design");
    expect(second.transcript).not.toContain(roleId);
  });

  it("clamps transcript offsets beyond the transcript length", async () => {
    const meeting = createMeeting("meeting-1", {
      guildId: "guild-1",
      channelId_timestamp: "channel-1#2026-01-02T00:00:00.000Z",
      transcript: "short transcript",
    });
    jest.mocked(getMeetingHistoryService).mockResolvedValue(meeting);
    jest.mocked(checkUserMeetingAccess).mockResolvedValue({
      allowed: true,
      via: "attendee",
    });

    await expect(
      getMcpMeetingTranscript({
        userId: "user-1",
        guildId: "guild-1",
        id: "channel-1#2026-01-02T00:00:00.000Z",
        offset: 999,
        maxChars: 10,
      }),
    ).resolves.toMatchObject({
      transcript: "",
      transcriptAvailable: true,
      offset: 16,
      totalChars: 16,
      truncated: false,
      nextOffset: undefined,
    });
  });
});
