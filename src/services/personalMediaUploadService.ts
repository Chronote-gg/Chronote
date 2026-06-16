import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { getPersonalMediaUploadRepository } from "../repositories/personalMediaUploadRepository";
import type { PersonalMediaUploadJobRecord } from "../types/db";
import type {
  PersonalRecordingSourceKind,
  PersonalRecordingSourceRecord,
  PersonalRecordingSegmentRecord,
} from "../types/db";
import {
  PERSONAL_MEDIA_UPLOAD_ALLOWED_CONTENT_TYPES,
  PERSONAL_MEDIA_UPLOAD_MAX_BYTES,
  PERSONAL_MEDIA_UPLOAD_S3_PREFIX,
  PERSONAL_MEDIA_UPLOAD_URL_EXPIRY_SECONDS,
  PERSONAL_RECORDING_SEGMENT_MAX_BYTES,
} from "../constants";
import { getPersonalRecordingSegmentRepository } from "../repositories/personalRecordingSegmentRepository";
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
};

export type PersonalRecordingUploadSession = {
  uploadId: string;
  mediaKind: "audio";
  sources: PersonalRecordingSourceRecord[];
};

export type PersonalRecordingSegmentUploadInput = {
  uploadId: string;
  userId: string;
  sourceId: string;
  sequence: number;
  contentType: string;
  fileSize: number;
  checksumSha256: string;
  durationMillis: number;
  startedAt: string;
  endedAt: string;
  originalFileName?: string;
};

export type PersonalRecordingSegmentUploadIntent = {
  segment: PersonalRecordingSegmentRecord;
  uploadRequired: boolean;
  uploadToken?: string;
  expiresAt?: number;
  upload?: SignedUploadPost;
};

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

const buildPersonalRecordingSessionPrefix = (options: {
  userId: string;
  uploadId: string;
}) =>
  `${PERSONAL_MEDIA_UPLOAD_S3_PREFIX}${options.userId}/${options.uploadId}/segments/`;

const buildPersonalRecordingSegmentKey = (options: {
  userId: string;
  uploadId: string;
  sourceId: string;
  sequence: number;
  contentType: string;
}) => {
  const extension = CONTENT_TYPE_EXTENSIONS[options.contentType] ?? "bin";
  return `${buildPersonalRecordingSessionPrefix(options)}${options.sourceId}-${String(options.sequence).padStart(6, "0")}.${extension}`;
};

export const buildPersonalRecordingSegmentSortKey = (options: {
  sourceId: string;
  sequence: number;
}) => `${options.sourceId}#${String(options.sequence).padStart(6, "0")}`;

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

const validateRecordingSourceInput = (
  source: PersonalRecordingSourceInput,
  sourceIds: Set<string>,
) => {
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
  return {
    sourceId: source.sourceId,
    kind: source.kind,
    label: source.label?.trim() || SOURCE_KIND_LABELS[source.kind],
  } satisfies PersonalRecordingSourceRecord;
};

const assertRecordingJobForOwner = (
  job: PersonalMediaUploadJobRecord,
  userId: string,
) => {
  if (job.ownerUserId !== userId) {
    throw new PersonalMediaUploadError("Upload not found.", "forbidden");
  }
  if (job.uploadOrigin !== "desktop_recording" || !job.sourceManifest?.length) {
    throw new PersonalMediaUploadError(
      "Invalid recording upload.",
      "invalid_state",
    );
  }
};

const assertMatchingSegment = (
  existing: PersonalRecordingSegmentRecord,
  input: PersonalRecordingSegmentUploadInput,
) => {
  if (
    existing.sourceId !== input.sourceId ||
    existing.sequence !== input.sequence ||
    existing.contentType !== input.contentType ||
    existing.fileSize !== input.fileSize ||
    existing.checksumSha256 !== input.checksumSha256 ||
    existing.durationMillis !== input.durationMillis ||
    existing.startedAt !== input.startedAt ||
    existing.endedAt !== input.endedAt
  ) {
    throw new PersonalMediaUploadError(
      "Recording segment metadata does not match the existing segment.",
      "invalid_state",
    );
  }
};

const createSegmentUploadToken = (options: {
  userId: string;
  key: string;
  contentType: string;
  fileSize: number;
}) => {
  const expiresAt =
    Date.now() + PERSONAL_MEDIA_UPLOAD_URL_EXPIRY_SECONDS * 1000;
  return {
    expiresAt,
    uploadToken: createUploadToken({ ...options, expiresAt }),
  };
};

export async function createPersonalRecordingUploadSession(options: {
  userId: string;
  sources: PersonalRecordingSourceInput[];
}): Promise<PersonalRecordingUploadSession> {
  if (options.sources.length === 0) {
    throw new PersonalMediaUploadError(
      "At least one recording source is required.",
      "unsupported_type",
    );
  }

  const uploadId = randomUUID();
  const sourceIds = new Set<string>();
  const sources = options.sources.map((source) =>
    validateRecordingSourceInput(source, sourceIds),
  );

  const now = new Date().toISOString();
  await getPersonalMediaUploadRepository().write({
    uploadId,
    ownerUserId: options.userId,
    status: "pending_upload",
    mediaKind: "audio",
    uploadOrigin: "desktop_recording",
    sourceS3Key: buildPersonalRecordingSessionPrefix({
      userId: options.userId,
      uploadId,
    }),
    sourceManifest: sources,
    contentType: "audio/wav",
    fileSize: 0,
    createdAt: now,
    updatedAt: now,
  });

  return { uploadId, mediaKind: "audio", sources };
}

export async function createPersonalRecordingSegmentUploadIntent(
  input: PersonalRecordingSegmentUploadInput,
): Promise<PersonalRecordingSegmentUploadIntent> {
  const job = await getPersonalMediaUploadJobForUser({
    uploadId: input.uploadId,
    userId: input.userId,
  });
  assertRecordingJobForOwner(job, input.userId);
  if (!allowedContentTypes.has(input.contentType)) {
    throw new PersonalMediaUploadError(
      "Unsupported media type.",
      "unsupported_type",
    );
  }
  if (resolvePersonalMediaKind(input.contentType) !== "audio") {
    throw new PersonalMediaUploadError(
      "Desktop recordings must be uploaded as audio.",
      "unsupported_type",
    );
  }
  if (input.fileSize > PERSONAL_RECORDING_SEGMENT_MAX_BYTES) {
    throw new PersonalMediaUploadError(
      "Recording segment is too large.",
      "too_large",
    );
  }
  const source = job.sourceManifest?.find(
    (candidate) => candidate.sourceId === input.sourceId,
  );
  if (!source) {
    throw new PersonalMediaUploadError(
      "Recording source was not registered for this upload.",
      "invalid_state",
    );
  }

  const segmentKey = buildPersonalRecordingSegmentSortKey(input);
  const repository = getPersonalRecordingSegmentRepository();
  const existing = await repository.get(input.uploadId, segmentKey);
  if (existing) {
    assertMatchingSegment(existing, input);
    if (!["pending_upload", "failed"].includes(existing.status)) {
      return { segment: existing, uploadRequired: false };
    }
  }

  const key = buildPersonalRecordingSegmentKey({
    userId: input.userId,
    uploadId: input.uploadId,
    sourceId: input.sourceId,
    sequence: input.sequence,
    contentType: input.contentType,
  });
  const upload = await getSignedUploadPost(
    key,
    input.contentType,
    input.fileSize,
    PERSONAL_MEDIA_UPLOAD_URL_EXPIRY_SECONDS,
  );
  if (!upload) {
    throw new PersonalMediaUploadError(
      "Failed to create upload form.",
      "signing_failed",
    );
  }

  const now = new Date().toISOString();
  const segment: PersonalRecordingSegmentRecord = {
    ...(existing ?? {}),
    uploadId: input.uploadId,
    segmentKey,
    ownerUserId: input.userId,
    sourceId: input.sourceId,
    sequence: input.sequence,
    kind: source.kind,
    label: source.label,
    sourceS3Key: key,
    contentType: input.contentType,
    fileSize: input.fileSize,
    checksumSha256: input.checksumSha256,
    durationMillis: input.durationMillis,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    status: "pending_upload",
    originalFileName: input.originalFileName,
    errorMessage: undefined,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  await repository.update(segment);
  const { expiresAt, uploadToken } = createSegmentUploadToken({
    userId: input.userId,
    key,
    contentType: input.contentType,
    fileSize: input.fileSize,
  });
  return { segment, uploadRequired: true, uploadToken, expiresAt, upload };
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

export async function markPersonalRecordingSegmentUploadComplete(options: {
  uploadId: string;
  userId: string;
  sourceId: string;
  sequence: number;
  key: string;
  uploadToken: string;
}): Promise<PersonalRecordingSegmentRecord> {
  const job = await getPersonalMediaUploadJobForUser({
    uploadId: options.uploadId,
    userId: options.userId,
  });
  assertRecordingJobForOwner(job, options.userId);
  const segmentKey = buildPersonalRecordingSegmentSortKey(options);
  const repository = getPersonalRecordingSegmentRepository();
  const segment = await repository.get(options.uploadId, segmentKey);
  if (!segment) {
    throw new PersonalMediaUploadError(
      "Recording segment not found.",
      "not_found",
    );
  }
  if (segment.sourceS3Key !== options.key) {
    throw new PersonalMediaUploadError("Invalid upload key.", "invalid_token");
  }
  if (
    !["pending_upload", "uploaded", "submitted", "processed"].includes(
      segment.status,
    )
  ) {
    throw new PersonalMediaUploadError(
      "Recording segment is not uploadable.",
      "invalid_state",
    );
  }
  if (["uploaded", "submitted", "processed"].includes(segment.status)) {
    return segment;
  }
  const validToken = verifyUploadToken({
    token: options.uploadToken,
    userId: options.userId,
    key: segment.sourceS3Key,
    contentType: segment.contentType,
    fileSize: segment.fileSize,
  });
  if (!validToken) {
    throw new PersonalMediaUploadError(
      "Upload authorization expired or invalid.",
      "invalid_token",
    );
  }
  let objectMetadata: Awaited<ReturnType<typeof getStoredObjectMetadata>>;
  try {
    objectMetadata = await getStoredObjectMetadata(segment.sourceS3Key);
  } catch {
    throw new PersonalMediaUploadError(
      "Uploaded media could not be verified. Please retry shortly.",
      "storage_unavailable",
    );
  }
  if (!objectMetadata) {
    throw new PersonalMediaUploadError(
      "Uploaded media was not found. Please upload the segment again.",
      "missing_object",
    );
  }
  if (
    objectMetadata.contentLength !== undefined &&
    objectMetadata.contentLength !== segment.fileSize
  ) {
    throw new PersonalMediaUploadError(
      "Uploaded media size does not match the requested segment upload.",
      "invalid_state",
    );
  }

  const now = new Date().toISOString();
  const next: PersonalRecordingSegmentRecord = {
    ...segment,
    status: "uploaded",
    errorMessage: undefined,
    uploadedAt: now,
    updatedAt: now,
  };
  await repository.update(next);
  return next;
}

export async function submitPersonalRecordingUpload(options: {
  uploadId: string;
  userId: string;
  title?: string;
  tags?: string[];
}): Promise<PersonalMediaUploadJobRecord> {
  const job = await getPersonalMediaUploadJobForUser(options);
  assertRecordingJobForOwner(job, options.userId);
  if (job.status !== "pending_upload") {
    return job;
  }
  const repository = getPersonalRecordingSegmentRepository();
  const segments = await repository.listByUpload(options.uploadId);
  if (segments.length === 0) {
    throw new PersonalMediaUploadError(
      "At least one recording segment must be uploaded before submission.",
      "invalid_state",
    );
  }
  const sourcesWithSegments = new Set(
    segments.map((segment) => segment.sourceId),
  );
  const missingSource = job.sourceManifest?.find(
    (source) => !sourcesWithSegments.has(source.sourceId),
  );
  if (missingSource) {
    throw new PersonalMediaUploadError(
      "Every recording source must include at least one uploaded segment.",
      "invalid_state",
    );
  }
  const notUploaded = segments.find(
    (segment) =>
      !["uploaded", "submitted", "processed"].includes(segment.status),
  );
  if (notUploaded) {
    throw new PersonalMediaUploadError(
      "All recording segments must be uploaded before submission.",
      "invalid_state",
    );
  }

  const now = new Date().toISOString();
  for (const segment of segments) {
    if (segment.status !== "uploaded") continue;
    await repository.update({
      ...segment,
      status: "submitted",
      submittedAt: now,
      updatedAt: now,
    });
  }
  const totalBytes = segments.reduce(
    (sum, segment) => sum + segment.fileSize,
    0,
  );
  const next: PersonalMediaUploadJobRecord = {
    ...job,
    status: "queued",
    title: options.title,
    tags: options.tags,
    fileSize: totalBytes,
    segmentCount: segments.length,
    uploadedSegmentCount: segments.length,
    processedSegmentCount: segments.filter(
      (segment) => segment.status === "processed",
    ).length,
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

export async function listPersonalRecordingUploadSegments(uploadId: string) {
  return getPersonalRecordingSegmentRepository().listByUpload(uploadId);
}

export async function markPersonalRecordingUploadSegmentProcessing(
  segment: PersonalRecordingSegmentRecord,
) {
  const now = new Date().toISOString();
  const next: PersonalRecordingSegmentRecord = {
    ...segment,
    status: "processing",
    errorMessage: undefined,
    updatedAt: now,
  };
  await getPersonalRecordingSegmentRepository().update(next);
  return next;
}

export async function markPersonalRecordingUploadSegmentProcessed(
  segment: PersonalRecordingSegmentRecord,
  options: { transcriptS3Key?: string } = {},
) {
  const now = new Date().toISOString();
  const next: PersonalRecordingSegmentRecord = {
    ...segment,
    status: "processed",
    errorMessage: undefined,
    processedAt: now,
    transcriptS3Key: options.transcriptS3Key ?? segment.transcriptS3Key,
    updatedAt: now,
  };
  await getPersonalRecordingSegmentRepository().update(next);
  return next;
}

export async function markPersonalRecordingUploadSegmentFailed(
  segment: PersonalRecordingSegmentRecord,
  error: unknown,
) {
  const now = new Date().toISOString();
  const errorMessage =
    error instanceof Error ? error.message : "Processing failed.";
  const next: PersonalRecordingSegmentRecord = {
    ...segment,
    status: "failed",
    errorMessage,
    updatedAt: now,
  };
  await getPersonalRecordingSegmentRepository().update(next);
  return next;
}

export async function markPersonalRecordingUploadSegmentsFailed(
  uploadId: string,
  error: unknown,
) {
  const repository = getPersonalRecordingSegmentRepository();
  const now = new Date().toISOString();
  const errorMessage =
    error instanceof Error ? error.message : "Processing failed.";
  const segments = await repository.listByUpload(uploadId);
  await Promise.all(
    segments
      .filter((segment) => segment.status === "processing")
      .map((segment) =>
        repository.update({
          ...segment,
          status: "failed",
          errorMessage,
          updatedAt: now,
        }),
      ),
  );
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

export async function updateClaimedPersonalMediaUploadJobProgress(options: {
  uploadId: string;
  instanceId: string;
  segmentCount: number;
  uploadedSegmentCount: number;
  processedSegmentCount: number;
  updatedAt: string;
}) {
  return getPersonalMediaUploadRepository().updateProgress(options);
}
