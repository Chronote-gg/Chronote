/** @jest-environment node */
import { answerLegacyAskQuestion } from "../../src/services/legacyAskService";
import { listRecentMeetingsForGuildService } from "../../src/services/meetingHistoryService";
import { getMeetingHistoryRepository } from "../../src/repositories/meetingHistoryRepository";
import { ensureUserCanAccessMeeting } from "../../src/services/meetingAccessService";
import { getLangfuseChatPrompt } from "../../src/services/langfusePromptService";
import { generateOpenAIText } from "../../src/services/openaiTextService";

jest.mock("../../src/services/configService", () => ({
  config: { mock: { enabled: false }, langfuse: { askPromptName: "ask" } },
}));
jest.mock("../../src/services/meetingHistoryService", () => ({
  listRecentMeetingsForGuildService: jest.fn(),
}));
jest.mock("../../src/repositories/meetingHistoryRepository", () => ({
  getMeetingHistoryRepository: jest.fn(),
}));
jest.mock("../../src/services/meetingAccessService", () => ({
  ensureUserCanAccessMeeting: jest.fn(),
}));
jest.mock("../../src/services/attendeeAccessSetting", () => ({
  resolveAttendeeAccessEnabled: async () => true,
}));
jest.mock("../../src/services/meetingMentionService", () => ({
  createMeetingMentionReplacer: async () => ({
    toText: (text: string) => text.replaceAll("<@123>", "Current name"),
  }),
}));
jest.mock("../../src/services/dictionaryService", () => ({
  listDictionaryEntriesService: async () => [],
}));
jest.mock("../../src/services/subscriptionService", () => ({
  resolveGuildSubscription: async () => ({ tier: "free" }),
}));
jest.mock("../../src/services/unifiedConfigService", () => ({
  resolveConfigSnapshot: async () => ({ values: {}, tier: "free" }),
}));
jest.mock("../../src/services/modelChoiceService", () => ({
  resolveModelChoicesForContext: async () => ({ ask: "model" }),
}));
jest.mock("../../src/services/modelFactory", () => ({
  buildModelOverrides: (x: unknown) => x,
  getModelChoice: () => ({ model: "model" }),
}));
jest.mock("../../src/services/openaiModelParams", () => ({
  resolveModelParamsForContext: async () => ({ ask: {} }),
  resolveChatParamsForRole: () => ({ reasoning_effort: "low" }),
}));
jest.mock("../../src/services/langfusePromptService", () => ({
  getLangfuseChatPrompt: jest.fn(async () => ({
    messages: [],
    langfusePrompt: {},
  })),
}));
jest.mock("../../src/services/openaiTextService", () => ({
  generateOpenAIText: jest.fn(),
}));
const recent = {
  guildId: "g",
  channelId_timestamp: "v#2026-10-01T00:00:00.000Z",
  channelId: "v",
  timestamp: "2026-10-01T00:00:00.000Z",
  notes: "x".repeat(1000) + " Final decision <@123>",
  tags: [],
  meetingName: "Review",
};
const older = {
  ...recent,
  channelId_timestamp: "v#2020-01-01T00:00:00.000Z",
  timestamp: "2020-01-01T00:00:00.000Z",
  notes: "Selected older context",
};
const getStrong = jest.fn();
beforeEach(() => {
  jest.clearAllMocks();
  (listRecentMeetingsForGuildService as jest.Mock).mockResolvedValue([recent]);
  (getMeetingHistoryRepository as jest.Mock).mockReturnValue({ getStrong });
  getStrong.mockImplementation(
    async ({ channelId_timestamp }: { channelId_timestamp: string }) =>
      channelId_timestamp === older.channelId_timestamp ? older : recent,
  );
  (ensureUserCanAccessMeeting as jest.Mock).mockResolvedValue(true);
  (generateOpenAIText as jest.Mock).mockResolvedValue(
    'Decision <chronote:cite index="1"/>.',
  );
});
test("requires acting identity before browsing retained content", async () => {
  await expect(
    answerLegacyAskQuestion({
      guildId: "g",
      channelId: "v",
      question: "Decision?",
    }),
  ).rejects.toThrow("signed-in");
  expect(listRecentMeetingsForGuildService).not.toHaveBeenCalled();
});
test("uses the same operational25-candidate limit, current access, full notes, mentions and citations", async () => {
  const answer = await answerLegacyAskQuestion({
    guildId: "g",
    channelId: "v",
    question: "Decision?",
    viewerUserId: "user",
  });
  expect(listRecentMeetingsForGuildService).toHaveBeenCalledWith(
    "g",
    25,
    expect.objectContaining({ includeArchived: true }),
  );
  expect(ensureUserCanAccessMeeting).toHaveBeenCalledWith(
    expect.objectContaining({ userId: "user", meeting: recent }),
  );
  expect(getLangfuseChatPrompt).toHaveBeenCalledWith(
    expect.objectContaining({
      variables: expect.objectContaining({
        contextBlocks: expect.stringContaining("Final decision Current name"),
      }),
    }),
  );
  expect(answer.answer).toContain("25 most recent");
  expect(answer.citations).toEqual([
    { index: 1, meetingId: recent.channelId_timestamp },
  ]);
});
test("loads selected older context before recent candidates and excludes inaccessible records", async () => {
  (ensureUserCanAccessMeeting as jest.Mock).mockImplementation(
    async ({ meeting }: { meeting: { channelId_timestamp: string } }) =>
      meeting.channelId_timestamp === older.channelId_timestamp,
  );
  const answer = await answerLegacyAskQuestion({
    guildId: "g",
    channelId: "v",
    question: "Decision?",
    viewerUserId: "user",
    contextMeetingIds: [older.channelId_timestamp],
  });
  expect(answer.sourceMeetingIds).toEqual([older.channelId_timestamp]);
  expect(answer.citations).toEqual([
    { index: 1, meetingId: older.channelId_timestamp },
  ]);
  expect(getLangfuseChatPrompt).toHaveBeenCalledWith(
    expect.objectContaining({
      variables: expect.objectContaining({
        contextBlocks: expect.stringContaining("Selected older context"),
      }),
    }),
  );
});
test("does not generate from denied notes or replay assistant history without provenance", async () => {
  (ensureUserCanAccessMeeting as jest.Mock).mockResolvedValue(false);
  const answer = await answerLegacyAskQuestion({
    guildId: "g",
    channelId: "v",
    question: "Decision?",
    viewerUserId: "user",
  });
  expect(answer.sourceMeetingIds).toEqual([]);
  expect(generateOpenAIText).not.toHaveBeenCalled();
  (ensureUserCanAccessMeeting as jest.Mock).mockResolvedValue(true);
  await answerLegacyAskQuestion({
    guildId: "g",
    channelId: "v",
    question: "Decision?",
    viewerUserId: "user",
    history: [{ role: "chronote", text: "Revoked private content" }],
  });
  expect(getLangfuseChatPrompt).toHaveBeenCalledWith(
    expect.objectContaining({
      variables: expect.objectContaining({ historyBlock: "None." }),
    }),
  );
});

test("reports an oversized complete record instead of truncating notes or generating an unsupported answer", async () => {
  getStrong.mockResolvedValueOnce({ ...recent, notes: "x".repeat(90_000) });
  const answer = await answerLegacyAskQuestion({
    guildId: "g",
    channelId: "v",
    question: "Decision?",
    viewerUserId: "user",
  });
  expect(answer.answer).toContain(
    "complete meeting record exceeds the context budget",
  );
  expect(answer.sourceMeetingIds).toEqual([]);
  expect(generateOpenAIText).not.toHaveBeenCalled();
});

test("preserves the retryable access failure instead of treating unknown access as denied", async () => {
  (ensureUserCanAccessMeeting as jest.Mock).mockResolvedValueOnce(null);
  await expect(
    answerLegacyAskQuestion({
      guildId: "g",
      channelId: "v",
      question: "Decision?",
      viewerUserId: "user",
    }),
  ).rejects.toThrow("rate limit");
  expect(generateOpenAIText).not.toHaveBeenCalled();
});

test.each(["missing", "denied", "outside-channel"])(
  "rejects explicitly selected context that is %s",
  async (condition) => {
    if (condition === "missing") getStrong.mockResolvedValueOnce(undefined);
    if (condition === "denied")
      (ensureUserCanAccessMeeting as jest.Mock).mockResolvedValueOnce(false);
    if (condition === "outside-channel")
      getStrong.mockResolvedValueOnce({ ...older, channelId: "private-voice" });
    await expect(
      answerLegacyAskQuestion({
        guildId: "g",
        channelId: "v",
        question: "Decision?",
        viewerUserId: "user",
        scope: "channel",
        contextMeetingIds: [older.channelId_timestamp],
      }),
    ).rejects.toThrow("Selected meeting is not available");
    expect(generateOpenAIText).not.toHaveBeenCalled();
  },
);
