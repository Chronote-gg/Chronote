jest.mock("../services/configService", () => ({
  config: {
    chatTts: { maxChars: 400, defaultVoice: "alloy" },
  },
}));

jest.mock("../services/userSpeechSettingsService", () => ({
  fetchUserSpeechSettings: jest.fn(async () => undefined),
}));

jest.mock("../services/subscriptionService", () => ({
  getLimitsForTier: jest.fn(() => ({ maxChatTtsMessagesMonthly: 1000 })),
}));

const mockReserveChatTtsMessageUsage = jest.fn();
const mockReleaseChatTtsMessageUsageReservation = jest.fn();

jest.mock("../services/chatTtsUsageService", () => ({
  buildChatTtsMonthlyLimitTextOnly: jest.fn(() => "monthly limit notice"),
  releaseChatTtsMessageUsageReservation: (...args: unknown[]) =>
    mockReleaseChatTtsMessageUsageReservation(...args),
  reserveChatTtsMessageUsage: (...args: unknown[]) =>
    mockReserveChatTtsMessageUsage(...args),
}));

jest.mock("../metrics", () => ({
  chatTtsDropped: { inc: jest.fn() },
  chatTtsEnqueued: { inc: jest.fn() },
  chatTtsMonthlyLimitBlocked: { inc: jest.fn() },
}));

import type { Message } from "discord.js";
import { maybeSpeakChatMessage } from "../chatTts";
import type { ChatEntry } from "../types/chat";
import type { MeetingData } from "../types/meeting-data";

function buildMeeting(enqueue = jest.fn(() => true)) {
  return {
    guildId: "guild-1",
    subscriptionTier: "basic",
    chatTtsEnabled: true,
    chatTtsUserSettings: new Map(),
    participants: new Map(),
    textChannel: { send: jest.fn() },
    voiceChannel: { members: { has: jest.fn(() => true) } },
    ttsQueue: {
      enqueue,
      playCueIfIdle: jest.fn(),
      stopAndClear: jest.fn(),
      size: jest.fn(() => 0),
    },
  } as unknown as MeetingData;
}

const message = {
  id: "message-1",
  content: "Hello there",
  author: { id: "user-1", username: "Ada" },
} as Message;

const entry = {
  type: "message",
  source: "chat",
  user: { id: "user-1", username: "Ada" },
  channelId: "text-1",
  timestamp: "2026-06-11T12:00:00.000Z",
} as ChatEntry;

describe("maybeSpeakChatMessage", () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("blocks automatic chat TTS when the monthly cap is reached", async () => {
    mockReserveChatTtsMessageUsage.mockResolvedValueOnce({
      allowed: false,
      reserved: false,
      guildId: "guild-1",
      period: "2026-06",
      limit: 1000,
      used: 1000,
      remaining: 0,
    });
    const enqueue = jest.fn(() => true);
    const meeting = buildMeeting(enqueue);

    await maybeSpeakChatMessage(meeting, message, { ...entry });

    expect(enqueue).not.toHaveBeenCalled();
    expect(meeting.textChannel.send).toHaveBeenCalledWith(
      "monthly limit notice",
    );
  });

  it("releases a reserved usage count when the queue is full", async () => {
    mockReserveChatTtsMessageUsage.mockResolvedValueOnce({
      allowed: true,
      reserved: true,
      guildId: "guild-1",
      period: "2026-06",
      limit: 1000,
      used: 42,
      remaining: 958,
    });
    const enqueue = jest.fn(() => false);
    const meeting = buildMeeting(enqueue);

    await maybeSpeakChatMessage(meeting, message, { ...entry });

    expect(mockReleaseChatTtsMessageUsageReservation).toHaveBeenCalledWith({
      guildId: "guild-1",
      period: "2026-06",
    });
  });

  it("marks chat as TTS after reserving and enqueueing usage", async () => {
    mockReserveChatTtsMessageUsage.mockResolvedValueOnce({
      allowed: true,
      reserved: true,
      guildId: "guild-1",
      period: "2026-06",
      limit: 1000,
      used: 42,
      remaining: 958,
    });
    const nextEntry = { ...entry };
    const meeting = buildMeeting();

    await maybeSpeakChatMessage(meeting, message, nextEntry);

    expect(meeting.ttsQueue?.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ source: "chat_tts", userId: "user-1" }),
    );
    expect(nextEntry.source).toBe("chat_tts");
  });
});
