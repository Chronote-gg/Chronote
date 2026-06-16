import { jest } from "@jest/globals";
import { PERSONAL_MEDIA_UPLOAD_MAX_BYTES } from "../../constants";
import {
  createPersonalMediaUploadIntent,
  createPersonalRecordingSegmentUploadIntent,
  createPersonalRecordingUploadSession,
  getPersonalMediaUploadJobForUser,
  markPersonalMediaUploadComplete,
  markPersonalRecordingUploadSegmentProcessed,
  markPersonalRecordingUploadSegmentProcessing,
  markPersonalRecordingSegmentUploadComplete,
  PersonalMediaUploadError,
  resolvePersonalMediaKind,
  submitPersonalRecordingUpload,
} from "../personalMediaUploadService";
import {
  getPersonalMediaUploadRepository,
  type PersonalMediaUploadRepository,
} from "../../repositories/personalMediaUploadRepository";
import {
  getPersonalRecordingSegmentRepository,
  type PersonalRecordingSegmentRepository,
} from "../../repositories/personalRecordingSegmentRepository";
import type {
  PersonalMediaUploadJobRecord,
  PersonalRecordingSegmentRecord,
} from "../../types/db";
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
  updateProgress: jest.fn(async () => false),
} satisfies jest.Mocked<PersonalMediaUploadRepository>;

const getWrittenJob = () => {
  const job = uploadRepository.write.mock.calls[0]?.[0];
  if (!job) throw new Error("Expected upload job to be written.");
  return job;
};

const segmentStore = new Map<string, PersonalRecordingSegmentRecord>();
const segmentStoreKey = (uploadId: string, segmentKey: string) =>
  `${uploadId}:${segmentKey}`;

const segmentRepository = {
  write: jest.fn(async (segment: PersonalRecordingSegmentRecord) => {
    segmentStore.set(
      segmentStoreKey(segment.uploadId, segment.segmentKey),
      segment,
    );
  }),
  get: jest.fn(async (uploadId: string, segmentKey: string) =>
    segmentStore.get(segmentStoreKey(uploadId, segmentKey)),
  ),
  listByUpload: jest.fn(async (uploadId: string) =>
    [...segmentStore.values()]
      .filter((segment) => segment.uploadId === uploadId)
      .sort((left, right) => left.segmentKey.localeCompare(right.segmentKey)),
  ),
  update: jest.fn(async (segment: PersonalRecordingSegmentRecord) => {
    segmentStore.set(
      segmentStoreKey(segment.uploadId, segment.segmentKey),
      segment,
    );
  }),
} satisfies jest.Mocked<PersonalRecordingSegmentRepository>;

const segmentInput = (options: {
  uploadId: string;
  sourceId: string;
  sequence?: number;
  fileSize: number;
}) => ({
  uploadId: options.uploadId,
  userId: "user-1",
  sourceId: options.sourceId,
  sequence: options.sequence ?? 0,
  contentType: "audio/wav",
  fileSize: options.fileSize,
  checksumSha256: "a".repeat(64),
  durationMillis: 60_000,
  startedAt: "2026-06-15T00:00:00.000Z",
  endedAt: "2026-06-15T00:01:00.000Z",
  originalFileName: `${options.sourceId}.wav`,
});

jest.mock("../../repositories/personalMediaUploadRepository", () => ({
  getPersonalMediaUploadRepository: jest.fn(() => uploadRepository),
}));

jest.mock("../../repositories/personalRecordingSegmentRepository", () => ({
  getPersonalRecordingSegmentRepository: jest.fn(() => segmentRepository),
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
    jest
      .mocked(getPersonalRecordingSegmentRepository)
      .mockReturnValue(segmentRepository);
    segmentStore.clear();
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

  it("creates a multi-source desktop recording upload session", async () => {
    const session = await createPersonalRecordingUploadSession({
      userId: "user-1",
      sources: [
        {
          sourceId: "owner_mic",
          kind: "owner_mic",
        },
        {
          sourceId: "system_output",
          kind: "system_output",
        },
      ],
    });

    expect(session.sources).toHaveLength(2);
    expect(session.sources[0]).toMatchObject({
      sourceId: "owner_mic",
      kind: "owner_mic",
      label: "Me",
    });
    expect(session.sources[1]).toMatchObject({
      sourceId: "system_output",
      kind: "system_output",
      label: "System/Other",
    });
    expect(getSignedUploadPost).not.toHaveBeenCalled();
    expect(uploadRepository.write).toHaveBeenCalledWith(
      expect.objectContaining({
        uploadId: session.uploadId,
        ownerUserId: "user-1",
        uploadOrigin: "desktop_recording",
        sourceManifest: [
          expect.objectContaining({ sourceId: "owner_mic" }),
          expect.objectContaining({ sourceId: "system_output" }),
        ],
        fileSize: 0,
      }),
    );
  });

  it("creates an idempotent desktop recording segment upload intent", async () => {
    const session = await createPersonalRecordingUploadSession({
      userId: "user-1",
      sources: [{ sourceId: "owner_mic", kind: "owner_mic" }],
    });
    uploadRepository.get.mockResolvedValue(getWrittenJob());

    const intent = await createPersonalRecordingSegmentUploadIntent(
      segmentInput({
        uploadId: session.uploadId,
        sourceId: "owner_mic",
        fileSize: 1000,
      }),
    );
    const repeat = await createPersonalRecordingSegmentUploadIntent(
      segmentInput({
        uploadId: session.uploadId,
        sourceId: "owner_mic",
        fileSize: 1000,
      }),
    );

    expect(intent.segment).toMatchObject({
      uploadId: session.uploadId,
      sourceId: "owner_mic",
      sequence: 0,
      status: "pending_upload",
      fileSize: 1000,
    });
    expect(intent.segment.sourceS3Key).toMatch(
      /^personal-media-uploads\/user-1\/[0-9a-f-]+\/segments\/owner_mic-000000\.wav$/,
    );
    expect(intent.uploadRequired).toBe(true);
    expect(repeat.segment.segmentKey).toBe(intent.segment.segmentKey);
    expect(getSignedUploadPost).toHaveBeenCalledTimes(2);
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

  it("marks all desktop recording segments as ready for processing", async () => {
    const session = await createPersonalRecordingUploadSession({
      userId: "user-1",
      sources: [
        { sourceId: "owner_mic", kind: "owner_mic" },
        { sourceId: "system_output", kind: "system_output" },
      ],
    });
    const job = getWrittenJob();
    uploadRepository.get.mockResolvedValue(job);
    jest.mocked(getStoredObjectMetadata).mockImplementation(async (key) => ({
      contentLength: key.includes("owner_mic") ? 1000 : 2000,
      contentType: "audio/wav",
    }));
    const ownerIntent = await createPersonalRecordingSegmentUploadIntent(
      segmentInput({
        uploadId: session.uploadId,
        sourceId: "owner_mic",
        fileSize: 1000,
      }),
    );
    const systemIntent = await createPersonalRecordingSegmentUploadIntent(
      segmentInput({
        uploadId: session.uploadId,
        sourceId: "system_output",
        fileSize: 2000,
      }),
    );
    await markPersonalRecordingSegmentUploadComplete({
      uploadId: session.uploadId,
      userId: "user-1",
      sourceId: "owner_mic",
      sequence: 0,
      key: ownerIntent.segment.sourceS3Key,
      uploadToken: ownerIntent.uploadToken!,
    });
    await markPersonalRecordingSegmentUploadComplete({
      uploadId: session.uploadId,
      userId: "user-1",
      sourceId: "system_output",
      sequence: 0,
      key: systemIntent.segment.sourceS3Key,
      uploadToken: systemIntent.uploadToken!,
    });

    const completed = await submitPersonalRecordingUpload({
      uploadId: session.uploadId,
      userId: "user-1",
      title: "Desktop recording",
      tags: ["desktop"],
    });

    expect(completed).toMatchObject({
      uploadId: session.uploadId,
      status: "queued",
      title: "Desktop recording",
      tags: ["desktop"],
      fileSize: 3000,
      segmentCount: 2,
      uploadedSegmentCount: 2,
      processedSegmentCount: 0,
      sourceManifest: [
        expect.objectContaining({ sourceId: "owner_mic" }),
        expect.objectContaining({ sourceId: "system_output" }),
      ],
    });
    expect(uploadRepository.update).toHaveBeenCalledWith(completed);
    await expect(
      segmentRepository.listByUpload(session.uploadId),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceId: "owner_mic", status: "submitted" }),
        expect.objectContaining({
          sourceId: "system_output",
          status: "submitted",
        }),
      ]),
    );
  });

  it("marks individual recording segments as processed with transcript artifacts", async () => {
    const session = await createPersonalRecordingUploadSession({
      userId: "user-1",
      sources: [{ sourceId: "owner_mic", kind: "owner_mic" }],
    });
    uploadRepository.get.mockResolvedValue(getWrittenJob());
    jest.mocked(getStoredObjectMetadata).mockResolvedValue({
      contentLength: 1000,
      contentType: "audio/wav",
    });
    const intent = await createPersonalRecordingSegmentUploadIntent(
      segmentInput({
        uploadId: session.uploadId,
        sourceId: "owner_mic",
        fileSize: 1000,
      }),
    );
    const uploaded = await markPersonalRecordingSegmentUploadComplete({
      uploadId: session.uploadId,
      userId: "user-1",
      sourceId: "owner_mic",
      sequence: 0,
      key: intent.segment.sourceS3Key,
      uploadToken: intent.uploadToken!,
    });

    const processing =
      await markPersonalRecordingUploadSegmentProcessing(uploaded);
    const processed = await markPersonalRecordingUploadSegmentProcessed(
      processing,
      {
        transcriptS3Key: "personal/user-1/upload/segments/owner_mic.json",
      },
    );

    expect(processed).toMatchObject({
      status: "processed",
      transcriptS3Key: "personal/user-1/upload/segments/owner_mic.json",
    });
    await expect(
      segmentRepository.listByUpload(session.uploadId),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceId: "owner_mic",
          status: "processed",
          transcriptS3Key: "personal/user-1/upload/segments/owner_mic.json",
        }),
      ]),
    );
  });

  it("rejects desktop recording submission unless every source has a segment", async () => {
    const session = await createPersonalRecordingUploadSession({
      userId: "user-1",
      sources: [
        { sourceId: "owner_mic", kind: "owner_mic" },
        { sourceId: "system_output", kind: "system_output" },
      ],
    });
    uploadRepository.get.mockResolvedValue(getWrittenJob());
    const ownerIntent = await createPersonalRecordingSegmentUploadIntent(
      segmentInput({
        uploadId: session.uploadId,
        sourceId: "owner_mic",
        fileSize: 1000,
      }),
    );
    jest.mocked(getStoredObjectMetadata).mockResolvedValue({
      contentLength: 1000,
      contentType: "audio/wav",
    });
    await markPersonalRecordingSegmentUploadComplete({
      uploadId: session.uploadId,
      userId: "user-1",
      sourceId: "owner_mic",
      sequence: 0,
      key: ownerIntent.segment.sourceS3Key,
      uploadToken: ownerIntent.uploadToken!,
    });

    await expect(
      submitPersonalRecordingUpload({
        uploadId: session.uploadId,
        userId: "user-1",
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
