/** @jest-environment node */
import {
  ensurePortalUserCanAccessMeeting,
  ensurePortalUserCanEditMeetingNotes,
} from "../../src/trpc/routers/meetingEditPermissions";
import { ensureMcpMeetingAccess } from "../../src/services/mcpMeetingAccess";
import { resolveGuildHistoryAuthority } from "../../src/services/guildHistoryAuthorityService";
import {
  ensureUserCanManageChannel,
  ensureUserCanConnectChannel,
  ensureUserCanReadChannelHistory,
} from "../../src/services/discordPermissionsService";
import { getGuildMemberCached } from "../../src/services/discordCacheService";
import type { MeetingHistory } from "../../src/types/db";

jest.mock("../../src/services/guildHistoryAuthorityService", () => ({
  resolveGuildHistoryAuthority: jest.fn(),
}));
jest.mock("../../src/services/discordPermissionsService", () => ({
  ensureUserCanManageChannel: jest.fn(),
  ensureUserCanConnectChannel: jest.fn(),
  ensureUserCanReadChannelHistory: jest.fn(),
}));
jest.mock("../../src/services/discordCacheService", () => ({
  getGuildMemberCached: jest.fn(),
}));
jest.mock("../../src/services/attendeeAccessSetting", () => ({
  resolveAttendeeAccessEnabled: async () => false,
}));
jest.mock("../../src/services/mcpMeetingServers", () => ({
  listMcpServersForUser: jest.fn(),
}));

const meeting: MeetingHistory = {
  guildId: "guild-1",
  channelId: "deleted-voice",
  textChannelId: "deleted-notes",
  channelId_timestamp: "deleted-voice#2026-01-01T00:00:00.000Z",
  timestamp: "2026-01-01T00:00:00.000Z",
  meetingId: "meeting-1",
  participants: [],
  duration: 60,
  transcribeMeeting: true,
  generateNotes: true,
};
const read = (restricted = false) =>
  ensureMcpMeetingAccess({
    guildId: meeting.guildId,
    meeting,
    userId: "user-1",
    restricted,
  });
beforeEach(() => {
  jest.resetAllMocks();
  jest.mocked(getGuildMemberCached).mockResolvedValue({ roles: [] });
  jest
    .mocked(resolveGuildHistoryAuthority)
    .mockResolvedValue({ allowed: true, via: "guild_administrator" });
  jest.mocked(ensureUserCanManageChannel).mockResolvedValue(false);
  jest.mocked(ensureUserCanConnectChannel).mockResolvedValue(false);
  jest.mocked(ensureUserCanReadChannelHistory).mockResolvedValue(false);
});
test("allows unrestricted non-attendee administrators after channel deletion", async () => {
  await expect(read()).resolves.toBeUndefined();
});
test("restricted Administrator principals retain current channel requirements", async () => {
  await expect(read(true)).rejects.toMatchObject({ code: "forbidden" });
  expect(resolveGuildHistoryAuthority).not.toHaveBeenCalled();
});
test("restricted calls cannot reuse an unrestricted context", async () => {
  await expect(
    ensureMcpMeetingAccess({
      guildId: meeting.guildId,
      meeting,
      userId: "user-1",
      restricted: true,
      accessContext: {
        attendeeOverrideEnabled: true,
        guildAuthorityOverrideEnabled: true,
        accessContext: new Map(),
      },
    }),
  ).rejects.toMatchObject({ code: "forbidden" });
  expect(resolveGuildHistoryAuthority).not.toHaveBeenCalled();
});
test("removed members cannot use the new grant", async () => {
  jest
    .mocked(getGuildMemberCached)
    .mockRejectedValue(
      Object.assign(new Error("Unknown member"), { status: 404 }),
    );
  await expect(read()).rejects.toThrow();
  expect(resolveGuildHistoryAuthority).not.toHaveBeenCalled();
});

test("portal read allows authority without granting manual or automatic notes edits", async () => {
  const input = {
    guildId: meeting.guildId,
    meeting,
    userId: "user-1",
    attendeeOverrideEnabled: false,
  };
  await expect(
    ensurePortalUserCanAccessMeeting(input),
  ).resolves.toBeUndefined();
  for (const isAutoRecording of [false, true]) {
    await expect(
      ensurePortalUserCanEditMeetingNotes({
        ...input,
        meeting: { ...meeting, meetingCreatorId: "other", isAutoRecording },
        channelId: "deleted-voice",
        forbiddenMessage: "Creator required",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  }
});
