import { PermissionFlagsBits, PermissionsBitField } from "discord.js";
import type { MeetingData } from "../../src/types/meeting-data";
import { canUserEndMeeting } from "../../src/utils/meetingPermissions";

function makeMeetingWithMemberPermissions(
  userId: string,
  permissions: bigint,
): MeetingData {
  return {
    creator: { id: "creator-1" },
    guild: {
      members: {
        cache: new Map([
          [
            userId,
            {
              permissions: new PermissionsBitField(permissions),
            },
          ],
        ]),
      },
    },
  } as unknown as MeetingData;
}

describe("canUserEndMeeting", () => {
  it.each([
    ["ModerateMembers", PermissionFlagsBits.ModerateMembers],
    ["Administrator", PermissionFlagsBits.Administrator],
    ["ManageChannels", PermissionFlagsBits.ManageChannels],
    ["ManageGuild", PermissionFlagsBits.ManageGuild],
    ["ManageMessages", PermissionFlagsBits.ManageMessages],
  ])("allows users with %s", (_label, permission) => {
    const meeting = makeMeetingWithMemberPermissions("user-1", permission);

    expect(canUserEndMeeting(meeting, "user-1")).toBe(true);
  });

  it("allows the meeting creator", () => {
    const meeting = makeMeetingWithMemberPermissions("user-1", 0n);

    expect(canUserEndMeeting(meeting, "creator-1")).toBe(true);
  });

  it("blocks users without meeting permissions", () => {
    const meeting = makeMeetingWithMemberPermissions("user-1", 0n);

    expect(canUserEndMeeting(meeting, "user-1")).toBe(false);
  });
});
