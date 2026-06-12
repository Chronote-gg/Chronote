import type { ChatInputCommandInteraction, GuildMember } from "discord.js";
import type { MeetingData } from "../../src/types/meeting-data";
import { handleSayCommand } from "../../src/commands/say";
import { getMeeting } from "../../src/meetings";
import { getGuildLimits } from "../../src/services/subscriptionService";
import { fetchUserSpeechSettings } from "../../src/services/userSpeechSettingsService";
import {
  buildChatTtsMonthlyLimitMessage,
  releaseChatTtsMessageUsageReservation,
  reserveChatTtsMessageUsage,
} from "../../src/services/chatTtsUsageService";
import { buildUpgradePrompt } from "../../src/utils/upgradePrompt";
import { config } from "../../src/services/configService";

jest.mock("../../src/meetings", () => ({
  getMeeting: jest.fn(),
}));
jest.mock("../../src/ttsQueue", () => ({
  createTtsQueue: jest.fn(),
}));
jest.mock("../../src/services/subscriptionService");
jest.mock("../../src/services/userSpeechSettingsService");
jest.mock("../../src/services/chatTtsUsageService", () => ({
  buildChatTtsMonthlyLimitMessage: jest.fn(() => "monthly limit reached"),
  releaseChatTtsMessageUsageReservation: jest.fn(),
  reserveChatTtsMessageUsage: jest.fn(),
}));
jest.mock("../../src/utils/upgradePrompt", () => ({
  buildUpgradePrompt: jest.fn((content: string) => ({
    content,
    ephemeral: true,
  })),
}));

const mockedGetMeeting = getMeeting as jest.MockedFunction<typeof getMeeting>;
const mockedGetGuildLimits = getGuildLimits as jest.MockedFunction<
  typeof getGuildLimits
>;
const mockedFetchUserSpeechSettings =
  fetchUserSpeechSettings as jest.MockedFunction<
    typeof fetchUserSpeechSettings
  >;
const mockedBuildChatTtsMonthlyLimitMessage =
  buildChatTtsMonthlyLimitMessage as jest.MockedFunction<
    typeof buildChatTtsMonthlyLimitMessage
  >;
const mockedReleaseChatTtsMessageUsageReservation =
  releaseChatTtsMessageUsageReservation as jest.MockedFunction<
    typeof releaseChatTtsMessageUsageReservation
  >;
const mockedReserveChatTtsMessageUsage =
  reserveChatTtsMessageUsage as jest.MockedFunction<
    typeof reserveChatTtsMessageUsage
  >;
const mockedBuildUpgradePrompt = buildUpgradePrompt as jest.MockedFunction<
  typeof buildUpgradePrompt
>;

const makeMember = (voiceChannelId: string): GuildMember =>
  ({
    user: {
      id: "user-1",
      username: "TestUser",
    },
    voice: {
      channelId: voiceChannelId,
    },
  }) as GuildMember;

const makeInteraction = (
  member: GuildMember,
  message: string,
  channelId = "voice-1",
): ChatInputCommandInteraction =>
  ({
    guildId: "guild-1",
    guild: {
      members: {
        cache: {
          get: jest.fn().mockReturnValue(member),
        },
        fetch: jest.fn().mockResolvedValue(member),
      },
    },
    channelId,
    id: "interaction-1",
    createdTimestamp: 1700000000000,
    user: {
      id: "user-1",
      username: "TestUser",
    },
    options: {
      getString: jest.fn().mockReturnValue(message),
    },
    reply: jest.fn().mockResolvedValue(undefined),
    deferReply: jest.fn().mockResolvedValue(undefined),
    deleteReply: jest.fn().mockResolvedValue(undefined),
  }) as unknown as ChatInputCommandInteraction;

const makeMeeting = (queueResult = true): MeetingData =>
  ({
    guildId: "guild-1",
    voiceChannel: {
      id: "voice-1",
    },
    participants: new Map(),
    attendance: new Set(),
    chatLog: [],
    ttsQueue: {
      enqueue: jest.fn().mockReturnValue(queueResult),
      stopAndClear: jest.fn(),
      size: jest.fn(),
    },
    finished: false,
  }) as MeetingData;

describe("handleSayCommand", () => {
  beforeEach(() => {
    mockedGetMeeting.mockReset();
    mockedGetGuildLimits.mockReset();
    mockedFetchUserSpeechSettings.mockReset();
    mockedBuildChatTtsMonthlyLimitMessage.mockReset();
    mockedBuildChatTtsMonthlyLimitMessage.mockReturnValue(
      "monthly limit reached",
    );
    mockedReleaseChatTtsMessageUsageReservation.mockReset();
    mockedReleaseChatTtsMessageUsageReservation.mockResolvedValue(undefined);
    mockedReserveChatTtsMessageUsage.mockReset();
    mockedReserveChatTtsMessageUsage.mockResolvedValue({
      allowed: true,
      reserved: true,
      guildId: "guild-1",
      period: "2026-06",
      limit: 1000,
      used: 42,
      remaining: 958,
    });
    mockedBuildUpgradePrompt.mockClear();
  });

  it("blocks /say on free tier", async () => {
    const member = makeMember("voice-1");
    const interaction = makeInteraction(member, "hello");
    const meeting = makeMeeting();
    mockedGetMeeting.mockReturnValue(meeting);
    mockedGetGuildLimits.mockResolvedValue({
      subscription: {
        tier: "free",
        status: "free",
        source: "default",
        billingSource: "free",
        stripeTier: null,
        grantTier: null,
        activeGrant: null,
      },
      limits: { liveVoiceEnabled: false, imagesEnabled: false },
    });

    await handleSayCommand(interaction);

    expect(mockedBuildUpgradePrompt).toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("Upgrade") }),
    );
  });

  it("rejects when user is not in the meeting voice channel", async () => {
    const member = makeMember("voice-2");
    const interaction = makeInteraction(member, "hello");
    const meeting = makeMeeting();
    mockedGetMeeting.mockReturnValue(meeting);
    mockedGetGuildLimits.mockResolvedValue({
      subscription: {
        tier: "basic",
        status: "active",
        source: "stripe",
        billingSource: "stripe",
        stripeTier: "basic",
        grantTier: null,
        activeGrant: null,
      },
      limits: { liveVoiceEnabled: true, imagesEnabled: true },
    });

    await handleSayCommand(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "Join the meeting voice channel to use /say.",
      }),
    );
    expect(mockedReleaseChatTtsMessageUsageReservation).toHaveBeenCalledWith({
      guildId: "guild-1",
      period: "2026-06",
    });
    expect(meeting.ttsQueue?.enqueue).not.toHaveBeenCalled();
  });

  it("enqueues chat-to-speech and stores a chat entry", async () => {
    const member = makeMember("voice-1");
    const interaction = makeInteraction(member, "hello");
    const meeting = makeMeeting();
    mockedGetMeeting.mockReturnValue(meeting);
    mockedGetGuildLimits.mockResolvedValue({
      subscription: {
        tier: "basic",
        status: "active",
        source: "stripe",
        billingSource: "stripe",
        stripeTier: "basic",
        grantTier: null,
        activeGrant: null,
      },
      limits: { liveVoiceEnabled: true, imagesEnabled: true },
    });
    mockedFetchUserSpeechSettings.mockResolvedValue({
      guildId: "guild-1",
      userId: "user-1",
      chatTtsVoice: "nova",
      updatedAt: "2025-01-01T00:00:00.000Z",
      updatedBy: "user-1",
    });

    await handleSayCommand(interaction);

    expect(meeting.ttsQueue?.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "hello",
        voice: "nova",
        userId: "user-1",
        source: "chat_tts",
        messageId: interaction.id,
      }),
    );
    expect(meeting.chatLog).toHaveLength(1);
    expect(meeting.chatLog[0]).toEqual(
      expect.objectContaining({
        source: "chat_tts",
        content: "hello",
        messageId: interaction.id,
      }),
    );
    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(interaction.deleteReply).toHaveBeenCalled();
  });

  it("blocks /say when the monthly chat-to-speech cap is reached", async () => {
    const member = makeMember("voice-1");
    const interaction = makeInteraction(member, "hello");
    mockedGetGuildLimits.mockResolvedValue({
      subscription: {
        tier: "basic",
        status: "active",
        source: "stripe",
        billingSource: "stripe",
        stripeTier: "basic",
        grantTier: null,
        activeGrant: null,
      },
      limits: {
        liveVoiceEnabled: true,
        imagesEnabled: true,
        maxChatTtsMessagesMonthly: 1000,
      },
    });
    mockedReserveChatTtsMessageUsage.mockResolvedValueOnce({
      allowed: false,
      reserved: false,
      guildId: "guild-1",
      period: "2026-06",
      limit: 1000,
      used: 1000,
      remaining: 0,
    });

    await handleSayCommand(interaction);

    expect(mockedBuildChatTtsMonthlyLimitMessage).toHaveBeenCalledWith(
      expect.objectContaining({ allowed: false, remaining: 0 }),
      { compedTier: null },
    );
    expect(mockedBuildUpgradePrompt).toHaveBeenCalledWith(
      "monthly limit reached",
    );
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: "monthly limit reached" }),
    );
    expect(mockedReserveChatTtsMessageUsage).toHaveBeenCalledWith({
      guildId: "guild-1",
      limit: 1000,
    });
    expect(mockedGetMeeting).not.toHaveBeenCalled();
  });

  it("releases a reserved monthly usage count when the queue is full", async () => {
    const member = makeMember("voice-1");
    const interaction = makeInteraction(member, "hello");
    const meeting = makeMeeting(false);
    mockedGetMeeting.mockReturnValue(meeting);
    mockedGetGuildLimits.mockResolvedValue({
      subscription: {
        tier: "basic",
        status: "active",
        source: "stripe",
        billingSource: "stripe",
        stripeTier: "basic",
        grantTier: null,
        activeGrant: null,
      },
      limits: {
        liveVoiceEnabled: true,
        imagesEnabled: true,
        maxChatTtsMessagesMonthly: 1000,
      },
    });

    await handleSayCommand(interaction);

    expect(mockedReleaseChatTtsMessageUsageReservation).toHaveBeenCalledWith({
      guildId: "guild-1",
      period: "2026-06",
    });
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "The speech queue is full right now. Try again in a moment.",
      }),
    );
    expect(meeting.chatLog).toHaveLength(0);
  });

  it("rejects messages that exceed the max length", async () => {
    if (config.chatTts.maxChars <= 0) return;
    const member = makeMember("voice-1");
    const interaction = makeInteraction(
      member,
      "a".repeat(config.chatTts.maxChars + 1),
    );
    const meeting = makeMeeting();
    mockedGetMeeting.mockReturnValue(meeting);
    mockedGetGuildLimits.mockResolvedValue({
      subscription: {
        tier: "basic",
        status: "active",
        source: "stripe",
        billingSource: "stripe",
        stripeTier: "basic",
        grantTier: null,
        activeGrant: null,
      },
      limits: { liveVoiceEnabled: true, imagesEnabled: true },
    });

    await handleSayCommand(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("Message too long"),
      }),
    );
    expect(meeting.ttsQueue?.enqueue).not.toHaveBeenCalled();
    expect(meeting.chatLog).toHaveLength(0);
  });
});
