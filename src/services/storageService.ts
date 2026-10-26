import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { promises as fs } from "node:fs";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { config } from "./configService";
import { getMockStore } from "../repositories/mockStore";
import { MOCK_STORAGE_UPLOAD_PATH } from "../constants";

export type SignedUploadPost = {
  url: string;
  fields: Record<string, string>;
};

export type StoredObjectMetadata = {
  contentLength?: number;
  contentType?: string;
};

export class StoredObjectMetadataError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "StoredObjectMetadataError";
  }
}

const storageCredentials =
  config.storage.accessKeyId.length > 0 &&
  config.storage.secretAccessKey.length > 0
    ? {
        accessKeyId: config.storage.accessKeyId,
        secretAccessKey: config.storage.secretAccessKey,
      }
    : undefined;

const s3Client = new S3Client({
  region: config.storage.awsRegion,
  endpoint: config.storage.endpoint,
  forcePathStyle: config.storage.forcePathStyle,
  ...(storageCredentials ? { credentials: storageCredentials } : {}),
});

const buildMockUploadPost = (
  key: string,
  contentType: string,
  maxBytes: number,
): SignedUploadPost => ({
  url: `${config.mcp.publicBaseUrl}${MOCK_STORAGE_UPLOAD_PATH}`,
  fields: {
    key,
    "Content-Type": contentType,
    "x-chronote-max-bytes": String(maxBytes),
  },
});

export type StorageWriteOptions = {
  signal?: AbortSignal;
  immutable?: boolean;
  onAcknowledged?: (receipt: { key: string; versionId: string | null }) => void;
};

function acknowledgeUpload(
  options: StorageWriteOptions,
  key: string,
  versionId: string | undefined,
) {
  options.onAcknowledged?.({ key, versionId: versionId ?? null });
}
export async function uploadObjectToS3(
  key: string,
  body: string | Uint8Array | Buffer,
  contentType: string,
  options: StorageWriteOptions = {},
): Promise<string | undefined> {
  if (options.signal?.aborted) return undefined;
  if (config.mock.enabled) {
    if (options.immutable && getMockStore().objectsByKey.has(key))
      return undefined;
    getMockStore().objectsByKey.set(
      key,
      typeof body === "string" ? body : Buffer.from(body),
    );
    return key;
  }

  if (!config.storage.transcriptBucket) {
    console.warn("TRANSCRIPTS_BUCKET not set; skipping upload to S3.");
    return undefined;
  }

  try {
    const contentLength =
      typeof body === "string"
        ? Buffer.byteLength(body)
        : Buffer.isBuffer(body)
          ? body.byteLength
          : body.length;

    const receipt = await s3Client.send(
      new PutObjectCommand({
        Bucket: config.storage.transcriptBucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ContentLength: contentLength,
        ...(options.immutable ? { IfNoneMatch: "*" } : {}),
      }),
      { abortSignal: options.signal },
    );
    acknowledgeUpload(options, key, receipt.VersionId);
    return key;
  } catch (error) {
    if (!options.immutable)
      console.error("Failed to upload object to S3", error);
    return undefined;
  }
}

const isMissingKeyError = (error: unknown): boolean => {
  if (!error || typeof error !== "object") return false;
  const maybe = error as {
    name?: string;
    Code?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return (
    maybe.name === "NoSuchKey" ||
    maybe.Code === "NoSuchKey" ||
    maybe.name === "NotFound" ||
    maybe.$metadata?.httpStatusCode === 404
  );
};

async function fetchObjectAsString(
  key: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  signal?.throwIfAborted();
  if (config.mock.enabled) {
    const mockObject = getMockStore().objectsByKey.get(key);
    return Buffer.isBuffer(mockObject)
      ? mockObject.toString("utf8")
      : mockObject;
  }

  if (!config.storage.transcriptBucket) {
    console.warn("TRANSCRIPTS_BUCKET not set; cannot fetch object from S3.");
    return undefined;
  }

  try {
    const response = await s3Client.send(
      new GetObjectCommand({
        Bucket: config.storage.transcriptBucket,
        Key: key,
      }),
      { abortSignal: signal },
    );

    const body = response.Body;
    if (!body) return undefined;

    const text = await body.transformToString();
    signal?.throwIfAborted();
    return text;
  } catch (error) {
    signal?.throwIfAborted();
    if (isMissingKeyError(error)) {
      return undefined;
    }
    console.error("Failed to fetch object from S3", error);
  }

  return undefined;
}

export async function fetchJsonFromS3<T>(
  key: string,
  signal?: AbortSignal,
): Promise<T | undefined> {
  const raw = await fetchObjectAsString(key, signal);
  signal?.throwIfAborted();
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    console.error("Failed to parse JSON from S3", error);
    return undefined;
  }
}

export async function getSignedUploadUrl(
  key: string,
  contentType: string,
  expiresInSeconds: number = 300,
): Promise<string | undefined> {
  if (!config.storage.transcriptBucket) {
    return undefined;
  }
  try {
    return await getSignedUrl(
      s3Client,
      new PutObjectCommand({
        Bucket: config.storage.transcriptBucket,
        Key: key,
        ContentType: contentType,
      }),
      { expiresIn: expiresInSeconds },
    );
  } catch (error) {
    console.error("Failed to generate signed upload URL", error);
    return undefined;
  }
}

export async function getSignedUploadPost(
  key: string,
  contentType: string,
  maxBytes: number,
  expiresInSeconds: number = 300,
): Promise<SignedUploadPost | undefined> {
  if (config.mock.enabled) {
    return buildMockUploadPost(key, contentType, maxBytes);
  }

  if (!config.storage.transcriptBucket) {
    return undefined;
  }
  try {
    return await createPresignedPost(s3Client, {
      Bucket: config.storage.transcriptBucket,
      Key: key,
      Conditions: [
        ["content-length-range", 1, maxBytes],
        ["eq", "$Content-Type", contentType],
      ],
      Fields: {
        "Content-Type": contentType,
      },
      Expires: expiresInSeconds,
    });
  } catch (error) {
    console.error("Failed to generate signed upload POST", error);
    return undefined;
  }
}

export async function getStoredObjectMetadata(
  key: string,
): Promise<StoredObjectMetadata | undefined> {
  if (config.mock.enabled) {
    const mockObject = getMockStore().objectsByKey.get(key);
    return mockObject
      ? {
          contentLength: Buffer.isBuffer(mockObject)
            ? mockObject.byteLength
            : Buffer.byteLength(mockObject),
        }
      : undefined;
  }

  if (!config.storage.transcriptBucket) {
    console.warn("TRANSCRIPTS_BUCKET not set; cannot inspect object in S3.");
    return undefined;
  }

  try {
    const response = await s3Client.send(
      new HeadObjectCommand({
        Bucket: config.storage.transcriptBucket,
        Key: key,
      }),
    );
    return {
      contentLength: response.ContentLength,
      contentType: response.ContentType,
    };
  } catch (error) {
    if (isMissingKeyError(error)) return undefined;
    console.error("Failed to inspect object in S3", error);
    throw new StoredObjectMetadataError("Failed to inspect object in S3.", {
      cause: error,
    });
  }
}

export async function getSignedObjectUrl(
  key: string,
  expiresInSeconds: number = 900,
): Promise<string | undefined> {
  if (!config.storage.transcriptBucket) {
    return undefined;
  }
  try {
    return await getSignedUrl(
      s3Client,
      new GetObjectCommand({
        Bucket: config.storage.transcriptBucket,
        Key: key,
      }),
      { expiresIn: expiresInSeconds },
    );
  } catch (error) {
    console.error("Failed to sign S3 object URL", error);
    return undefined;
  }
}

export async function downloadObjectToFile(
  key: string,
  destinationPath: string,
  signal?: AbortSignal,
): Promise<boolean> {
  signal?.throwIfAborted();
  if (config.mock.enabled) {
    const mockObject = getMockStore().objectsByKey.get(key);
    if (!mockObject) return false;
    await fs.writeFile(destinationPath, mockObject);
    return true;
  }

  if (!config.storage.transcriptBucket) {
    console.warn("TRANSCRIPTS_BUCKET not set; cannot download object from S3.");
    return false;
  }
  try {
    const response = await s3Client.send(
      new GetObjectCommand({
        Bucket: config.storage.transcriptBucket,
        Key: key,
      }),
      { abortSignal: signal },
    );
    const body = response.Body;
    if (!body) return false;
    const bytes = await body.transformToByteArray();
    signal?.throwIfAborted();
    await fs.writeFile(destinationPath, bytes);
    signal?.throwIfAborted();
    return true;
  } catch (error) {
    signal?.throwIfAborted();
    console.error("Failed to download object from S3", error);
    return false;
  }
}

/** Bytes are verified by checkpoint callers. Existing text/file error behavior is unchanged. */
export async function fetchObjectBytesFromS3(
  key: string,
  signal?: AbortSignal,
): Promise<Uint8Array | undefined> {
  signal?.throwIfAborted();
  if (config.mock.enabled) {
    const value = getMockStore().objectsByKey.get(key);
    return value === undefined ? undefined : Buffer.from(value);
  }
  if (!config.storage.transcriptBucket) return undefined;
  try {
    const response = await s3Client.send(
      new GetObjectCommand({
        Bucket: config.storage.transcriptBucket,
        Key: key,
      }),
      { abortSignal: signal },
    );
    const bytes = await response.Body?.transformToByteArray();
    signal?.throwIfAborted();
    return bytes;
  } catch (error) {
    if (isMissingKeyError(error)) return undefined;
    throw new StoredObjectMetadataError("Failed to read checkpoint object", {
      cause: error,
    });
  }
}
