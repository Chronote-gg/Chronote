import { beforeEach, describe, expect, test, jest } from "@jest/globals";
import type { MeetingHistory } from "../../src/types/db";
import {
  getGuildMemberCached,
  listBotGuildsCached,
  listGuildChannelsCached,
} from "../../src/services/discordCacheService";
import { getMeetingHistoryService } from "../../src/services/meetingHistoryService";
import { listMeetingUserIndexForUserInRangeService } from "../../src/services/meetingUserIndexService";
import { checkUserMeetingAccess } from "../../src/services/meetingAccessService";
import {
  getMcpMeetingSummary,
  listMcpMyMeetings,
} from "../../src/services/mcpMeetingService";

jest.mock("../../src/services/configService", () => ({
  config: {
    frontend: { siteUrl: "https://app.example.com" },
    cache: {
      enabled: false,
      keyPrefix: "test",
      redisUrl: "",
      referencesTtlSeconds: 60,
      memorySize: 100,
      invalidationEnabled: false,
      defaultTtlSeconds: 60,
      discord: { membersTtlSeconds: 60 },
    },
  },
}));

jest.mock("../../src/services/discordService", () => ({
  isDiscordApiError: jest.fn(() => false),
}));

jest.mock("../../src/services/discordCacheService", () => ({
  getGuildMemberCached: jest.fn(),
  listBotGuildsCached: jest.fn(),
  listGuildChannelsCached: jest.fn(),
}));

jest.mock("../../src/services/meetingHistoryService", () => ({
  getMeetingHistoryService: jest.fn(),
  listMeetingsForGuildInRangeService: jest.fn(),
  listRecentMeetingsForGuildService: jest.fn(),
}));

jest.mock("../../src/services/meetingUserIndexService", () => ({
  listMeetingUserIndexForUserInRangeService: jest.fn(),
}));

jest.mock("../../src/services/meetingAccessService", () => ({
  checkUserMeetingAccess: jest.fn(),
}));

jest.mock("../../src/services/storageService", () => ({
  fetchJsonFromS3: jest.fn(),
}));

jest.mock("../../src/services/unifiedConfigService", () => ({
  resolveConfigSnapshot: jest.fn(async () => ({})),
  getSnapshotBoolean: jest.fn(() => true),
}));

const meeting: MeetingHistory = {
  guildId: "guild-old",
  channelId_timestamp: "voice-1#2026-01-02T00:00:00.000Z",
  meetingId: "meeting-1",
  channelId: "voice-1",
  timestamp: "2026-01-02T00:00:00.000Z",
  participants: [{ id: "user-1", username: "Tester" }],
  duration: 1800,
  transcribeMeeting: true,
  generateNotes: true,
  notes: "Summary: private sync",
};

describe("mcpMeetingService", () => {
  const mockedGetGuildMember = jest.mocked(getGuildMemberCached);
  const mockedListBotGuilds = jest.mocked(listBotGuildsCached);
  const mockedListGuildChannels = jest.mocked(listGuildChannelsCached);
  const mockedGetMeetingHistory = jest.mocked(getMeetingHistoryService);
  const mockedListMeetingUserIndex = jest.mocked(
    listMeetingUserIndexForUserInRangeService,
  );
  const mockedCheckMeetingAccess = jest.mocked(checkUserMeetingAccess);

  beforeEach(() => {
    jest.resetAllMocks();
    mockedGetGuildMember.mockRejectedValue(new Error("not a member"));
    mockedListBotGuilds.mockResolvedValue([]);
    mockedListGuildChannels.mockResolvedValue([]);
    mockedGetMeetingHistory.mockResolvedValue(meeting);
    mockedListMeetingUserIndex.mockResolvedValue([
      {
        userId: "user-1",
        userTimestamp: `2026-01-02T00:00:00.000Z#${meeting.guildId}#${meeting.channelId_timestamp}`,
        guildId: meeting.guildId,
        channelId_timestamp: meeting.channelId_timestamp,
        meetingId: meeting.meetingId,
        timestamp: meeting.timestamp,
      },
    ]);
    mockedCheckMeetingAccess.mockResolvedValue({
      allowed: true,
      via: "attendee",
    });
  });

  test("lists attended indexed meetings without current server membership", async () => {
    const result = await listMcpMyMeetings({
      userId: "user-1",
      range: "custom",
      startDate: "2026-01-01T00:00:00.000Z",
      endDate: "2026-01-03T00:00:00.000Z",
    });

    expect(result.meetings).toHaveLength(1);
    expect(result.meetings[0]).toMatchObject({
      id: meeting.channelId_timestamp,
      serverId: meeting.guildId,
      serverName: meeting.guildId,
      portalUrl:
        "https://app.example.com/portal/meetings/guild-old/voice-1%232026-01-02T00%3A00%3A00.000Z",
    });
    expect(mockedGetGuildMember).not.toHaveBeenCalled();
  });

  test("fetches an indexed meeting summary without current server membership", async () => {
    const result = await getMcpMeetingSummary({
      userId: "user-1",
      guildId: meeting.guildId,
      id: meeting.channelId_timestamp,
    });

    expect(result.meeting.id).toBe(meeting.channelId_timestamp);
    expect(mockedGetGuildMember).not.toHaveBeenCalled();
    expect(mockedCheckMeetingAccess).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: meeting.guildId,
        meeting,
        userId: "user-1",
      }),
    );
  });
  test("authorized MCP notes retain warning metadata without recovery identities", async () => {
    mockedGetMeetingHistory.mockResolvedValue({
      ...meeting,
      status: "interrupted",
      capture: {
        kind: "interrupted",
        startedAt: meeting.timestamp,
        endedAt: null,
        detectedAt: "2026-01-02T01:00:00Z",
      },
      recovery: {
        disposition: "claimed",
        stage: "notes",
        executionVersion: 3,
        attempt: 1,
        retry: { maxAttempts: 4, nextAttemptAt: null },
      },
    });
    const result = await getMcpMeetingSummary({
      userId: "user-1",
      guildId: meeting.guildId,
      id: meeting.channelId_timestamp,
    });
    expect(result.meeting.captureNotice).toContain(
      "These notes cover only the saved recording.",
    );
    expect(result.meeting.notes).toBe(meeting.notes);
    expect(result.meeting.recovery).toEqual({
      disposition: "claimed",
      stage: "notes",
    });
    mockedCheckMeetingAccess.mockResolvedValue({
      allowed: false,
      reason: "not_attendee",
    });
    await expect(
      getMcpMeetingSummary({
        userId: "user-1",
        guildId: meeting.guildId,
        id: meeting.channelId_timestamp,
      }),
    ).rejects.toThrow();
  });
});
