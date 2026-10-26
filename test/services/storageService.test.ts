/** @jest-environment node */
import { afterEach, describe, expect, jest, test } from "@jest/globals";

jest.mock("dotenv", () => ({ config: () => ({ parsed: {} }) }));

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MOCK_STORAGE_UPLOAD_PATH } from "../../src/constants";
import { resetMockStore } from "../../src/repositories/mockStore";
import { config } from "../../src/services/configService";
import {
  fetchObjectBytesFromS3,
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
  test("checkpoint immutability preserves the first mock object while ordinary writes still replace it", async () => {
    Object.defineProperty(config.mock, "enabled", {
      get: () => true,
      configurable: true,
    });
    await uploadObjectToS3("checkpoint", "original", "text/plain", {
      immutable: true,
    });
    await expect(
      uploadObjectToS3("checkpoint", "replacement", "text/plain", {
        immutable: true,
      }),
    ).resolves.toBeUndefined();
    expect(
      Buffer.from((await fetchObjectBytesFromS3("checkpoint"))!).toString(),
    ).toBe("original");
    await uploadObjectToS3("checkpoint", "ordinary", "text/plain");
    expect(
      Buffer.from((await fetchObjectBytesFromS3("checkpoint"))!).toString(),
    ).toBe("ordinary");
  });
  test("checkpoint upload uses existing SDK immutable condition and actual AbortSignal", async () => {
    Object.defineProperty(config.mock, "enabled", {
      get: () => false,
      configurable: true,
    });
    Object.defineProperty(config.storage, "transcriptBucket", {
      get: () => "test-bucket",
      configurable: true,
    });
    const send = jest
      .spyOn(S3Client.prototype, "send")
      .mockImplementation(async () => ({}));
    const controller = new AbortController();
    await expect(
      uploadObjectToS3("checkpoint", Buffer.from("generated"), "audio/ogg", {
        immutable: true,
        signal: controller.signal,
      }),
    ).resolves.toBe("checkpoint");
    expect(send).toHaveBeenCalledWith(expect.any(PutObjectCommand), {
      abortSignal: controller.signal,
    });
    expect(send.mock.calls[0][0].input).toMatchObject({ IfNoneMatch: "*" });
    controller.abort();
    await expect(
      uploadObjectToS3("checkpoint2", "generated", "text/plain", {
        signal: controller.signal,
      }),
    ).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
  });
  test("storage read passes actual signal and ordinary upload failures still return undefined", async () => {
    Object.defineProperty(config.mock, "enabled", {
      get: () => false,
      configurable: true,
    });
    Object.defineProperty(config.storage, "transcriptBucket", {
      get: () => "test-bucket",
      configurable: true,
    });
    const send = jest
      .spyOn(S3Client.prototype, "send")
      .mockImplementation(async () => ({
        Body: { transformToByteArray: async () => Buffer.from("generated") },
      }));
    const signal = new AbortController().signal;
    expect(await fetchObjectBytesFromS3("checkpoint", signal)).toEqual(
      Buffer.from("generated"),
    );
    expect(send).toHaveBeenCalledWith(expect.any(GetObjectCommand), {
      abortSignal: signal,
    });
    send.mockImplementation(async () => {
      throw new Error("synthetic unavailable");
    });
    jest.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      uploadObjectToS3("ordinary", "generated", "text/plain"),
    ).resolves.toBeUndefined();
    await expect(fetchObjectBytesFromS3("checkpoint")).rejects.toThrow(
      "Failed to read checkpoint",
    );
  });
  test("download retains a held SDK body after abort and never writes its late bytes", async () => {
    Object.defineProperty(config.mock, "enabled", {
      get: () => false,
      configurable: true,
    });
    Object.defineProperty(config.storage, "transcriptBucket", {
      get: () => "synthetic-bucket",
      configurable: true,
    });
    let releaseBody!: (value: Uint8Array) => void;
    const body = new Promise<Uint8Array>((resolve) => {
      releaseBody = resolve;
    });
    const readBody = jest.fn(() => body);
    const send = jest
      .spyOn(S3Client.prototype, "send")
      .mockImplementation(async () => ({
        Body: { transformToByteArray: readBody },
      }));
    const write = jest.spyOn(fs, "writeFile").mockResolvedValue();
    const controller = new AbortController();
    let settled = false;
    const download = downloadObjectToFile(
      "synthetic-key",
      "synthetic-unused-path",
      controller.signal,
    );
    const observed = download.finally(() => {
      settled = true;
    });
    const rejected = expect(observed).rejects.toThrow("synthetic stop");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(readBody).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.any(GetObjectCommand), {
      abortSignal: controller.signal,
    });
    controller.abort(new Error("synthetic stop"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    releaseBody(Buffer.from("synthetic late body"));
    await rejected;
    expect(write).not.toHaveBeenCalled();
  });
});
