import { jest } from "@jest/globals";
import { PERSONAL_MEDIA_UPLOAD_MAX_BYTES } from "../../constants";
import {
  createPersonalMediaUploadIntent,
  getPersonalMediaUploadJobForUser,
  markPersonalMediaUploadComplete,
  PersonalMediaUploadError,
  resolvePersonalMediaKind,
} from "../personalMediaUploadService";
import {
  getPersonalMediaUploadRepository,
  type PersonalMediaUploadRepository,
} from "../../repositories/personalMediaUploadRepository";
import type { PersonalMediaUploadJobRecord } from "../../types/db";
import {
  getSignedUploadPost,
  getStoredObjectMetadata,
} from "../storageService";

const uploadRepository = {
  write: jest.fn(async (job: PersonalMediaUploadJobRecord) => {
    void job;
  }),
  get: jest.fn(
    async (
      uploadId: string,
    ): Promise<PersonalMediaUploadJobRecord | undefined> => {
      void uploadId;
      return undefined;
    },
  ),
  update: jest.fn(async (job: PersonalMediaUploadJobRecord) => {
    void job;
  }),
  listClaimable: jest.fn(async () => []),
  claim: jest.fn(async () => undefined),
  renewClaim: jest.fn(async () => false),
  updateClaimed: jest.fn(async () => false),
} satisfies jest.Mocked<PersonalMediaUploadRepository>;

const getWrittenJob = () => {
  const job = uploadRepository.write.mock.calls[0]?.[0];
  if (!job) throw new Error("Expected upload job to be written.");
  return job;
};

jest.mock("../../repositories/personalMediaUploadRepository", () => ({
  getPersonalMediaUploadRepository: jest.fn(() => uploadRepository),
}));

jest.mock("../storageService", () => ({
  getSignedUploadPost: jest.fn(),
  getStoredObjectMetadata: jest.fn(),
}));

describe("personalMediaUploadService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest
      .mocked(getPersonalMediaUploadRepository)
      .mockReturnValue(uploadRepository);
    jest.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    jest.mocked(getSignedUploadPost).mockResolvedValue({
      url: "https://uploads.example/form",
      fields: { key: "value" },
    });
    jest.mocked(getStoredObjectMetadata).mockResolvedValue({
      contentLength: 1234,
      contentType: "audio/mpeg",
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("creates an owner-scoped signed upload intent for audio", async () => {
    const intent = await createPersonalMediaUploadIntent({
      userId: "user-1",
      contentType: "audio/mpeg",
      fileSize: 1234,
    });

    expect(intent).toMatchObject({
      contentType: "audio/mpeg",
      fileSize: 1234,
      mediaKind: "audio",
      upload: { url: "https://uploads.example/form" },
      expiresAt: 1_700_000_900_000,
    });
    expect(intent.key).toMatch(
      /^personal-media-uploads\/user-1\/[0-9a-f-]+\/source\.mp3$/,
    );
    expect(intent.uploadToken).toMatch(/^1700000900000\./);
    expect(getSignedUploadPost).toHaveBeenCalledWith(
      intent.key,
      "audio/mpeg",
      1234,
      900,
    );
    expect(uploadRepository.write).toHaveBeenCalledWith(
      expect.objectContaining({
        uploadId: intent.uploadId,
        ownerUserId: "user-1",
        status: "pending_upload",
        sourceS3Key: intent.key,
      }),
    );
  });

  it("classifies supported video uploads", async () => {
    const intent = await createPersonalMediaUploadIntent({
      userId: "user-1",
      contentType: "video/quicktime",
      fileSize: 1234,
    });

    expect(intent.mediaKind).toBe("video");
    expect(intent.key).toMatch(/source\.mov$/);
  });

  it("rejects unsupported media types", async () => {
    await expect(
      createPersonalMediaUploadIntent({
        userId: "user-1",
        contentType: "application/pdf",
        fileSize: 1234,
      }),
    ).rejects.toMatchObject<Partial<PersonalMediaUploadError>>({
      code: "unsupported_type",
    });

    expect(getSignedUploadPost).not.toHaveBeenCalled();
  });

  it("rejects files above the upload cap", async () => {
    await expect(
      createPersonalMediaUploadIntent({
        userId: "user-1",
        contentType: "audio/mpeg",
        fileSize: PERSONAL_MEDIA_UPLOAD_MAX_BYTES + 1,
      }),
    ).rejects.toMatchObject<Partial<PersonalMediaUploadError>>({
      code: "too_large",
    });
  });

  it("classifies only audio and video content types", () => {
    expect(resolvePersonalMediaKind("audio/webm")).toBe("audio");
    expect(resolvePersonalMediaKind("video/webm")).toBe("video");
    expect(resolvePersonalMediaKind("application/octet-stream")).toBeNull();
  });

  it("returns an upload job only to its owner", async () => {
    const job = {
      uploadId: "upload-1",
      ownerUserId: "user-1",
      status: "pending_upload" as const,
      mediaKind: "audio" as const,
      sourceS3Key: "personal-media-uploads/user-1/upload-1/source.mp3",
      contentType: "audio/mpeg",
      fileSize: 1234,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    uploadRepository.get.mockResolvedValue(job);

    await expect(
      getPersonalMediaUploadJobForUser({
        uploadId: "upload-1",
        userId: "user-1",
      }),
    ).resolves.toBe(job);
    await expect(
      getPersonalMediaUploadJobForUser({
        uploadId: "upload-1",
        userId: "user-2",
      }),
    ).rejects.toMatchObject<Partial<PersonalMediaUploadError>>({
      code: "forbidden",
    });
  });

  it("marks a pending upload as ready for processing", async () => {
    const intent = await createPersonalMediaUploadIntent({
      userId: "user-1",
      contentType: "audio/mpeg",
      fileSize: 1234,
    });
    const job = getWrittenJob();
    uploadRepository.get.mockResolvedValue(job);

    const completed = await markPersonalMediaUploadComplete({
      uploadId: intent.uploadId,
      userId: "user-1",
      key: intent.key,
      uploadToken: intent.uploadToken,
      originalFileName: "meeting.mp3",
      title: "Planning session",
      tags: ["planning"],
    });

    expect(completed).toMatchObject({
      uploadId: intent.uploadId,
      status: "queued",
      originalFileName: "meeting.mp3",
      title: "Planning session",
      tags: ["planning"],
    });
    expect(uploadRepository.update).toHaveBeenCalledWith(completed);
  });

  it("rejects upload completion with the wrong key", async () => {
    const intent = await createPersonalMediaUploadIntent({
      userId: "user-1",
      contentType: "audio/mpeg",
      fileSize: 1234,
    });
    uploadRepository.get.mockResolvedValue(getWrittenJob());

    await expect(
      markPersonalMediaUploadComplete({
        uploadId: intent.uploadId,
        userId: "user-1",
        key: "personal-media-uploads/user-1/upload-1/other.mp3",
        uploadToken: intent.uploadToken,
      }),
    ).rejects.toMatchObject<Partial<PersonalMediaUploadError>>({
      code: "invalid_token",
    });
    expect(uploadRepository.update).not.toHaveBeenCalled();
  });

  it("rejects upload completion when the uploaded object is missing", async () => {
    const intent = await createPersonalMediaUploadIntent({
      userId: "user-1",
      contentType: "audio/mpeg",
      fileSize: 1234,
    });
    uploadRepository.get.mockResolvedValue(getWrittenJob());
    jest.mocked(getStoredObjectMetadata).mockResolvedValue(undefined);

    await expect(
      markPersonalMediaUploadComplete({
        uploadId: intent.uploadId,
        userId: "user-1",
        key: intent.key,
        uploadToken: intent.uploadToken,
      }),
    ).rejects.toMatchObject<Partial<PersonalMediaUploadError>>({
      code: "missing_object",
    });
    expect(uploadRepository.update).not.toHaveBeenCalled();
  });
});
