import { beforeEach, describe, expect, it } from "@jest/globals";
import { getFeedbackRepository } from "../../src/repositories/feedbackRepository";
import { resetMockStore } from "../../src/repositories/mockStore";
import { listFeedbackEntries } from "../../src/services/adminFeedbackService";

describe("listFeedbackEntries", () => {
  beforeEach(() => {
    resetMockStore();
  });

  it("filters by target type and rating", async () => {
    const repo = getFeedbackRepository();
    await repo.write({
      pk: "TARGET#meeting_summary#voice-1#2025-01-01T00:00:00.000Z",
      sk: "USER#u1",
      type: "feedback",
      targetType: "meeting_summary",
      targetId: "voice-1#2025-01-01T00:00:00.000Z",
      guildId: "g1",
      rating: "up",
      source: "web",
      createdAt: "2025-01-02T00:00:00.000Z",
      updatedAt: "2025-01-02T00:00:00.000Z",
      userId: "u1",
    });
    await repo.write({
      pk: "TARGET#ask_answer#conv-1#msg-1",
      sk: "USER#u2",
      type: "feedback",
      targetType: "ask_answer",
      targetId: "conv-1#msg-1",
      guildId: "g1",
      conversationId: "conv-1",
      messageId: "msg-1",
      rating: "down",
      source: "discord",
      createdAt: "2025-01-03T00:00:00.000Z",
      updatedAt: "2025-01-03T00:00:00.000Z",
      userId: "u2",
    });

    const result = await listFeedbackEntries({
      targetType: "ask_answer",
      rating: "down",
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.targetType).toBe("ask_answer");
    expect(result.items[0]?.rating).toBe("down");
  });

  it("paginates with a cursor", async () => {
    const repo = getFeedbackRepository();
    await repo.write({
      pk: "TARGET#ask_answer#conv-1#msg-2",
      sk: "USER#u1",
      type: "feedback",
      targetType: "ask_answer",
      targetId: "conv-1#msg-2",
      guildId: "g1",
      conversationId: "conv-1",
      messageId: "msg-2",
      rating: "up",
      source: "web",
      createdAt: "2025-01-04T00:00:00.000Z",
      updatedAt: "2025-01-04T00:00:00.000Z",
      userId: "u1",
    });
    await repo.write({
      pk: "TARGET#ask_answer#conv-1#msg-1",
      sk: "USER#u2",
      type: "feedback",
      targetType: "ask_answer",
      targetId: "conv-1#msg-1",
      guildId: "g1",
      conversationId: "conv-1",
      messageId: "msg-1",
      rating: "down",
      source: "web",
      createdAt: "2025-01-03T00:00:00.000Z",
      updatedAt: "2025-01-03T00:00:00.000Z",
      userId: "u2",
    });

    const firstPage = await listFeedbackEntries({
      targetType: "ask_answer",
      limit: 1,
    });

    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.items[0]?.messageId).toBe("msg-2");
    expect(firstPage.nextCursor).toBe("2025-01-04T00:00:00.000Z");

    const secondPage = await listFeedbackEntries({
      targetType: "ask_answer",
      limit: 1,
      cursor: firstPage.nextCursor,
    });

    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.items[0]?.messageId).toBe("msg-1");
  });

  it("excludes the cursor timestamp when paginating", async () => {
    const repo = getFeedbackRepository();
    await repo.write({
      pk: "TARGET#ask_answer#conv-1#msg-2",
      sk: "USER#u1",
      type: "feedback",
      targetType: "ask_answer",
      targetId: "conv-1#msg-2",
      guildId: "g1",
      conversationId: "conv-1",
      messageId: "msg-2",
      rating: "up",
      source: "web",
      createdAt: "2025-01-04T00:00:00.000Z",
      updatedAt: "2025-01-04T00:00:00.000Z",
      userId: "u1",
    });
    await repo.write({
      pk: "TARGET#ask_answer#conv-1#msg-1",
      sk: "USER#u2",
      type: "feedback",
      targetType: "ask_answer",
      targetId: "conv-1#msg-1",
      guildId: "g1",
      conversationId: "conv-1",
      messageId: "msg-1",
      rating: "down",
      source: "web",
      createdAt: "2025-01-03T00:00:00.000Z",
      updatedAt: "2025-01-03T00:00:00.000Z",
      userId: "u2",
    });

    const page = await listFeedbackEntries({
      targetType: "ask_answer",
      limit: 2,
      cursor: "2025-01-04T00:00:00.000Z",
    });

    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.messageId).toBe("msg-1");
  });

  it("fills a page when filters exclude early items", async () => {
    const repo = getFeedbackRepository();
    const records: Array<{
      messageId: string;
      createdAt: string;
      rating: "up" | "down";
    }> = [
      {
        messageId: "msg-6",
        createdAt: "2025-01-06T00:00:00.000Z",
        rating: "up",
      },
      {
        messageId: "msg-5",
        createdAt: "2025-01-05T00:00:00.000Z",
        rating: "down",
      },
      {
        messageId: "msg-4",
        createdAt: "2025-01-04T00:00:00.000Z",
        rating: "down",
      },
      {
        messageId: "msg-3",
        createdAt: "2025-01-03T00:00:00.000Z",
        rating: "down",
      },
      {
        messageId: "msg-2",
        createdAt: "2025-01-02T00:00:00.000Z",
        rating: "up",
      },
      {
        messageId: "msg-1",
        createdAt: "2025-01-01T00:00:00.000Z",
        rating: "up",
      },
    ];

    for (const record of records) {
      await repo.write({
        pk: `TARGET#ask_answer#conv-1#${record.messageId}`,
        sk: "USER#u1",
        type: "feedback",
        targetType: "ask_answer",
        targetId: `conv-1#${record.messageId}`,
        guildId: "g1",
        conversationId: "conv-1",
        messageId: record.messageId,
        rating: record.rating,
        source: "web",
        createdAt: record.createdAt,
        updatedAt: record.createdAt,
        userId: "u1",
      });
    }

    const page = await listFeedbackEntries({
      targetType: "ask_answer",
      rating: "up",
      limit: 2,
    });

    expect(page.items).toHaveLength(2);
    expect(page.items[0]?.messageId).toBe("msg-6");
    expect(page.items[1]?.messageId).toBe("msg-2");
    expect(page.nextCursor).toBe("2025-01-02T00:00:00.000Z");
  });
});
