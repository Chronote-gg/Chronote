import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  jest,
} from "@jest/globals";
import {
  submitContactFeedback,
  listContactFeedbackEntries,
  verifyRecaptcha,
} from "../../src/services/contactFeedbackService";
import { getMockStore, resetMockStore } from "../../src/repositories/mockStore";
import { CONTACT_FEEDBACK_MAX_MESSAGE_LENGTH } from "../../src/constants";

describe("contactFeedbackService", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2025-01-01T00:00:00.000Z"));
    resetMockStore();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test("submitContactFeedback creates a record in the mock store", async () => {
    const result = await submitContactFeedback({
      source: "web",
      message: "Great tool, love the transcription feature!",
      contactEmail: "user@example.com",
    });

    expect(result.feedbackId).toBeDefined();
    expect(result.source).toBe("web");
    expect(result.message).toBe("Great tool, love the transcription feature!");
    expect(result.contactEmail).toBe("user@example.com");
    expect(result.createdAt).toBe("2025-01-01T00:00:00.000Z");

    const store = getMockStore();
    expect(store.contactFeedback).toHaveLength(3); // 2 seed entries + 1 new
  });

  test("submitContactFeedback trims whitespace from message and contact fields", async () => {
    const result = await submitContactFeedback({
      source: "discord",
      message: "  Some feedback  ",
      contactEmail: "  user@example.com  ",
      contactDiscord: "  username#1234  ",
    });

    expect(result.message).toBe("Some feedback");
    expect(result.contactEmail).toBe("user@example.com");
    expect(result.contactDiscord).toBe("username#1234");
  });

  test("submitContactFeedback rejects empty messages", async () => {
    await expect(
      submitContactFeedback({ source: "web", message: "   " }),
    ).rejects.toThrow("Feedback message is required");
  });

  test("submitContactFeedback rejects messages exceeding max length", async () => {
    const longMessage = "x".repeat(CONTACT_FEEDBACK_MAX_MESSAGE_LENGTH + 1);
    await expect(
      submitContactFeedback({ source: "web", message: longMessage }),
    ).rejects.toThrow("exceeds maximum length");
  });

  test("submitContactFeedback stores image S3 keys when provided", async () => {
    const result = await submitContactFeedback({
      source: "web",
      message: "Bug with the UI",
      imageS3Keys: ["contact-feedback/img1.png", "contact-feedback/img2.png"],
    });

    expect(result.imageS3Keys).toEqual([
      "contact-feedback/img1.png",
      "contact-feedback/img2.png",
    ]);
  });

  test("submitContactFeedback omits imageS3Keys when empty array", async () => {
    const result = await submitContactFeedback({
      source: "web",
      message: "No images",
      imageS3Keys: [],
    });

    expect(result.imageS3Keys).toBeUndefined();
  });

  test("submitContactFeedback sets userId and display info from Discord", async () => {
    const result = await submitContactFeedback({
      source: "discord",
      message: "Feedback from Discord",
      userId: "user-123",
      userTag: "cooluser",
      displayName: "Cool User",
      guildId: "guild-456",
    });

    expect(result.userId).toBe("user-123");
    expect(result.userTag).toBe("cooluser");
    expect(result.displayName).toBe("Cool User");
    expect(result.guildId).toBe("guild-456");
  });

  test("listContactFeedbackEntries returns records sorted by newest first", async () => {
    const store = getMockStore();
    // Clear seed data
    store.contactFeedback.length = 0;

    await submitContactFeedback({ source: "web", message: "First" });
    jest.setSystemTime(new Date("2025-01-02T00:00:00.000Z"));
    await submitContactFeedback({ source: "web", message: "Second" });

    const entries = await listContactFeedbackEntries({});
    expect(entries).toHaveLength(2);
    expect(entries[0].message).toBe("Second");
    expect(entries[1].message).toBe("First");
  });

  test("listContactFeedbackEntries respects limit", async () => {
    const store = getMockStore();
    store.contactFeedback.length = 0;

    await submitContactFeedback({ source: "web", message: "A" });
    jest.setSystemTime(new Date("2025-01-02T00:00:00.000Z"));
    await submitContactFeedback({ source: "web", message: "B" });
    jest.setSystemTime(new Date("2025-01-03T00:00:00.000Z"));
    await submitContactFeedback({ source: "web", message: "C" });

    const entries = await listContactFeedbackEntries({ limit: 2 });
    expect(entries).toHaveLength(2);
  });

  test("verifyRecaptcha returns 1 when no secret key is configured", async () => {
    const score = await verifyRecaptcha("some-token");
    expect(score).toBe(1);
  });
});
