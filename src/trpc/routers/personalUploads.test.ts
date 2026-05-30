/** @jest-environment node */

import { jest } from "@jest/globals";
import type { TrpcContext } from "../context";
import { personalUploadsRouter } from "./personalUploads";
import type { PersonalMediaUploadJobRecord } from "../../types/db";
import {
  createPersonalMediaUploadIntent,
  getPersonalMediaUploadJobForUser,
  markPersonalMediaUploadComplete,
  PersonalMediaUploadError,
} from "../../services/personalMediaUploadService";

jest.mock("../../services/personalMediaUploadService", () => ({
  PersonalMediaUploadError: class PersonalMediaUploadError extends Error {
    constructor(
      message: string,
      readonly code: string,
    ) {
      super(message);
    }
  },
  createPersonalMediaUploadIntent: jest.fn(),
  getPersonalMediaUploadJobForUser: jest.fn(),
  markPersonalMediaUploadComplete: jest.fn(),
}));

const job: PersonalMediaUploadJobRecord = {
  uploadId: "550e8400-e29b-41d4-a716-446655440000",
  ownerUserId: "user-1",
  status: "queued",
  mediaKind: "audio",
  sourceS3Key:
    "personal-media-uploads/user-1/550e8400-e29b-41d4-a716-446655440000/source.mp3",
  contentType: "audio/mpeg",
  fileSize: 1234,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:01:00.000Z",
};

const createCaller = () =>
  personalUploadsRouter.createCaller({
    req: {
      session: {},
      ip: "127.0.0.1",
      socket: { remoteAddress: "127.0.0.1" },
    },
    res: {},
    user: { id: "user-1", accessToken: "discord-access-token" },
  } as TrpcContext);

describe("personalUploadsRouter", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(createPersonalMediaUploadIntent).mockResolvedValue({
      uploadId: job.uploadId,
      key: job.sourceS3Key,
      uploadToken: "token",
      contentType: "audio/mpeg",
      fileSize: 1234,
      mediaKind: "audio",
      expiresAt: 1_700_000_900_000,
      upload: { url: "https://uploads.example/form", fields: {} },
    });
    jest.mocked(markPersonalMediaUploadComplete).mockResolvedValue(job);
    jest.mocked(getPersonalMediaUploadJobForUser).mockResolvedValue(job);
  });

  it("creates a signed upload intent for the authenticated user", async () => {
    await expect(
      createCaller().createUploadIntent({
        contentType: "audio/mpeg",
        fileSize: 1234,
      }),
    ).resolves.toMatchObject({ uploadId: job.uploadId });

    expect(createPersonalMediaUploadIntent).toHaveBeenCalledWith({
      userId: "user-1",
      contentType: "audio/mpeg",
      fileSize: 1234,
    });
  });

  it("queues a completed upload without starting processing inline", async () => {
    await expect(
      createCaller().completeUpload({
        uploadId: job.uploadId,
        key: job.sourceS3Key,
        uploadToken: "token",
        originalFileName: "meeting.mp3",
        title: "Planning session",
        tags: ["planning"],
      }),
    ).resolves.toEqual({ job });

    expect(markPersonalMediaUploadComplete).toHaveBeenCalledWith({
      uploadId: job.uploadId,
      userId: "user-1",
      key: job.sourceS3Key,
      uploadToken: "token",
      originalFileName: "meeting.mp3",
      title: "Planning session",
      tags: ["planning"],
    });
  });

  it("returns upload status for the authenticated owner", async () => {
    await expect(
      createCaller().getStatus({ uploadId: job.uploadId }),
    ).resolves.toEqual({ job });

    expect(getPersonalMediaUploadJobForUser).toHaveBeenCalledWith({
      uploadId: job.uploadId,
      userId: "user-1",
    });
  });

  it("maps missing uploaded objects to a bad request", async () => {
    jest
      .mocked(markPersonalMediaUploadComplete)
      .mockRejectedValue(
        new PersonalMediaUploadError(
          "Uploaded media was not found.",
          "missing_object",
        ),
      );

    await expect(
      createCaller().completeUpload({
        uploadId: job.uploadId,
        key: job.sourceS3Key,
        uploadToken: "token",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
