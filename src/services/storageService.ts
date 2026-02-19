import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { config } from "./configService";
import { getMockStore } from "../repositories/mockStore";

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

export async function uploadObjectToS3(
  key: string,
  body: string | Uint8Array | Buffer,
  contentType: string,
): Promise<string | undefined> {
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

    await s3Client.send(
      new PutObjectCommand({
        Bucket: config.storage.transcriptBucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ContentLength: contentLength,
      }),
    );
    return key;
  } catch (error) {
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

async function fetchObjectAsString(key: string): Promise<string | undefined> {
  if (config.mock.enabled) {
    const mockObject = getMockStore().objectsByKey.get(key);
    return mockObject;
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
    );

    const body = response.Body;
    if (!body) return undefined;

    return await body.transformToString();
  } catch (error) {
    if (isMissingKeyError(error)) {
      return undefined;
    }
    console.error("Failed to fetch object from S3", error);
  }

  return undefined;
}

export async function fetchJsonFromS3<T>(key: string): Promise<T | undefined> {
  const raw = await fetchObjectAsString(key);
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
