import { jest } from "@jest/globals";
import { PERSONAL_MEDIA_UPLOAD_MAX_BYTES } from "../../constants";
import {
  createPersonalMediaUploadIntent,
  createPersonalRecordingUploadIntent,
  getPersonalMediaUploadJobForUser,
  markPersonalMediaUploadComplete,
  markPersonalRecordingUploadComplete,
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

  it("creates a multi-source desktop recording upload intent", async () => {
    const intent = await createPersonalRecordingUploadIntent({
      userId: "user-1",
      sources: [
        {
          sourceId: "owner_mic",
          kind: "owner_mic",
          contentType: "audio/wav",
          fileSize: 1000,
        },
        {
          sourceId: "system_output",
          kind: "system_output",
          contentType: "audio/wav",
          fileSize: 2000,
        },
      ],
    });

    expect(intent.sources).toHaveLength(2);
    expect(intent.sources[0]).toMatchObject({
      sourceId: "owner_mic",
      kind: "owner_mic",
      label: "Me",
      contentType: "audio/wav",
      fileSize: 1000,
    });
    expect(intent.sources[1]).toMatchObject({
      sourceId: "system_output",
      kind: "system_output",
      label: "System/Other",
      contentType: "audio/wav",
      fileSize: 2000,
    });
    expect(getSignedUploadPost).toHaveBeenCalledTimes(2);
    expect(uploadRepository.write).toHaveBeenCalledWith(
      expect.objectContaining({
        uploadId: intent.uploadId,
        ownerUserId: "user-1",
        uploadOrigin: "desktop_recording",
        sourceManifest: [
          expect.objectContaining({ sourceId: "owner_mic" }),
          expect.objectContaining({ sourceId: "system_output" }),
        ],
        fileSize: 3000,
      }),
    );
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

  it("marks all desktop recording sources as ready for processing", async () => {
    const intent = await createPersonalRecordingUploadIntent({
      userId: "user-1",
      sources: [
        {
          sourceId: "owner_mic",
          kind: "owner_mic",
          contentType: "audio/wav",
          fileSize: 1000,
        },
        {
          sourceId: "system_output",
          kind: "system_output",
          contentType: "audio/wav",
          fileSize: 2000,
        },
      ],
    });
    const job = getWrittenJob();
    uploadRepository.get.mockResolvedValue(job);
    jest.mocked(getStoredObjectMetadata).mockImplementation(async (key) => ({
      contentLength: key.includes("owner_mic") ? 1000 : 2000,
      contentType: "audio/wav",
    }));

    const completed = await markPersonalRecordingUploadComplete({
      uploadId: intent.uploadId,
      userId: "user-1",
      sources: intent.sources.map((source) => ({
        sourceId: source.sourceId,
        key: source.sourceS3Key,
        uploadToken: source.uploadToken,
        originalFileName: `${source.sourceId}.wav`,
      })),
      title: "Desktop recording",
      tags: ["desktop"],
    });

    expect(completed).toMatchObject({
      uploadId: intent.uploadId,
      status: "queued",
      title: "Desktop recording",
      tags: ["desktop"],
      sourceManifest: [
        expect.objectContaining({
          sourceId: "owner_mic",
          originalFileName: "owner_mic.wav",
        }),
        expect.objectContaining({
          sourceId: "system_output",
          originalFileName: "system_output.wav",
        }),
      ],
    });
    expect(uploadRepository.update).toHaveBeenCalledWith(completed);
  });

  it("rejects desktop recording completion unless every source is submitted", async () => {
    const intent = await createPersonalRecordingUploadIntent({
      userId: "user-1",
      sources: [
        {
          sourceId: "owner_mic",
          kind: "owner_mic",
          contentType: "audio/wav",
          fileSize: 1000,
        },
        {
          sourceId: "system_output",
          kind: "system_output",
          contentType: "audio/wav",
          fileSize: 2000,
        },
      ],
    });
    uploadRepository.get.mockResolvedValue(getWrittenJob());

    await expect(
      markPersonalRecordingUploadComplete({
        uploadId: intent.uploadId,
        userId: "user-1",
        sources: [
          {
            sourceId: intent.sources[0].sourceId,
            key: intent.sources[0].sourceS3Key,
            uploadToken: intent.sources[0].uploadToken,
          },
        ],
      }),
    ).rejects.toMatchObject<Partial<PersonalMediaUploadError>>({
      code: "invalid_state",
    });
    expect(uploadRepository.update).not.toHaveBeenCalled();
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

  it("rejects upload completion when uploaded object verification fails", async () => {
    const intent = await createPersonalMediaUploadIntent({
      userId: "user-1",
      contentType: "audio/mpeg",
      fileSize: 1234,
    });
    uploadRepository.get.mockResolvedValue(getWrittenJob());
    jest
      .mocked(getStoredObjectMetadata)
      .mockRejectedValue(new Error("S3 unavailable"));

    await expect(
      markPersonalMediaUploadComplete({
        uploadId: intent.uploadId,
        userId: "user-1",
        key: intent.key,
        uploadToken: intent.uploadToken,
      }),
    ).rejects.toMatchObject<Partial<PersonalMediaUploadError>>({
      code: "storage_unavailable",
      message: "Uploaded media could not be verified. Please retry shortly.",
    });
    expect(uploadRepository.update).not.toHaveBeenCalled();
  });
});
