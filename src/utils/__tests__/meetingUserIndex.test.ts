import { resolveMeetingIndexUserIds } from "../meetingUserIndex";

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
});
