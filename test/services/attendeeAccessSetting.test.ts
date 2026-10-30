import { CONFIG_KEYS } from "../../src/config/keys";
import { resetMockStore } from "../../src/repositories/mockStore";
import { resolveAttendeeAccessEnabled } from "../../src/services/attendeeAccessSetting";
import { setConfigOverrideForScope } from "../../src/services/configOverridesService";
import { getGuildMemberCached } from "../../src/services/discordCacheService";
import {
  ensureUserCanConnectChannel,
  ensureUserCanReadChannelHistory,
} from "../../src/services/discordPermissionsService";
import { checkUserMeetingAccess } from "../../src/services/meetingAccessService";
import { resolveMcpMeetingAccessContext } from "../../src/services/mcpMeetingAccess";

jest.mock("../../src/services/discordCacheService", () => ({
  getGuildMemberCached: jest.fn(async () => ({ roles: [] })),
}));
jest.mock("../../src/services/discordPermissionsService", () => ({
  ensureUserCanConnectChannel: jest.fn(async () => false),
  ensureUserCanReadChannelHistory: jest.fn(async () => false),
}));

const meeting = {
  guildId: "guild-1",
  channelId: "deleted-channel",
  participants: [{ id: "attendee-1", username: "Attendee" }],
};

beforeEach(() => {
  resetMockStore();
  jest.clearAllMocks();
});

test("recorded attendees retain access by default after channel access disappears", async () => {
  const attendeeOverrideEnabled = await resolveAttendeeAccessEnabled("guild-1");
  expect(attendeeOverrideEnabled).toBe(true);
  await expect(
    checkUserMeetingAccess({
      guildId: "guild-1",
      userId: "attendee-1",
      meeting,
      attendeeOverrideEnabled,
    }),
  ).resolves.toEqual({ allowed: true, via: "attendee" });
  expect(ensureUserCanConnectChannel).not.toHaveBeenCalled();
  expect(ensureUserCanReadChannelHistory).not.toHaveBeenCalled();
});

test("an explicit server opt-out still requires current channel access", async () => {
  await setConfigOverrideForScope(
    { scope: "server", guildId: "guild-1" },
    CONFIG_KEYS.meetings.attendeeAccessEnabled,
    false,
    "admin-1",
  );
  const attendeeOverrideEnabled = await resolveAttendeeAccessEnabled("guild-1");
  expect(attendeeOverrideEnabled).toBe(false);
  await expect(
    checkUserMeetingAccess({
      guildId: "guild-1",
      userId: "attendee-1",
      meeting,
      attendeeOverrideEnabled,
    }),
  ).resolves.toEqual({ allowed: false, missing: ["voice_connect"] });
});

test("the default does not grant attendee access to someone who did not attend", async () => {
  await expect(
    checkUserMeetingAccess({
      guildId: "guild-1",
      userId: "other-user",
      meeting,
      attendeeOverrideEnabled: await resolveAttendeeAccessEnabled("guild-1"),
    }),
  ).resolves.toEqual({ allowed: false, missing: ["voice_connect"] });
});

test("restricted MCP tokens never receive the attendee override", async () => {
  await expect(
    resolveMcpMeetingAccessContext("guild-1", "attendee-1", {
      restricted: true,
    }),
  ).resolves.toEqual({ attendeeOverrideEnabled: false });
  expect(getGuildMemberCached).toHaveBeenCalledWith("guild-1", "attendee-1");
});

test("MCP still checks guild membership before resolving attendee access", async () => {
  jest
    .mocked(getGuildMemberCached)
    .mockRejectedValueOnce(new Error("Not a member"));
  await expect(
    resolveMcpMeetingAccessContext("guild-1", "attendee-1"),
  ).rejects.toThrow("Not a member");
});
