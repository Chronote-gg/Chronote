import { jest } from "@jest/globals";
import {
  getGuildMemberCached,
  listBotGuildsCached,
  listGuildChannelsCached,
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

  it("skips the guild-range fallback when indexed attended results fill the page", async () => {
    const indexedMeeting = createMeeting("indexed", {
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
          "2026-01-03T00:00:00.000Z#guild-1#channel-1#2026-01-03T00:00:00.000Z",
        guildId: "guild-1",
        channelId_timestamp: "channel-1#2026-01-03T00:00:00.000Z",
        meetingId: "indexed",
        timestamp: "2026-01-03T00:00:00.000Z",
      },
    ]);
    jest.mocked(getMeetingHistoryService).mockResolvedValue(indexedMeeting);
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
    });
    expect(listMeetingsForGuildInRangeService).not.toHaveBeenCalled();
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
    });
    expect(listMeetingUserIndexForUserInRangeService).toHaveBeenCalledWith(
      "offset-user",
      "2026-01-01T05:00:00.000Z",
      "2026-01-01T22:00:00.000Z",
      125,
    );
    expect(listMeetingsForGuildInRangeService).toHaveBeenCalledWith(
      "guild-1",
      "2026-01-01T05:00:00.000Z",
      "2026-01-01T22:00:00.000Z",
      125,
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
