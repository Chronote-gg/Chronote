import {
  buildMeetingUserIndexRecords,
  resolveMeetingIndexUserIds,
} from "../meetingUserIndex";
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
