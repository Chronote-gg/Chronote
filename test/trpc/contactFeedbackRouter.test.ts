/** @jest-environment node */

import { beforeEach, describe, expect, jest, test } from "@jest/globals";
import type { Request, Response } from "express";
import { appRouter } from "../../src/trpc/router";
import {
  CONTACT_FEEDBACK_MAX_IMAGE_BYTES,
  CONTACT_FEEDBACK_UPLOAD_URL_EXPIRY_SECONDS,
} from "../../src/constants";
import { getSignedUploadPost } from "../../src/services/storageService";

jest.mock("../../src/services/storageService", () => ({
  fetchJsonFromS3: jest.fn(),
  getSignedObjectUrl: jest.fn(),
  getSignedUploadPost: jest.fn(),
  uploadObjectToS3: jest.fn(),
}));

const mockedGetSignedUploadPost = jest.mocked(getSignedUploadPost);

const buildCaller = () =>
  appRouter.createCaller({
    req: {
      ip: "127.0.0.1",
      socket: { remoteAddress: "127.0.0.1" },
      session: {},
    } as Request,
    res: {} as Response,
    user: null,
  });

describe("contactFeedback router uploads", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockedGetSignedUploadPost.mockResolvedValue({
      url: "https://s3.example.com/upload",
      fields: {
        key: "contact-feedback/test.png",
        "Content-Type": "image/png",
      },
    });
  });

  test("returns presigned POST fields for an allowed upload size", async () => {
    const result = await buildCaller().contactFeedback.getUploadUrl({
      contentType: "image/png",
      fileSize: 1024,
    });

    expect(result).toMatchObject({
      url: "https://s3.example.com/upload",
      key: expect.stringMatching(/^contact-feedback\/.+\.png$/),
      fields: {
        key: "contact-feedback/test.png",
        "Content-Type": "image/png",
      },
    });
    expect(mockedGetSignedUploadPost).toHaveBeenCalledWith(
      expect.stringMatching(/^contact-feedback\/.+\.png$/),
      "image/png",
      CONTACT_FEEDBACK_MAX_IMAGE_BYTES,
      CONTACT_FEEDBACK_UPLOAD_URL_EXPIRY_SECONDS,
    );
  });

  test("rejects upload URL requests above the image size limit", async () => {
    await expect(
      buildCaller().contactFeedback.getUploadUrl({
        contentType: "image/png",
        fileSize: CONTACT_FEEDBACK_MAX_IMAGE_BYTES + 1,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(mockedGetSignedUploadPost).not.toHaveBeenCalled();
  });
});
