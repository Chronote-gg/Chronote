import {
  askWithConversation,
  getAskConversationWithMessages,
  listAskConversations,
  listSharedAskConversations,
  renameAskConversation,
  setAskConversationArchived,
  setAskConversationVisibility,
} from "../../src/services/askConversationService";
import { getMockStore, resetMockStore } from "../../src/repositories/mockStore";
import { answerQuestionService } from "../../src/services/askService";

jest.mock("../../src/services/askService", () => ({
  answerQuestionService: jest.fn(),
}));

const mockedAnswerQuestionService =
  answerQuestionService as jest.MockedFunction<typeof answerQuestionService>;

describe("askConversationService archive", () => {
  beforeEach(() => {
    resetMockStore();
  });

  it("archives a conversation and hides it from shared list", async () => {
    const store = getMockStore();
    const guildId = store.userGuilds[0].id;
    const userId = store.user.id;
    const conversation = store.askConversationsByKey
      .get(`USER#${userId}#GUILD#${guildId}`)
      ?.find((conv) => conv.visibility === "server");

    expect(conversation).toBeDefined();
    if (!conversation) return;

    const updated = await setAskConversationArchived({
      userId,
      guildId,
      conversationId: conversation.id,
      archived: true,
    });
    expect(updated?.archivedAt).toBeTruthy();

    const mine = await listAskConversations(userId, guildId);
    const archived = mine.find((conv) => conv.id === conversation.id);
    expect(archived?.archivedAt).toBeTruthy();

    const shared = await listSharedAskConversations(guildId, "viewer-2");
    expect(shared.some((conv) => conv.conversationId === conversation.id)).toBe(
      false,
    );
  });
});

describe("askConversationService flow", () => {
  beforeEach(() => {
    resetMockStore();
    mockedAnswerQuestionService.mockResolvedValue({
      answer: "Answer from Chronote.",
      sourceMeetingIds: ["voice-1#2025-01-01T00:00:00.000Z"],
    });
  });

  it("creates a new conversation and stores messages", async () => {
    const store = getMockStore();
    const guildId = store.userGuilds[0].id;
    const userId = store.user.id;
    const result = await askWithConversation({
      userId,
      guildId,
      question: "What did we decide?",
      conversationId: "conv-new",
      channelId: "voice-1",
      contextMeetingIds: ["voice-1#2025-01-01T00:00:00.000Z"],
    });

    expect(result.conversationId).toBe("conv-new");
    expect(result.answer).toBe("Answer from Chronote.");
    expect(mockedAnswerQuestionService).toHaveBeenLastCalledWith(
      expect.objectContaining({
        contextMeetingIds: ["voice-1#2025-01-01T00:00:00.000Z"],
      }),
    );
    const conversation = await getAskConversationWithMessages(
      userId,
      guildId,
      result.conversationId,
    );
    expect(conversation?.conversation.title).toContain("What did we decide?");
    expect(conversation?.messages).toHaveLength(2);
    expect(conversation?.messages[0].role).toBe("user");
    expect(conversation?.messages[1].role).toBe("chronote");
  });

  it("keeps non-default titles when answering in an existing conversation", async () => {
    const store = getMockStore();
    const guildId = store.userGuilds[0].id;
    const userId = store.user.id;
    const existing = store.askConversationsByKey
      .get(`USER#${userId}#GUILD#${guildId}`)
      ?.find((conv) => conv.title && conv.title !== "");
    expect(existing).toBeDefined();
    if (!existing) return;

    const result = await askWithConversation({
      userId,
      guildId,
      question: "Follow-up question",
      conversationId: existing.id,
      channelId: "voice-1",
    });

    expect(result.conversation.title).toBe(existing.title);
    expect(result.conversation.summary).toContain("Answer from Chronote");
  });

  it("updates shared visibility and share records", async () => {
    const store = getMockStore();
    const guildId = store.userGuilds[0].id;
    const userId = store.user.id;
    const privateConversation = store.askConversationsByKey
      .get(`USER#${userId}#GUILD#${guildId}`)
      ?.find((conv) => !conv.visibility || conv.visibility === "private");
    expect(privateConversation).toBeDefined();
    if (!privateConversation) return;

    const shared = await setAskConversationVisibility({
      userId,
      guildId,
      conversationId: privateConversation.id,
      visibility: "public",
      sharedByTag: "MockUser",
    });
    expect(shared?.visibility).toBe("public");
    const sharedList = await listSharedAskConversations(guildId, "viewer");
    expect(
      sharedList.some((conv) => conv.conversationId === privateConversation.id),
    ).toBe(true);

    const unshared = await setAskConversationVisibility({
      userId,
      guildId,
      conversationId: privateConversation.id,
      visibility: "private",
    });
    expect(unshared?.visibility).toBe("private");
    const sharedAfter = await listSharedAskConversations(guildId, "viewer");
    expect(
      sharedAfter.some(
        (conv) => conv.conversationId === privateConversation.id,
      ),
    ).toBe(false);
  });

  it("propagates rename to shared records", async () => {
    const store = getMockStore();
    const guildId = store.userGuilds[0].id;
    const userId = store.user.id;
    const sharedConversation = store.askConversationsByKey
      .get(`USER#${userId}#GUILD#${guildId}`)
      ?.find((conv) => conv.visibility === "server");
    expect(sharedConversation).toBeDefined();
    if (!sharedConversation) return;

    const renamed = await renameAskConversation(
      userId,
      guildId,
      sharedConversation.id,
      "Renamed title",
    );
    expect(renamed?.title).toBe("Renamed title");

    const sharedList = await listSharedAskConversations(guildId, "viewer");
    const sharedRecord = sharedList.find(
      (conv) => conv.conversationId === sharedConversation.id,
    );
    expect(sharedRecord?.title).toBe("Renamed title");
  });
});
