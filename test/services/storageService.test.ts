/** @jest-environment node */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MOCK_STORAGE_UPLOAD_PATH } from "../../src/constants";
import { resetMockStore } from "../../src/repositories/mockStore";
import { config } from "../../src/services/configService";
import {
  downloadObjectToFile,
  getSignedUploadPost,
  getStoredObjectMetadata,
  uploadObjectToS3,
} from "../../src/services/storageService";

jest.mock("@aws-sdk/s3-presigned-post", () => ({
  createPresignedPost: jest.fn(async () => ({
    url: "https://s3.example.com/upload",
    fields: { key: "contact-feedback/test.png" },
  })),
}));

const mockedCreatePresignedPost = jest.mocked(createPresignedPost);
const originalTranscriptBucket = Object.getOwnPropertyDescriptor(
  config.storage,
  "transcriptBucket",
);
const originalMockEnabled = Object.getOwnPropertyDescriptor(
  config.mock,
  "enabled",
);

describe("storageService upload POST signing", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    resetMockStore();
    if (originalTranscriptBucket) {
      Object.defineProperty(
        config.storage,
        "transcriptBucket",
        originalTranscriptBucket,
      );
    }
    if (originalMockEnabled) {
      Object.defineProperty(config.mock, "enabled", originalMockEnabled);
    }
    mockedCreatePresignedPost.mockClear();
  });

  test("adds content type and content length constraints to presigned POST policy", async () => {
    Object.defineProperty(config.mock, "enabled", {
      get: () => false,
      configurable: true,
    });
    Object.defineProperty(config.storage, "transcriptBucket", {
      get: () => "test-bucket",
      configurable: true,
    });

    const result = await getSignedUploadPost(
      "contact-feedback/test.png",
      "image/png",
      20,
      300,
    );

    expect(result).toEqual({
      url: "https://s3.example.com/upload",
      fields: { key: "contact-feedback/test.png" },
    });
    expect(mockedCreatePresignedPost).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        Bucket: "test-bucket",
        Key: "contact-feedback/test.png",
        Conditions: [
          ["content-length-range", 1, 20],
          ["eq", "$Content-Type", "image/png"],
        ],
        Fields: { "Content-Type": "image/png" },
        Expires: 300,
      }),
    );
  });

  test("returns a local upload POST in mock mode without S3", async () => {
    Object.defineProperty(config.mock, "enabled", {
      get: () => true,
      configurable: true,
    });
    Object.defineProperty(config.storage, "transcriptBucket", {
      get: () => "local-transcripts",
      configurable: true,
    });

    const result = await getSignedUploadPost(
      "personal-media-uploads/user-1/upload-1/source.wav",
      "audio/wav",
      1234,
      300,
    );

    expect(result).toEqual({
      url: `${config.mcp.publicBaseUrl}${MOCK_STORAGE_UPLOAD_PATH}`,
      fields: {
        key: "personal-media-uploads/user-1/upload-1/source.wav",
        "Content-Type": "audio/wav",
        "x-chronote-max-bytes": "1234",
      },
    });
    expect(mockedCreatePresignedPost).not.toHaveBeenCalled();
  });

  test("stores and downloads binary objects in mock mode without S3", async () => {
    Object.defineProperty(config.mock, "enabled", {
      get: () => true,
      configurable: true,
    });
    Object.defineProperty(config.storage, "transcriptBucket", {
      get: () => "local-transcripts",
      configurable: true,
    });
    const key = "personal-media-uploads/user-1/upload-1/source.wav";
    const body = Buffer.from([0, 1, 2, 255, 16, 32]);

    await expect(uploadObjectToS3(key, body, "audio/wav")).resolves.toBe(key);
    await expect(getStoredObjectMetadata(key)).resolves.toEqual({
      contentLength: body.byteLength,
    });

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "chronote-test-"));
    const destination = path.join(tempDir, "source.wav");
    try {
      await expect(downloadObjectToFile(key, destination)).resolves.toBe(true);
      await expect(fs.readFile(destination)).resolves.toEqual(body);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
