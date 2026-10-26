import { describe, expect, test, jest } from "@jest/globals";
import type { MeetingHistory } from "../../src/types/db";

type LoadOptions = {
  mockEnabled?: boolean;
  meetings?: MeetingHistory[];
  access?: Array<boolean | null>;
  maxMeetings?: number;
  responseText?: string;
};

const buildMeeting = (
  overrides: Partial<MeetingHistory> = {},
): MeetingHistory => ({
  guildId: "guild-1",
  channelId_timestamp: "voice-1#2025-01-01T00:00:00.000Z",
  meetingId: "meeting-1",
  channelId: "voice-1",
  timestamp: "2025-01-01T00:00:00.000Z",
  participants: [],
  duration: 60,
  transcribeMeeting: true,
  generateNotes: true,
  ...overrides,
});

const loadModule = async (options: LoadOptions = {}) => {
  jest.resetModules();

  const listRecentMeetingsForGuildService = jest
    .fn<(...args: unknown[]) => Promise<MeetingHistory[]>>()
    .mockResolvedValue(options.meetings ?? []);
  const ensureUserCanAccessMeeting =
    jest.fn<
      (options: {
        guildId: string;
        meeting: MeetingHistory;
        userId: string;
      }) => Promise<boolean | null>
    >();
  if (options.access?.length) {
    options.access.forEach((value) =>
      ensureUserCanAccessMeeting.mockResolvedValueOnce(value),
    );
  } else {
    ensureUserCanAccessMeeting.mockResolvedValue(true);
  }

  const config = {
    mock: { enabled: options.mockEnabled ?? true },
    ask: { maxMeetings: options.maxMeetings ?? 25 },
    database: { useLocalDynamoDB: false, tablePrefix: "" },
    discord: { clientId: "mock-bot" },
    notes: { model: "gpt-5.2" },
    liveVoice: {
      gateModel: "gpt-5-mini",
      responderModel: "gpt-4o-mini",
      ttsModel: "gpt-4o-mini-tts",
    },
    stripe: { billingLandingUrl: "https://example.com/billing" },
    langfuse: { askPromptName: "chronote-ask-system-chat" },
  };

  const responseCreate = jest
    .fn<(...args: unknown[]) => Promise<unknown>>()
    .mockResolvedValue({
      status: "completed",
      output_text: options.responseText ?? "A generated answer.",
      output: [
        {
          type: "message",
          content: [
            {
              type: "output_text",
              text: options.responseText ?? "A generated answer.",
            },
          ],
        },
      ],
    });
  const getLangfuseChatPrompt = jest.fn(async () => ({
    messages: [
      { role: "system", content: "Use the meeting evidence." },
      { role: "user", content: "When is the launch?" },
    ],
    langfusePrompt: {
      name: "chronote-ask-system-chat",
      version: 1,
      isFallback: false,
    },
    source: "langfuse",
  }));

  jest.doMock("../../src/services/openaiClient", () => ({
    createOpenAIClient: jest.fn(() => ({
      responses: { create: responseCreate },
    })),
  }));
  jest.doMock("../../src/services/langfusePromptService", () => ({
    getLangfuseChatPrompt,
  }));
  jest.doMock("../../src/services/modelFactory", () => ({
    buildModelOverrides: (overrides: unknown) => overrides,
    getModelChoice: () => ({ provider: "openai", model: "gpt-5.2" }),
  }));
  jest.doMock("../../src/services/modelChoiceService", () => ({
    resolveModelChoicesForContext: async () => ({ ask: "gpt-5.2" }),
  }));
  jest.doMock("../../src/services/openaiModelParams", () => ({
    resolveModelParamsForContext: async () => ({ ask: {} }),
    resolveChatParamsForRole: () => ({
      reasoning_effort: "low",
      verbosity: "low",
    }),
  }));
  jest.doMock("../../src/services/dictionaryService", () => ({
    listDictionaryEntriesService: async () => [],
  }));
  jest.doMock("../../src/services/subscriptionService", () => ({
    resolveGuildSubscription: async () => ({ tier: "free" }),
  }));
  jest.doMock("../../src/services/unifiedConfigService", () => ({
    resolveConfigSnapshot: async () => ({ tier: "free", values: {} }),
    getSnapshotBoolean: () => true,
  }));
  jest.doMock("../../src/services/analyticsService", () => ({
    captureEvent: jest.fn(),
  }));
  jest.doMock("../../src/services/meetingHistoryService", () => ({
    listRecentMeetingsForGuildService,
  }));
  jest.doMock("../../src/services/meetingAccessService", () => ({
    ensureUserCanAccessMeeting,
  }));
  jest.doMock("../../src/services/configService", () => ({ config }));

  const module = await import("../../src/services/askService");
  return {
    ...module,
    listRecentMeetingsForGuildService,
    ensureUserCanAccessMeeting,
    responseCreate,
    getLangfuseChatPrompt,
  };
};

describe("askService (mock mode)", () => {
  test("builds context blocks with status and indices", async () => {
    const meeting = buildMeeting({
      notes: "Notes",
      tags: ["priority"],
    });
    const { buildAskContextBlocks } = await loadModule({
      mockEnabled: true,
      meetings: [meeting],
    });

    const blocks = buildAskContextBlocks([meeting]);
    expect(blocks[0]).toContain('<meeting index="1">');
    expect(blocks[0]).toContain("Status: Active");
    expect(blocks[0]).toContain("Tags: priority");
    expect(blocks[0]).toContain("</meeting>");
  });

  test("returns mock answer when meetings exist", async () => {
    const meeting = buildMeeting({
      notes: "Notes",
    });
    const { answerQuestionService } = await loadModule({
      mockEnabled: true,
      meetings: [meeting],
    });

    const result = await answerQuestionService({
      guildId: "guild-1",
      channelId: "voice-1",
      question: "What did we decide?",
    });

    expect(result.answer).toContain('Mock answer for "What did we decide?"');
    expect(result.answer).not.toContain("discord.com/channels");
    expect(result.sourceMeetingIds).toEqual([meeting.channelId_timestamp]);
  });

  test("filters by tags, channel, and viewer access", async () => {
    const meetingA = buildMeeting({
      channelId_timestamp: "voice-1#2025-01-01T00:00:00.000Z",
      channelId: "voice-1",
      tags: ["priority"],
    });
    const meetingB = buildMeeting({
      channelId_timestamp: "voice-2#2025-01-02T00:00:00.000Z",
      channelId: "voice-2",
      tags: ["priority"],
    });
    const meetingC = buildMeeting({
      channelId_timestamp: "voice-1#2025-01-03T00:00:00.000Z",
      channelId: "voice-1",
      tags: ["other"],
    });
    const { answerQuestionService, ensureUserCanAccessMeeting } =
      await loadModule({
        mockEnabled: true,
        meetings: [meetingA, meetingB, meetingC],
        access: [true],
      });

    const result = await answerQuestionService({
      guildId: "guild-1",
      channelId: "voice-1",
      question: "Show priority notes",
      tags: ["priority"],
      scope: "channel",
      viewerUserId: "viewer-1",
    });

    expect(ensureUserCanAccessMeeting).toHaveBeenCalledTimes(1);
    expect(result.sourceMeetingIds).toEqual([meetingA.channelId_timestamp]);
  });

  test("filters channel scope using channelId_timestamp fallback", async () => {
    const meetingA = buildMeeting({
      channelId_timestamp: "voice-1#2025-01-01T00:00:00.000Z",
      channelId: "",
      tags: ["priority"],
    });
    const meetingB = buildMeeting({
      channelId_timestamp: "voice-2#2025-01-02T00:00:00.000Z",
      channelId: "voice-2",
      tags: ["priority"],
    });
    const { answerQuestionService, ensureUserCanAccessMeeting } =
      await loadModule({
        mockEnabled: true,
        meetings: [meetingA, meetingB],
        access: [true],
      });

    const result = await answerQuestionService({
      guildId: "guild-1",
      channelId: "voice-1",
      question: "Show priority notes",
      tags: ["priority"],
      scope: "channel",
      viewerUserId: "viewer-1",
    });

    expect(ensureUserCanAccessMeeting).toHaveBeenCalledTimes(1);
    expect(result.sourceMeetingIds).toEqual([meetingA.channelId_timestamp]);
  });

  test("throws on Discord rate limits when filtering by viewer access", async () => {
    const meeting = buildMeeting({
      channelId_timestamp: "voice-1#2025-01-01T00:00:00.000Z",
      channelId: "voice-1",
    });
    const { answerQuestionService } = await loadModule({
      mockEnabled: true,
      meetings: [meeting],
      access: [null],
    });

    await expect(
      answerQuestionService({
        guildId: "guild-1",
        channelId: "voice-1",
        question: "What happened?",
        viewerUserId: "viewer-1",
      }),
    ).rejects.toMatchObject({ name: "DiscordRateLimitedError" });
  });
});

describe("askService (non-mock)", () => {
  test("uses Responses and retains meeting citations", async () => {
    const meeting = buildMeeting({ notes: "The launch is Thursday." });
    const answer = 'Thursday. <chronote:cite index="1"/>';
    const { answerQuestionService, responseCreate, getLangfuseChatPrompt } =
      await loadModule({
        mockEnabled: false,
        meetings: [meeting],
        responseText: answer,
      });

    const result = await answerQuestionService({
      guildId: "guild-1",
      channelId: "voice-1",
      question: "When is the launch?",
      viewerUserId: "viewer-1",
      history: [
        {
          role: "chronote",
          text: 'Earlier answer. <chronote:cite index="1"/>',
        },
      ],
    });

    expect(responseCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-5.2",
        input: [
          { role: "system", content: "Use the meeting evidence." },
          { role: "user", content: "When is the launch?" },
        ],
        max_output_tokens: 800,
        reasoning: { effort: "low" },
        text: { verbosity: "low" },
        store: false,
      }),
      undefined,
    );
    expect(getLangfuseChatPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "chronote-ask-system-chat",
        variables: expect.objectContaining({
          question: "When is the launch?",
          contextBlocks: expect.stringContaining("The launch is Thursday."),
          historyBlock: "Chronote: Earlier answer.",
          dictionaryBlock: "None.",
          maxAnswerTokens: "800",
        }),
      }),
    );
    expect(result).toEqual({
      answer,
      sourceMeetingIds: [meeting.channelId_timestamp],
      citations: [
        {
          index: 1,
          meetingId: meeting.channelId_timestamp,
          eventId: undefined,
        },
      ],
    });
  });

  test.each(["", " \n "])(
    "rejects completed Responses output without usable text (%j)",
    async (responseText) => {
      const { answerQuestionService, responseCreate } = await loadModule({
        mockEnabled: false,
        meetings: [buildMeeting({ notes: "The launch is Thursday." })],
        responseText,
      });

      await expect(
        answerQuestionService({
          guildId: "guild-1",
          channelId: "voice-1",
          question: "When is the launch?",
        }),
      ).rejects.toThrow(/empty/i);
      expect(responseCreate).toHaveBeenCalledTimes(1);
    },
  );

  test("returns upgrade note when no meetings and maxMeetings is reduced", async () => {
    const { answerQuestionService } = await loadModule({
      mockEnabled: false,
      meetings: [
        buildMeeting({
          channelId_timestamp: "voice-9#2025-01-02T00:00:00.000Z",
          channelId: "voice-9",
          tags: ["other"],
        }),
      ],
      maxMeetings: 25,
    });

    const result = await answerQuestionService({
      guildId: "guild-1",
      channelId: "voice-1",
      question: "Any updates?",
      maxMeetings: 5,
      tags: ["priority"],
    });

    expect(result.answer).toContain("No relevant meetings found.");
    expect(result.answer).toContain("Upgrade:");
    expect(result.sourceMeetingIds).toEqual([]);
  });
});
