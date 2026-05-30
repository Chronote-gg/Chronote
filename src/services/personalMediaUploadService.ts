import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { getPersonalMediaUploadRepository } from "../repositories/personalMediaUploadRepository";
import type { PersonalMediaUploadJobRecord } from "../types/db";
import type {
  PersonalRecordingSourceKind,
  PersonalRecordingSourceRecord,
} from "../types/db";
import {
  PERSONAL_MEDIA_UPLOAD_ALLOWED_CONTENT_TYPES,
  PERSONAL_MEDIA_UPLOAD_MAX_BYTES,
  PERSONAL_MEDIA_UPLOAD_S3_PREFIX,
  PERSONAL_MEDIA_UPLOAD_URL_EXPIRY_SECONDS,
} from "../constants";
import { config } from "./configService";
import {
  getSignedUploadPost,
  getStoredObjectMetadata,
  type SignedUploadPost,
} from "./storageService";

export type PersonalMediaKind = "audio" | "video";
export type PersonalRecordingSourceInput = {
  sourceId: string;
  kind: PersonalRecordingSourceKind;
  label?: string;
  contentType: string;
  fileSize: number;
};

export type PersonalRecordingUploadSourceIntent =
  PersonalRecordingSourceRecord & {
    uploadToken: string;
    expiresAt: number;
    upload: SignedUploadPost;
  };

export type PersonalRecordingUploadIntent = {
  uploadId: string;
  mediaKind: "audio";
  expiresAt: number;
  sources: PersonalRecordingUploadSourceIntent[];
};

const toPersonalRecordingSourceRecord = (
  source: PersonalRecordingUploadSourceIntent,
): PersonalRecordingSourceRecord => ({
  sourceId: source.sourceId,
  kind: source.kind,
  label: source.label,
  sourceS3Key: source.sourceS3Key,
  contentType: source.contentType,
  fileSize: source.fileSize,
  originalFileName: source.originalFileName,
});

export type PersonalMediaUploadIntent = {
  uploadId: string;
  key: string;
  uploadToken: string;
  contentType: string;
  fileSize: number;
  mediaKind: PersonalMediaKind;
  expiresAt: number;
  upload: SignedUploadPost;
};

export class PersonalMediaUploadError extends Error {
  constructor(
    message: string,
    readonly code:
      | "unsupported_type"
      | "too_large"
      | "signing_failed"
      | "not_found"
      | "forbidden"
      | "expired"
      | "invalid_token"
      | "missing_object"
      | "storage_unavailable"
      | "invalid_state",
  ) {
    super(message);
  }
}

const CONTENT_TYPE_EXTENSIONS: Record<string, string> = {
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/mp4": "m4a",
  "audio/m4a": "m4a",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/webm": "webm",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
};

const SOURCE_KIND_LABELS: Record<PersonalRecordingSourceKind, string> = {
  owner_mic: "Me",
  system_output: "System/Other",
};
const RECORDING_SOURCE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

const allowedContentTypes = new Set(
  PERSONAL_MEDIA_UPLOAD_ALLOWED_CONTENT_TYPES,
);

export const resolvePersonalMediaKind = (
  contentType: string,
): PersonalMediaKind | null => {
  if (contentType.startsWith("audio/")) return "audio";
  if (contentType.startsWith("video/")) return "video";
  return null;
};

const buildPersonalMediaUploadKey = (options: {
  userId: string;
  uploadId: string;
  contentType: string;
}) => {
  const extension = CONTENT_TYPE_EXTENSIONS[options.contentType] ?? "bin";
  return `${PERSONAL_MEDIA_UPLOAD_S3_PREFIX}${options.userId}/${options.uploadId}/source.${extension}`;
};

const buildPersonalRecordingSourceKey = (options: {
  userId: string;
  uploadId: string;
  sourceId: string;
  contentType: string;
}) => {
  const extension = CONTENT_TYPE_EXTENSIONS[options.contentType] ?? "bin";
  return `${PERSONAL_MEDIA_UPLOAD_S3_PREFIX}${options.userId}/${options.uploadId}/${options.sourceId}.${extension}`;
};

const signUploadToken = (payload: string) =>
  createHmac("sha256", config.server.sessionSecret)
    .update(payload)
    .digest("base64url");

const createUploadToken = (options: {
  userId: string;
  key: string;
  contentType: string;
  fileSize: number;
  expiresAt: number;
}) => {
  const payload = [
    options.userId,
    options.key,
    options.contentType,
    String(options.fileSize),
    String(options.expiresAt),
  ].join(".");
  return `${options.expiresAt}.${signUploadToken(payload)}`;
};

const verifyUploadToken = (options: {
  token: string;
  userId: string;
  key: string;
  contentType: string;
  fileSize: number;
}) => {
  const [expiresAtText, signature] = options.token.split(".");
  const expiresAt = Number.parseInt(expiresAtText ?? "", 10);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() || !signature) {
    return false;
  }
  const expected = createUploadToken({
    userId: options.userId,
    key: options.key,
    contentType: options.contentType,
    fileSize: options.fileSize,
    expiresAt,
  }).split(".")[1];
  if (!expected) return false;
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.byteLength === expectedBuffer.byteLength &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
};

export async function createPersonalMediaUploadIntent(options: {
  userId: string;
  contentType: string;
  fileSize: number;
}): Promise<PersonalMediaUploadIntent> {
  if (!allowedContentTypes.has(options.contentType)) {
    throw new PersonalMediaUploadError(
      "Unsupported media type.",
      "unsupported_type",
    );
  }
  if (options.fileSize > PERSONAL_MEDIA_UPLOAD_MAX_BYTES) {
    throw new PersonalMediaUploadError("Media file is too large.", "too_large");
  }

  const mediaKind = resolvePersonalMediaKind(options.contentType);
  if (!mediaKind) {
    throw new PersonalMediaUploadError(
      "Unsupported media type.",
      "unsupported_type",
    );
  }

  const uploadId = randomUUID();
  const key = buildPersonalMediaUploadKey({
    userId: options.userId,
    uploadId,
    contentType: options.contentType,
  });
  const upload = await getSignedUploadPost(
    key,
    options.contentType,
    options.fileSize,
    PERSONAL_MEDIA_UPLOAD_URL_EXPIRY_SECONDS,
  );
  if (!upload) {
    throw new PersonalMediaUploadError(
      "Failed to create upload form.",
      "signing_failed",
    );
  }

  const expiresAt =
    Date.now() + PERSONAL_MEDIA_UPLOAD_URL_EXPIRY_SECONDS * 1000;
  const uploadToken = createUploadToken({
    userId: options.userId,
    key,
    contentType: options.contentType,
    fileSize: options.fileSize,
    expiresAt,
  });
  const now = new Date().toISOString();
  await getPersonalMediaUploadRepository().write({
    uploadId,
    ownerUserId: options.userId,
    status: "pending_upload",
    mediaKind,
    sourceS3Key: key,
    contentType: options.contentType,
    fileSize: options.fileSize,
    createdAt: now,
    updatedAt: now,
    expiresAt: Math.floor(expiresAt / 1000),
  });

  return {
    uploadId,
    key,
    uploadToken,
    contentType: options.contentType,
    fileSize: options.fileSize,
    mediaKind,
    expiresAt,
    upload,
  };
}

export async function createPersonalRecordingUploadIntent(options: {
  userId: string;
  sources: PersonalRecordingSourceInput[];
}): Promise<PersonalRecordingUploadIntent> {
  if (options.sources.length === 0) {
    throw new PersonalMediaUploadError(
      "At least one recording source is required.",
      "unsupported_type",
    );
  }

  const uploadId = randomUUID();
  const expiresAt =
    Date.now() + PERSONAL_MEDIA_UPLOAD_URL_EXPIRY_SECONDS * 1000;
  const sources: PersonalRecordingUploadSourceIntent[] = [];
  const sourceIds = new Set<string>();
  let totalBytes = 0;

  for (const source of options.sources) {
    if (
      !RECORDING_SOURCE_ID_PATTERN.test(source.sourceId) ||
      sourceIds.has(source.sourceId)
    ) {
      throw new PersonalMediaUploadError(
        "Recording source IDs must be unique and URL-safe.",
        "invalid_state",
      );
    }
    sourceIds.add(source.sourceId);

    if (!allowedContentTypes.has(source.contentType)) {
      throw new PersonalMediaUploadError(
        "Unsupported media type.",
        "unsupported_type",
      );
    }
    if (source.fileSize > PERSONAL_MEDIA_UPLOAD_MAX_BYTES) {
      throw new PersonalMediaUploadError(
        "Media file is too large.",
        "too_large",
      );
    }
    totalBytes += source.fileSize;
    if (totalBytes > PERSONAL_MEDIA_UPLOAD_MAX_BYTES) {
      throw new PersonalMediaUploadError(
        "Media file is too large.",
        "too_large",
      );
    }
    if (resolvePersonalMediaKind(source.contentType) !== "audio") {
      throw new PersonalMediaUploadError(
        "Desktop recordings must be uploaded as audio.",
        "unsupported_type",
      );
    }

    const key = buildPersonalRecordingSourceKey({
      userId: options.userId,
      uploadId,
      sourceId: source.sourceId,
      contentType: source.contentType,
    });
    const upload = await getSignedUploadPost(
      key,
      source.contentType,
      source.fileSize,
      PERSONAL_MEDIA_UPLOAD_URL_EXPIRY_SECONDS,
    );
    if (!upload) {
      throw new PersonalMediaUploadError(
        "Failed to create upload form.",
        "signing_failed",
      );
    }
    const uploadToken = createUploadToken({
      userId: options.userId,
      key,
      contentType: source.contentType,
      fileSize: source.fileSize,
      expiresAt,
    });

    sources.push({
      sourceId: source.sourceId,
      kind: source.kind,
      label: source.label?.trim() || SOURCE_KIND_LABELS[source.kind],
      sourceS3Key: key,
      contentType: source.contentType,
      fileSize: source.fileSize,
      uploadToken,
      expiresAt,
      upload,
    });
  }

  const now = new Date().toISOString();
  await getPersonalMediaUploadRepository().write({
    uploadId,
    ownerUserId: options.userId,
    status: "pending_upload",
    mediaKind: "audio",
    uploadOrigin: "desktop_recording",
    sourceS3Key: sources[0].sourceS3Key,
    sourceManifest: sources.map(toPersonalRecordingSourceRecord),
    contentType: sources[0].contentType,
    fileSize: totalBytes,
    createdAt: now,
    updatedAt: now,
    expiresAt: Math.floor(expiresAt / 1000),
  });

  return { uploadId, mediaKind: "audio", expiresAt, sources };
}

export async function getPersonalMediaUploadJobForUser(options: {
  uploadId: string;
  userId: string;
}): Promise<PersonalMediaUploadJobRecord> {
  const job = await getPersonalMediaUploadRepository().get(options.uploadId);
  if (!job) {
    throw new PersonalMediaUploadError("Upload not found.", "not_found");
  }
  if (job.ownerUserId !== options.userId) {
    throw new PersonalMediaUploadError("Upload not found.", "forbidden");
  }
  return job;
}

export async function markPersonalMediaUploadComplete(options: {
  uploadId: string;
  userId: string;
  key: string;
  uploadToken: string;
  originalFileName?: string;
  title?: string;
  tags?: string[];
}): Promise<PersonalMediaUploadJobRecord> {
  const job = await getPersonalMediaUploadJobForUser(options);
  if (job.status !== "pending_upload") {
    throw new PersonalMediaUploadError(
      "Upload has already been submitted.",
      "invalid_state",
    );
  }
  if (job.sourceS3Key !== options.key) {
    throw new PersonalMediaUploadError("Invalid upload key.", "invalid_token");
  }
  const validToken = verifyUploadToken({
    token: options.uploadToken,
    userId: options.userId,
    key: job.sourceS3Key,
    contentType: job.contentType,
    fileSize: job.fileSize,
  });
  if (!validToken) {
    throw new PersonalMediaUploadError(
      "Upload authorization expired or invalid.",
      "invalid_token",
    );
  }
  let objectMetadata: Awaited<ReturnType<typeof getStoredObjectMetadata>>;
  try {
    objectMetadata = await getStoredObjectMetadata(job.sourceS3Key);
  } catch {
    throw new PersonalMediaUploadError(
      "Uploaded media could not be verified. Please retry shortly.",
      "storage_unavailable",
    );
  }
  if (!objectMetadata) {
    throw new PersonalMediaUploadError(
      "Uploaded media was not found. Please upload the file again.",
      "missing_object",
    );
  }
  if (
    objectMetadata.contentLength !== undefined &&
    objectMetadata.contentLength !== job.fileSize
  ) {
    throw new PersonalMediaUploadError(
      "Uploaded media size does not match the requested upload.",
      "invalid_state",
    );
  }

  const now = new Date().toISOString();
  const next: PersonalMediaUploadJobRecord = {
    ...job,
    status: "queued",
    originalFileName: options.originalFileName,
    title: options.title,
    tags: options.tags,
    queuedAt: now,
    errorMessage: undefined,
    retryable: undefined,
    claimExpiresAt: undefined,
    processingOwnerInstanceId: undefined,
    updatedAt: now,
  };
  await getPersonalMediaUploadRepository().update(next);
  return next;
}

export async function markPersonalRecordingUploadComplete(options: {
  uploadId: string;
  userId: string;
  sources: Array<{
    sourceId: string;
    key: string;
    uploadToken: string;
    originalFileName?: string;
  }>;
  title?: string;
  tags?: string[];
}): Promise<PersonalMediaUploadJobRecord> {
  const job = await getPersonalMediaUploadJobForUser(options);
  if (job.status !== "pending_upload") {
    throw new PersonalMediaUploadError(
      "Upload has already been submitted.",
      "invalid_state",
    );
  }
  if (job.uploadOrigin !== "desktop_recording" || !job.sourceManifest?.length) {
    throw new PersonalMediaUploadError(
      "Invalid recording upload.",
      "invalid_state",
    );
  }

  const completedBySource = new Map(
    options.sources.map((source) => [source.sourceId, source]),
  );
  if (completedBySource.size !== job.sourceManifest.length) {
    throw new PersonalMediaUploadError(
      "All recording sources must be submitted.",
      "invalid_state",
    );
  }

  const nextManifest: PersonalRecordingSourceRecord[] = [];
  for (const source of job.sourceManifest) {
    const completed = completedBySource.get(source.sourceId);
    if (!completed || completed.key !== source.sourceS3Key) {
      throw new PersonalMediaUploadError(
        "Invalid upload key.",
        "invalid_token",
      );
    }
    const validToken = verifyUploadToken({
      token: completed.uploadToken,
      userId: options.userId,
      key: source.sourceS3Key,
      contentType: source.contentType,
      fileSize: source.fileSize,
    });
    if (!validToken) {
      throw new PersonalMediaUploadError(
        "Upload authorization expired or invalid.",
        "invalid_token",
      );
    }
    let objectMetadata: Awaited<ReturnType<typeof getStoredObjectMetadata>>;
    try {
      objectMetadata = await getStoredObjectMetadata(source.sourceS3Key);
    } catch {
      throw new PersonalMediaUploadError(
        "Uploaded media could not be verified. Please retry shortly.",
        "storage_unavailable",
      );
    }
    if (!objectMetadata) {
      throw new PersonalMediaUploadError(
        "Uploaded media was not found. Please upload the file again.",
        "missing_object",
      );
    }
    if (
      objectMetadata.contentLength !== undefined &&
      objectMetadata.contentLength !== source.fileSize
    ) {
      throw new PersonalMediaUploadError(
        "Uploaded media size does not match the requested upload.",
        "invalid_state",
      );
    }
    nextManifest.push({
      ...source,
      originalFileName: completed.originalFileName,
    });
  }

  const now = new Date().toISOString();
  const next: PersonalMediaUploadJobRecord = {
    ...job,
    status: "queued",
    sourceManifest: nextManifest,
    title: options.title,
    tags: options.tags,
    queuedAt: now,
    errorMessage: undefined,
    retryable: undefined,
    claimExpiresAt: undefined,
    processingOwnerInstanceId: undefined,
    updatedAt: now,
  };
  await getPersonalMediaUploadRepository().update(next);
  return next;
}

export async function updatePersonalMediaUploadJobRecord(
  job: PersonalMediaUploadJobRecord,
) {
  await getPersonalMediaUploadRepository().update(job);
}

export async function updateClaimedPersonalMediaUploadJobRecord(
  job: PersonalMediaUploadJobRecord,
  instanceId: string,
) {
  return getPersonalMediaUploadRepository().updateClaimed(job, instanceId);
}
