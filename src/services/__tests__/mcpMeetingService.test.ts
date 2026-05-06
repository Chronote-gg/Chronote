import { jest } from "@jest/globals";
import {
  getGuildMemberCached,
  listBotGuildsCached,
  listGuildChannelsCached,
} from "../discordCacheService";
import { checkUserMeetingAccess } from "../meetingAccessService";
import {
  listMeetingsForGuildInRangeService,
  listRecentMeetingsForGuildService,
} from "../meetingHistoryService";
import { listMcpMeetings, listMcpServersForUser } from "../mcpMeetingService";
import type { MeetingHistory } from "../../types/db";

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

jest.mock("../unifiedConfigService", () => ({
  getSnapshotBoolean: jest.fn(() => true),
  resolveConfigSnapshot: jest.fn(() => Promise.resolve({})),
}));

const createMeeting = (meetingId: string): MeetingHistory => ({
  guildId: "guild-1",
  channelId: "channel-1",
  channelId_timestamp: `channel-1#2026-01-01T00:00:00.000Z-${meetingId}`,
  meetingId,
  timestamp: "2026-01-01T00:00:00.000Z",
  participants: [],
  duration: 120,
  transcribeMeeting: true,
  generateNotes: true,
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
      100,
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
});
