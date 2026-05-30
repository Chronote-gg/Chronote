import { jest } from "@jest/globals";
import type { MeetingHistory, MeetingUserIndexRecord } from "../../types/db";
import { getMeetingUserIndexRepository } from "../../repositories/meetingUserIndexRepository";
import { replaceMeetingUserIndexForMeetingService } from "../meetingUserIndexService";

jest.mock("../../repositories/meetingUserIndexRepository", () => ({
  getMeetingUserIndexRepository: jest.fn(),
}));

const baseMeeting: MeetingHistory = {
  guildId: "personal:owner-1",
  channelId_timestamp: "personal#2026-05-08T12:00:00.000Z",
  meetingId: "meeting-1",
  channelId: "personal",
  timestamp: "2026-05-08T12:00:00.000Z",
  participants: [],
  duration: 120,
  transcribeMeeting: true,
  generateNotes: true,
  ownershipScope: "personal",
  ownerUserId: "owner-1",
};

describe("meetingUserIndexService", () => {
  const write = jest.fn<() => Promise<void>>();
  const deleteRecords = jest.fn<() => Promise<void>>();
  const listByUserTimestampRange =
    jest.fn<() => Promise<MeetingUserIndexRecord[]>>();

  beforeEach(() => {
    jest.clearAllMocks();
    write.mockResolvedValue(undefined);
    deleteRecords.mockResolvedValue(undefined);
    listByUserTimestampRange.mockResolvedValue([]);
    jest.mocked(getMeetingUserIndexRepository).mockReturnValue({
      write,
      delete: deleteRecords,
      listByUserTimestampRange,
    });
  });

  it("removes stale personal share index records when grants are replaced", async () => {
    await replaceMeetingUserIndexForMeetingService(
      {
        ...baseMeeting,
        accessGrants: [
          { targetType: "user", userId: "user-2" },
          { targetType: "user", userId: "user-3" },
        ],
      },
      {
        ...baseMeeting,
        accessGrants: [{ targetType: "user", userId: "user-3" }],
      },
    );

    expect(deleteRecords).toHaveBeenCalledWith([
      expect.objectContaining({
        userId: "user-2",
        userTimestamp:
          "2026-05-08T12:00:00.000Z#personal:owner-1#personal#2026-05-08T12:00:00.000Z",
      }),
    ]);
    expect(write).toHaveBeenCalledWith([
      expect.objectContaining({ userId: "owner-1", accessReason: "owner" }),
      expect.objectContaining({
        userId: "user-3",
        accessReason: "user_share",
      }),
    ]);
  });
});
