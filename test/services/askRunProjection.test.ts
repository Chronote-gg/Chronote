import {
  persistCompletedAskRun,
  getSharedConversationWithMessages,
  setAskConversationVisibility,
} from "../../src/services/askConversationService";
import { getMockStore, resetMockStore } from "../../src/repositories/mockStore";
import { getAskConversationRepository } from "../../src/repositories/askConversationRepository";

jest.mock("../../src/services/askService", () => ({
  answerQuestionService: jest.fn(),
}));

describe("completed Ask run projection", () => {
  beforeEach(() => resetMockStore());
  it("reprojects a completed send once with stable message identities and no private history", async () => {
    const store = getMockStore();
    const input = {
      userId: store.user.id,
      guildId: store.userGuilds[0].id,
      conversationId: "run-conversation",
      requestId: "request-1",
      question: "Which launch date?",
      createdAt: "2026-11-17T00:00:00.000Z",
      completedAt: "2026-11-17T00:00:02.000Z",
      result: {
        answer: "Friday.",
        citations: [],
        sourceMeetingIds: ["voice#2026-10-01T00:00:00.000Z"],
      },
    };
    const a = await persistCompletedAskRun(input);
    const b = await persistCompletedAskRun(input);
    expect(a.messages.map((m) => m.id)).toEqual(b.messages.map((m) => m.id));
    const saved = await getAskConversationRepository().listMessages(
      input.userId,
      input.guildId,
      input.conversationId,
    );
    expect(saved).toHaveLength(2);
    expect(saved.map((m) => m.text)).toEqual(["Which launch date?", "Friday."]);
    expect(saved.every((m) => !("history" in m) && !("provenance" in m))).toBe(
      true,
    );
  });
  it("updates the shared conversation list after a completed durable answer", async () => {
    const store = getMockStore();
    const userId = store.user.id,
      guildId = store.userGuilds[0].id;
    const repo = getAskConversationRepository();
    const shared = (await repo.listConversations(userId, guildId)).find(
      (item) => item.visibility === "server",
    );
    expect(shared).toBeDefined();
    await persistCompletedAskRun({
      userId,
      guildId,
      conversationId: shared!.id,
      requestId: "shared-answer",
      question: "Follow up",
      createdAt: "2026-11-17T10:00:00.000Z",
      completedAt: "2026-11-17T10:00:02.000Z",
      result: { answer: "Updated shared answer" },
    });
    expect(
      (await repo.getSharedConversation(guildId, shared!.id))?.summary,
    ).toBe("Updated shared answer");
  });
  it("a delayed completed-share write cannot recreate a revoked share", async () => {
    const store = getMockStore(),
      repo = getAskConversationRepository();
    const userId = store.user.id,
      guildId = store.userGuilds[0].id;
    const shared = (await repo.listConversations(userId, guildId)).find(
      (item) => item.visibility === "server",
    )!;
    const oldShare = {
      pk: `GUILD#${guildId}`,
      sk: `SHARE#${shared.id}`,
      type: "share" as const,
      conversationId: shared.id,
      guildId,
      ownerUserId: userId,
      title: shared.title,
      summary: shared.summary,
      createdAt: shared.createdAt,
      updatedAt: shared.updatedAt,
      sharedAt: shared.sharedAt,
    };
    await setAskConversationVisibility({
      userId,
      guildId,
      conversationId: shared.id,
      visibility: "private",
    });
    await repo.writeCompletedShare(oldShare);
    expect(
      await repo.getSharedConversation(guildId, shared.id),
    ).toBeUndefined();
    await repo.writeSharedConversation(oldShare);
    expect(
      await getSharedConversationWithMessages(guildId, shared.id),
    ).toBeUndefined();
  });
  it("completion only updates answer fields even when a privacy edit races a newer completion timestamp", async () => {
    const store = getMockStore(),
      repo = getAskConversationRepository();
    const userId = store.user.id,
      guildId = store.userGuilds[0].id;
    const shared = (await repo.listConversations(userId, guildId)).find(
      (item) => item.visibility === "server",
    )!;
    const stale = {
      ...shared,
      summary: "Completed answer",
      updatedAt: "9999-01-01T00:00:00.000Z",
    };
    await setAskConversationVisibility({
      userId,
      guildId,
      conversationId: shared.id,
      visibility: "private",
    });
    await repo.writeCompletedConversation(userId, guildId, stale);
    expect(
      (await repo.getConversation(userId, guildId, shared.id))?.visibility,
    ).toBe("private");
  });
  it("does not replace a newer conversation summary when an older run is reprojected", async () => {
    const store = getMockStore();
    const base = {
      userId: store.user.id,
      guildId: store.userGuilds[0].id,
      conversationId: "ordered",
      question: "Question",
      createdAt: "2026-11-17T00:00:00.000Z",
    };
    await persistCompletedAskRun({
      ...base,
      requestId: "new",
      completedAt: "2026-11-17T00:00:04.000Z",
      result: { answer: "New answer" },
    });
    await persistCompletedAskRun({
      ...base,
      requestId: "old",
      completedAt: "2026-11-17T00:00:02.000Z",
      result: { answer: "Old answer" },
    });
    expect(
      (
        await getAskConversationRepository().getConversation(
          base.userId,
          base.guildId,
          base.conversationId,
        )
      )?.summary,
    ).toBe("New answer");
  });
});
