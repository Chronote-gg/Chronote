import { jest } from "@jest/globals";
import {
  checkUserMeetingAccess,
  type MeetingAccessDecision,
} from "../meetingAccessService";
import {
  ensureUserCanConnectChannel,
  ensureUserCanReadChannelHistory,
} from "../discordPermissionsService";
import type { MeetingHistory } from "../../types/db";

jest.mock("../discordPermissionsService", () => ({
  ensureUserCanConnectChannel: jest.fn(),
  ensureUserCanReadChannelHistory: jest.fn(),
}));

const createMeeting = (
  overrides: Partial<MeetingHistory> = {},
): MeetingHistory => ({
  guildId: overrides.guildId ?? "guild-1",
  channelId: overrides.channelId ?? "voice-1",
  channelId_timestamp:
    overrides.channelId_timestamp ?? "voice-1#2026-01-01T00:00:00.000Z",
  meetingId: overrides.meetingId ?? "meeting-1",
  timestamp: overrides.timestamp ?? "2026-01-01T00:00:00.000Z",
  participants: overrides.participants ?? [],
  duration: overrides.duration ?? 120,
  transcribeMeeting: overrides.transcribeMeeting ?? true,
  generateNotes: overrides.generateNotes ?? true,
  ...overrides,
});

const expectAllowedVia = async (
  decision: Promise<MeetingAccessDecision>,
  via: Extract<MeetingAccessDecision, { allowed: true }>["via"],
) => {
  await expect(decision).resolves.toEqual({ allowed: true, via });
};

describe("meetingAccessService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("allows personal meeting owners without Discord channel checks", async () => {
    await expectAllowedVia(
      checkUserMeetingAccess({
        guildId: "personal:user-1",
        meeting: createMeeting({
          guildId: "personal:user-1",
          ownershipScope: "personal",
          ownerUserId: "user-1",
        }),
        userId: "user-1",
      }),
      "owner",
    );

    expect(ensureUserCanConnectChannel).not.toHaveBeenCalled();
    expect(ensureUserCanReadChannelHistory).not.toHaveBeenCalled();
  });

  it("allows explicit user shares on personal meetings", async () => {
    await expectAllowedVia(
      checkUserMeetingAccess({
        guildId: "personal:user-1",
        meeting: createMeeting({
          guildId: "personal:user-1",
          ownershipScope: "personal",
          ownerUserId: "user-1",
          accessGrants: [{ targetType: "user", userId: "user-2" }],
        }),
        userId: "user-2",
      }),
      "user_share",
    );
  });

  it("allows guild shares on personal meetings when caller membership is provided", async () => {
    await expectAllowedVia(
      checkUserMeetingAccess({
        guildId: "personal:user-1",
        meeting: createMeeting({
          guildId: "personal:user-1",
          ownershipScope: "personal",
          ownerUserId: "user-1",
          accessGrants: [{ targetType: "guild", guildId: "guild-2" }],
        }),
        userId: "user-2",
        sharedGuildIds: ["guild-2"],
      }),
      "guild_share",
    );
  });

  it("denies personal meetings with no owner or share match", async () => {
    await expect(
      checkUserMeetingAccess({
        guildId: "personal:user-1",
        meeting: createMeeting({
          guildId: "personal:user-1",
          ownershipScope: "personal",
          ownerUserId: "user-1",
        }),
        userId: "user-2",
      }),
    ).resolves.toEqual({ allowed: false, missing: [] });

    expect(ensureUserCanConnectChannel).not.toHaveBeenCalled();
  });

  it("keeps guild meetings on Discord channel permission checks", async () => {
    jest.mocked(ensureUserCanConnectChannel).mockResolvedValue(true);
    jest.mocked(ensureUserCanReadChannelHistory).mockResolvedValue(true);

    await expectAllowedVia(
      checkUserMeetingAccess({
        guildId: "guild-1",
        meeting: createMeeting({ textChannelId: "text-1" }),
        userId: "user-2",
      }),
      "channel_permissions",
    );

    expect(ensureUserCanConnectChannel).toHaveBeenCalledWith({
      guildId: "guild-1",
      channelId: "voice-1",
      userId: "user-2",
    });
    expect(ensureUserCanReadChannelHistory).toHaveBeenCalledWith({
      guildId: "guild-1",
      channelId: "text-1",
      userId: "user-2",
    });
  });
});
