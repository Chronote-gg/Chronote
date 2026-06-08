import { jest } from "@jest/globals";
import type { PersonalMediaUploadJobRecord } from "../../types/db";
import { writeMeetingHistoryService } from "../meetingHistoryService";
import { updatePersonalMediaUploadJobRecord } from "../personalMediaUploadService";
import { createPersonalMediaProcessingMeeting } from "../personalMediaUploadProcessingService";

jest.mock("../meetingHistoryService", () => ({
  writeMeetingHistoryService: jest.fn(async () => undefined),
}));

jest.mock("../personalMediaUploadService", () => ({
  updateClaimedPersonalMediaUploadJobRecord: jest.fn(async () => false),
  updatePersonalMediaUploadJobRecord: jest.fn(async () => undefined),
}));

const buildJob = (): PersonalMediaUploadJobRecord => ({
  uploadId: "upload-1",
  ownerUserId: "user-1",
  status: "queued",
  mediaKind: "audio",
  sourceS3Key: "personal-media-uploads/user-1/upload-1/source.mp3",
  contentType: "audio/mpeg",
  fileSize: 1234,
  createdAt: "2026-01-06T18:00:00.000Z",
  updatedAt: "2026-01-06T18:00:00.000Z",
});

describe("personalMediaUploadProcessingService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("persists a personal attendee participant before processing", async () => {
    await createPersonalMediaProcessingMeeting(buildJob());

    expect(writeMeetingHistoryService).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: "personal:user-1",
        channelId_timestamp: "personal#2026-01-06T18:00:00.000Z",
        ownershipScope: "personal",
        ownerUserId: "user-1",
        participants: [
          {
            id: "user-1",
            username: "Me",
            displayName: "Me",
          },
        ],
      }),
    );
    expect(updatePersonalMediaUploadJobRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        uploadId: "upload-1",
        meetingGuildId: "personal:user-1",
        meetingId: "upload-1",
        channelId_timestamp: "personal#2026-01-06T18:00:00.000Z",
      }),
    );
  });
});
