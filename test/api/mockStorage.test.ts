/** @jest-environment node */

import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { registerMockStorageRoutes } from "../../src/api/mockStorage";
import { MOCK_STORAGE_UPLOAD_PATH } from "../../src/constants";
import { getMockStore, resetMockStore } from "../../src/repositories/mockStore";
import { config } from "../../src/services/configService";

const originalMockEnabled = Object.getOwnPropertyDescriptor(
  config.mock,
  "enabled",
);

const createServer = () => {
  const app = express();
  registerMockStorageRoutes(app);
  const server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
};

const closeServer = async (server: http.Server) =>
  new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

const fieldPart = (boundary: string, name: string, value: string) =>
  Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
  );

const filePart = (
  boundary: string,
  filename: string,
  contentType: string,
  body: Buffer,
) =>
  Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
    ),
    body,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

const buildMultipartUpload = (options: {
  boundary: string;
  key: string;
  contentType: string;
  maxBytes: number;
  file: Buffer;
}) =>
  Buffer.concat([
    fieldPart(options.boundary, "key", options.key),
    fieldPart(options.boundary, "Content-Type", options.contentType),
    fieldPart(
      options.boundary,
      "x-chronote-max-bytes",
      String(options.maxBytes),
    ),
    filePart(options.boundary, "source.wav", options.contentType, options.file),
  ]);

const postMultipart = async (url: string, boundary: string, body: Buffer) =>
  new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
    const req = http.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": String(body.byteLength),
        },
      },
      (res) => {
        let responseBody = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          responseBody += chunk;
        });
        res.on("end", () => {
          resolve({ statusCode: res.statusCode ?? 0, body: responseBody });
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });

describe("mock storage upload route", () => {
  beforeEach(() => {
    resetMockStore();
    Object.defineProperty(config.mock, "enabled", {
      get: () => true,
      configurable: true,
    });
  });

  afterEach(() => {
    if (originalMockEnabled) {
      Object.defineProperty(config.mock, "enabled", originalMockEnabled);
    }
  });

  test("stores multipart file bytes by upload key", async () => {
    const { server, baseUrl } = createServer();
    const key = "personal-media-uploads/user-1/upload-1/source.wav";
    const file = Buffer.from([0, 1, 2, 255, 16, 32]);

    try {
      const boundary = "chronote-test-boundary";
      const response = await postMultipart(
        `${baseUrl}${MOCK_STORAGE_UPLOAD_PATH}`,
        boundary,
        buildMultipartUpload({
          boundary,
          key,
          contentType: "audio/wav",
          maxBytes: file.byteLength,
          file,
        }),
      );

      expect(response.statusCode).toBe(204);
      const stored = getMockStore().objectsByKey.get(key);
      expect(Buffer.isBuffer(stored)).toBe(true);
      expect(stored).toEqual(file);
    } finally {
      await closeServer(server);
    }
  });

  test("rejects uploads larger than the signed field limit", async () => {
    const { server, baseUrl } = createServer();

    try {
      const boundary = "chronote-test-boundary";
      const response = await postMultipart(
        `${baseUrl}${MOCK_STORAGE_UPLOAD_PATH}`,
        boundary,
        buildMultipartUpload({
          boundary,
          key: "personal-media-uploads/user-1/upload-1/source.wav",
          contentType: "audio/wav",
          maxBytes: 1,
          file: Buffer.from([1, 2]),
        }),
      );

      expect(response.statusCode).toBe(413);
      expect(JSON.parse(response.body)).toEqual({
        error: "Upload is too large.",
      });
    } finally {
      await closeServer(server);
    }
  });
});
