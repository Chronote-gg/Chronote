/** @jest-environment node */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { config } from "../../src/services/configService";
import { getSignedUploadPost } from "../../src/services/storageService";

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

describe("storageService upload POST signing", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    if (originalTranscriptBucket) {
      Object.defineProperty(
        config.storage,
        "transcriptBucket",
        originalTranscriptBucket,
      );
    }
    mockedCreatePresignedPost.mockClear();
  });

  test("adds content type and content length constraints to presigned POST policy", async () => {
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
});
