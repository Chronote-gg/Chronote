import {
  buildMeetingUserIndexRecords,
  buildGuildShareIndexRecords,
  buildGuildShareIndexPrincipal,
  isRecordedMeetingAttendee,
  resolveMeetingIndexUserIds,
} from "../meetingUserIndex";
import { resolvePersonalMeetingAccess } from "../meetingOwnership";
import type { MeetingHistory } from "../../types/db";

describe("meetingUserIndex", () => {
  it("resolves user ids from participants, legacy attendees, and creators", () => {
    expect(
      resolveMeetingIndexUserIds({
        participants: [{ id: "user-1" }, { id: " user-2 " }],
        attendees: ["<@userless>", "<@123>", "<@!456>"],
        meetingCreatorId: "user-3",
        startTriggeredByUserId: "user-1",
      }),
    ).toEqual(["user-1", "user-2", "123", "456", "user-3"]);
  });

  it("indexes personal meeting owners and user share grants", () => {
    const meeting: MeetingHistory = {
      guildId: "personal:owner-1",
      channelId: "personal",
      channelId_timestamp: "personal#2026-01-01T00:00:00.000Z",
      meetingId: "meeting-1",
      timestamp: "2026-01-01T00:00:00.000Z",
      participants: [],
      duration: 120,
      transcribeMeeting: true,
      generateNotes: true,
      ownershipScope: "personal",
      ownerUserId: "owner-1",
      accessGrants: [
        { targetType: "user", userId: "user-2" },
        { targetType: "guild", guildId: "guild-1" },
      ],
    };

    expect(resolveMeetingIndexUserIds(meeting)).toEqual(["owner-1", "user-2"]);
    expect(buildMeetingUserIndexRecords(meeting)).toEqual([
      expect.objectContaining({ userId: "owner-1", accessReason: "owner" }),
      expect.objectContaining({ userId: "user-2", accessReason: "user_share" }),
    ]);
  });
});

test("guild shares have one encoded principal per distinct grant", () => {
  const meeting = {
    guildId: "personal:owner",
    channelId_timestamp: "p#2026",
    meetingId: "m",
    timestamp: "2026",
    ownershipScope: "personal" as const,
    ownerUserId: "owner",
    accessGrants: [
      { targetType: "guild" as const, guildId: "a/b" },
      { targetType: "guild" as const, guildId: "a/b" },
    ],
  };
  expect(buildGuildShareIndexPrincipal("a/b")).toBe("GUILD_SHARE#a%2Fb");
  expect(buildGuildShareIndexRecords(meeting)).toEqual([
    {
      userId: "GUILD_SHARE#a%2Fb",
      userTimestamp: "2026#personal:owner#p#2026",
      guildId: "personal:owner",
      channelId_timestamp: "p#2026",
      meetingId: "m",
      timestamp: "2026",
      accessReason: "guild_share",
    },
  ]);
  expect(
    buildGuildShareIndexRecords({
      ...meeting,
      guildId: "guild",
      ownershipScope: "guild",
    }),
  ).toEqual([]);
});
test("raw users cannot collide with guild share principals", () => {
  expect(() =>
    resolveMeetingIndexUserIds({ participants: [{ id: "GUILD_SHARE#guild" }] }),
  ).toThrow(/reserved/i);
});
test("attendance matches participants and legacy mentions only", () => {
  const meeting = {
    participants: [{ id: "participant", username: "participant" }],
    attendees: ["<@123>", "<@!456>"],
  };
  expect(isRecordedMeetingAttendee(meeting, "participant")).toBe(true);
  expect(isRecordedMeetingAttendee(meeting, "456")).toBe(true);
  expect(isRecordedMeetingAttendee(meeting, "owner")).toBe(false);
  expect(isRecordedMeetingAttendee(meeting, "share-recipient")).toBe(false);
});

test("a delayed guild pointer write after revocation cannot grant canonical access", () => {
  const shared = {
    guildId: "personal:owner",
    channelId_timestamp: "p#t",
    meetingId: "m",
    timestamp: "t",
    ownershipScope: "personal" as const,
    ownerUserId: "owner",
    accessGrants: [{ targetType: "guild" as const, guildId: "g" }],
  };
  const delayedPointer = buildGuildShareIndexRecords(shared)[0];
  const revoked = { ...shared, accessGrants: [] };
  expect(delayedPointer.userId).toBe("GUILD_SHARE#g");
  expect(resolvePersonalMeetingAccess(revoked, "member", ["g"])).toBeNull();
});
