const mockRepository = {
  get: jest.fn(),
  tryReserve: jest.fn(),
  releaseReservation: jest.fn(),
};

jest.mock("../../repositories/chatTtsUsageRepository", () => ({
  getChatTtsUsageRepository: jest.fn(() => mockRepository),
}));

jest.mock("../../utils/upgradePrompt", () => ({
  buildUpgradeTextOnly: jest.fn(
    (content: string) => `${content}\nUpgrade: https://chronote.gg/upgrade`,
  ),
}));

import {
  buildChatTtsMonthlyLimitTextOnly,
  checkChatTtsMessageUsageLimit,
  getChatTtsUsagePeriod,
  releaseChatTtsMessageUsageReservation,
  reserveChatTtsMessageUsage,
} from "../chatTtsUsageService";

describe("chatTtsUsageService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("uses UTC year-month periods", () => {
    expect(getChatTtsUsagePeriod(new Date("2026-06-30T23:59:59.000Z"))).toBe(
      "2026-06",
    );
    expect(getChatTtsUsagePeriod(new Date("2026-07-01T00:00:00.000Z"))).toBe(
      "2026-07",
    );
  });

  it("allows usage below the monthly cap", async () => {
    mockRepository.get.mockResolvedValueOnce({ acceptedMessages: 41 });

    const status = await checkChatTtsMessageUsageLimit({
      guildId: "guild-1",
      limit: 1000,
      now: new Date("2026-06-11T12:00:00.000Z"),
    });

    expect(status).toMatchObject({
      allowed: true,
      guildId: "guild-1",
      period: "2026-06",
      used: 41,
      remaining: 959,
    });
  });

  it("blocks usage at the monthly cap", async () => {
    mockRepository.get.mockResolvedValueOnce({ acceptedMessages: 1000 });

    const status = await checkChatTtsMessageUsageLimit({
      guildId: "guild-1",
      limit: 1000,
      now: new Date("2026-06-11T12:00:00.000Z"),
    });

    expect(status).toMatchObject({
      allowed: false,
      used: 1000,
      remaining: 0,
    });
  });

  it("reserves one accepted message atomically", async () => {
    mockRepository.tryReserve.mockResolvedValueOnce({ acceptedMessages: 1000 });

    const reservation = await reserveChatTtsMessageUsage({
      guildId: "guild-1",
      limit: 1000,
      now: new Date("2026-06-11T12:00:00.000Z"),
    });

    expect(mockRepository.tryReserve).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: "guild-1",
        period: "2026-06",
        acceptedMessages: 0,
      }),
      1000,
    );
    expect(reservation).toMatchObject({
      allowed: true,
      reserved: true,
      used: 1000,
      remaining: 0,
    });
  });

  it("returns blocked status when atomic reservation fails", async () => {
    mockRepository.tryReserve.mockResolvedValueOnce(undefined);
    mockRepository.get.mockResolvedValueOnce({ acceptedMessages: 1000 });

    const reservation = await reserveChatTtsMessageUsage({
      guildId: "guild-1",
      limit: 1000,
      now: new Date("2026-06-11T12:00:00.000Z"),
    });

    expect(reservation).toMatchObject({
      allowed: false,
      reserved: false,
      used: 1000,
      remaining: 0,
    });
  });

  it("releases a reserved message by period", async () => {
    await releaseChatTtsMessageUsageReservation({
      guildId: "guild-1",
      period: "2026-06",
      now: new Date("2026-06-11T12:00:00.000Z"),
    });

    expect(mockRepository.releaseReservation).toHaveBeenCalledWith(
      "guild-1",
      "2026-06",
      "2026-06-11T12:00:00.000Z",
    );
  });

  it("builds upgrade CTA text for monthly caps", () => {
    const text = buildChatTtsMonthlyLimitTextOnly({
      allowed: false,
      guildId: "guild-1",
      period: "2026-06",
      limit: 1000,
      used: 1000,
      remaining: 0,
    });

    expect(text).toContain(
      "This server has spoken 1,000 chat-to-speech messages out loud with Chronote this month.",
    );
    expect(text).toContain("Upgrade: https://chronote.gg/upgrade");
  });

  it("formats final accepted message counts as ordinals", () => {
    const text = buildChatTtsMonthlyLimitTextOnly(
      {
        allowed: true,
        guildId: "guild-1",
        period: "2026-06",
        limit: 1001,
        used: 1001,
        remaining: 0,
      },
      { finalAcceptedMessage: true },
    );

    expect(text).toContain(
      "That was this server's 1,001st chat-to-speech message this month.",
    );
  });
});
