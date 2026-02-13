import {
  ensureUserCanConnectChannel,
  ensureUserCanReadChannelHistory,
} from "../../src/services/discordPermissionsService";
import {
  checkUserMeetingAccess,
  ensureUserCanAccessMeeting,
} from "../../src/services/meetingAccessService";

jest.mock("../../src/services/discordPermissionsService", () => ({
  ensureUserCanConnectChannel: jest.fn(),
  ensureUserCanReadChannelHistory: jest.fn(),
}));

type Meeting = Parameters<typeof checkUserMeetingAccess>[0]["meeting"];

const buildMeeting = (overrides: Partial<Meeting> = {}): Meeting => ({
  channelId: "voice-1",
  channelId_timestamp: "voice-1#2025-01-01T00:00:00.000Z",
  notesChannelId: "text-1",
  textChannelId: "text-1",
  participants: [],
  ...overrides,
});

describe("meetingAccessService", () => {
  const mockedEnsureUserCanConnectChannel = jest.mocked(
    ensureUserCanConnectChannel,
  );
  const mockedEnsureUserCanReadChannelHistory = jest.mocked(
    ensureUserCanReadChannelHistory,
  );

  beforeEach(() => {
    jest.resetAllMocks();
    mockedEnsureUserCanConnectChannel.mockResolvedValue(true);
    mockedEnsureUserCanReadChannelHistory.mockResolvedValue(true);
  });

  test("allows attendees when override enabled", async () => {
    const meeting = buildMeeting({
      participants: [{ id: "user-1", username: "Tester" }],
    });
    const result = await checkUserMeetingAccess({
      guildId: "guild-1",
      meeting,
      userId: "user-1",
    });

    expect(result).toEqual({ allowed: true, via: "attendee" });
    expect(mockedEnsureUserCanConnectChannel).not.toHaveBeenCalled();
    expect(mockedEnsureUserCanReadChannelHistory).not.toHaveBeenCalled();
  });

  test("does not allow attendees when override disabled", async () => {
    const meeting = buildMeeting({
      participants: [{ id: "user-1", username: "Tester" }],
    });
    const result = await checkUserMeetingAccess({
      guildId: "guild-1",
      meeting,
      userId: "user-1",
      attendeeOverrideEnabled: false,
    });

    expect(result).toEqual({ allowed: true, via: "channel_permissions" });
    expect(mockedEnsureUserCanConnectChannel).toHaveBeenCalledTimes(1);
    expect(mockedEnsureUserCanReadChannelHistory).toHaveBeenCalledTimes(1);
  });

  test("fails when voice channel id cannot be resolved", async () => {
    const meeting = buildMeeting({
      channelId: undefined,
      channelId_timestamp: undefined,
    });
    const result = await checkUserMeetingAccess({
      guildId: "guild-1",
      meeting,
      userId: "user-1",
    });

    expect(result).toEqual({ allowed: false, missing: ["voice_connect"] });
  });

  test("returns null when connect check is rate limited", async () => {
    mockedEnsureUserCanConnectChannel.mockResolvedValueOnce(null);
    const result = await checkUserMeetingAccess({
      guildId: "guild-1",
      meeting: buildMeeting(),
      userId: "user-1",
    });

    expect(result).toEqual({ allowed: null, missing: ["voice_connect"] });
  });

  test("rejects when user cannot connect", async () => {
    mockedEnsureUserCanConnectChannel.mockResolvedValueOnce(false);
    const result = await checkUserMeetingAccess({
      guildId: "guild-1",
      meeting: buildMeeting(),
      userId: "user-1",
    });

    expect(result).toEqual({ allowed: false, missing: ["voice_connect"] });
  });

  test("allows when no text channel id is stored (backwards compat)", async () => {
    const meeting = buildMeeting({
      textChannelId: undefined,
      notesChannelId: undefined,
    });
    const result = await checkUserMeetingAccess({
      guildId: "guild-1",
      meeting,
      userId: "user-1",
    });

    expect(result).toEqual({ allowed: true, via: "channel_permissions" });
    expect(mockedEnsureUserCanReadChannelHistory).not.toHaveBeenCalled();
  });

  test("returns null when notes history check is rate limited", async () => {
    mockedEnsureUserCanReadChannelHistory.mockResolvedValueOnce(null);
    const result = await checkUserMeetingAccess({
      guildId: "guild-1",
      meeting: buildMeeting(),
      userId: "user-1",
    });

    expect(result).toEqual({
      allowed: null,
      missing: ["notes_read_history"],
    });
  });

  test("rejects when user cannot read notes history", async () => {
    mockedEnsureUserCanReadChannelHistory.mockResolvedValueOnce(false);
    const result = await checkUserMeetingAccess({
      guildId: "guild-1",
      meeting: buildMeeting(),
      userId: "user-1",
    });

    expect(result).toEqual({
      allowed: false,
      missing: ["notes_read_history"],
    });
  });

  test("ensureUserCanAccessMeeting returns decision.allowed", async () => {
    const allowed = await ensureUserCanAccessMeeting({
      guildId: "guild-1",
      meeting: buildMeeting(),
      userId: "user-1",
    });

    expect(allowed).toBe(true);
  });
});
