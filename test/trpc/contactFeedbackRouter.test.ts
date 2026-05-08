/** @jest-environment node */

import { beforeEach, describe, expect, jest, test } from "@jest/globals";
import type { Request, Response } from "express";
import { appRouter } from "../../src/trpc/router";
import {
  CONTACT_FEEDBACK_MAX_IMAGE_BYTES,
  CONTACT_FEEDBACK_UPLOAD_URL_EXPIRY_SECONDS,
} from "../../src/constants";
import { getSignedUploadPost } from "../../src/services/storageService";
import { submitContactFeedback } from "../../src/services/contactFeedbackService";
import { notifyContactFeedbackFromWeb } from "../../src/services/contactFeedbackNotificationService";

jest.mock("../../src/services/storageService", () => ({
  fetchJsonFromS3: jest.fn(),
  getSignedObjectUrl: jest.fn(),
  getSignedUploadPost: jest.fn(),
  uploadObjectToS3: jest.fn(),
}));

jest.mock("../../src/services/contactFeedbackService", () => ({
  listContactFeedbackEntries: jest.fn(),
  submitContactFeedback: jest.fn(),
}));

jest.mock("../../src/services/contactFeedbackNotificationService", () => ({
  notifyContactFeedbackFromWeb: jest.fn(async () => undefined),
}));

const mockedGetSignedUploadPost = jest.mocked(getSignedUploadPost);
const mockedSubmitContactFeedback = jest.mocked(submitContactFeedback);
const mockedNotifyContactFeedback = jest.mocked(notifyContactFeedbackFromWeb);

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
    mockedSubmitContactFeedback.mockResolvedValue({
      feedbackId: "feedback-1",
      type: "contact_feedback",
      source: "web",
      message: "Feedback",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    mockedNotifyContactFeedback.mockResolvedValue(undefined);
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
      1024,
      CONTACT_FEEDBACK_UPLOAD_URL_EXPIRY_SECONDS,
    );
    expect(result.uploadToken).toEqual(expect.any(String));
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

  test("accepts uploaded image keys only with a matching upload token", async () => {
    const upload = await buildCaller().contactFeedback.getUploadUrl({
      contentType: "image/png",
      fileSize: 1024,
    });

    await buildCaller().contactFeedback.submit({
      message: "Feedback",
      imageS3Uploads: [{ key: upload.key, uploadToken: upload.uploadToken }],
    });

    expect(mockedSubmitContactFeedback).toHaveBeenCalledWith(
      expect.objectContaining({ imageS3Keys: [upload.key] }),
    );
  });

  test("drops uploaded image keys with invalid upload tokens", async () => {
    await buildCaller().contactFeedback.submit({
      message: "Feedback",
      imageS3Uploads: [
        { key: "contact-feedback/stolen.png", uploadToken: "invalid-token" },
      ],
    });

    expect(mockedSubmitContactFeedback).toHaveBeenCalledWith(
      expect.objectContaining({ imageS3Keys: [] }),
    );
  });
});
