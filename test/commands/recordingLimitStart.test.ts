import { mockFreeGuildLimits } from "../fixtures/meetingStart";
import { createUpgradeRecordingLimitNotice } from "../fixtures/recordingLimitNotice";
jest.mock("../../src/services/meetingUsageService", () => ({
  getRollingUsageForGuild: jest.fn(async () => ({
    usedSeconds: 240 * 60,
    meetings: [],
    windowStartIso: "2026-10-01T00:00:00Z",
  })),
  getRollingWindowMs: jest.fn(() => 7 * 86400000),
  getNextAvailableAt: jest.fn(() => "2026-10-13T00:00:00Z"),
}));
jest.mock("../../src/services/recordingLimitService", () => ({
  ...jest.requireActual("../../src/services/recordingLimitService"),
  encounterRecordingLimit: jest.fn(),
  notifyRecordingLimit: jest.fn(),
}));
import {
  startManualMeetingFromChannels,
  handleAutoStartMeeting,
} from "../../src/commands/startMeeting";
import {
  encounterRecordingLimit,
  notifyRecordingLimit,
} from "../../src/services/recordingLimitService";
import { getGuildLimits } from "../../src/services/subscriptionService";
import { initializeMeeting } from "../../src/meetings";
import type {
  Client,
  Guild,
  User,
  TextChannel,
  VoiceBasedChannel,
} from "discord.js";
const guild = {
  id: "guild-1",
  client: { user: { id: "bot-1" } },
  members: { cache: new Map([["bot-1", { id: "bot-1" }]]) },
} as unknown as Guild;
const textChannel = { send: jest.fn() } as unknown as TextChannel;
const voiceChannel = { id: "voice-1", guild } as VoiceBasedChannel;
const client = { user: { id: "bot-1" } } as Client;
const creator = { id: "actor-1" } as User;
beforeEach(() => {
  jest.clearAllMocks();
  mockFreeGuildLimits();
  jest
    .mocked(encounterRecordingLimit)
    .mockImplementation(async (input) =>
      createUpgradeRecordingLimitNotice(input),
    );
});
test.each(["manual_command", "mcp"] as const)(
  "%s refusal captures the shared encounter without starting a recording",
  async (startReason) => {
    const result = await startManualMeetingFromChannels({
      client,
      guild,
      textChannel,
      voiceChannel,
      creator,
      startReason,
      startTriggeredByUserId: creator.id,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Unexpected recording");
    expect(result.recordingLimitNotice).toBeDefined();
    expect(result.error).toContain("Try again after");
    expect(encounterRecordingLimit).toHaveBeenCalledTimes(1);
    expect(encounterRecordingLimit).toHaveBeenCalledWith(
      expect.objectContaining({
        limitType: "weekly_recording",
        limitSurface: startReason === "mcp" ? "mcp_start" : "manual_start",
        outcome: "blocked_start",
        guildId: "guild-1",
        userId: "actor-1",
        limitMinutes: 240,
        usedMinutes: 240,
      }),
    );
    expect(textChannel.send).not.toHaveBeenCalled();
    expect(initializeMeeting).not.toHaveBeenCalled();
  },
);
test("a control fenced during held limits cannot enter meeting initialization", async () => {
  let release!: () => void;
  let enter!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const limits = await getGuildLimits(guild.id);
  jest.mocked(getGuildLimits).mockImplementationOnce(async () => {
    enter();
    await held;
    return {
      ...limits,
      limits: { ...limits.limits, maxMeetingMinutesRolling: 0 },
    };
  });
  jest
    .mocked(initializeMeeting)
    .mockResolvedValue({ guildId: guild.id, meetingId: "synthetic" } as never);
  const controller = new AbortController();
  const starting = startManualMeetingFromChannels({
    client,
    guild,
    textChannel,
    voiceChannel,
    creator,
    startTriggeredByUserId: creator.id,
    startSignal: controller.signal,
    assertStartAllowed: async () => controller.signal.throwIfAborted(),
  });
  await started;
  controller.abort(new Error("control claim lost"));
  release();
  await expect(starting).rejects.toThrow("control claim lost");
  expect(initializeMeeting).not.toHaveBeenCalled();
  expect(textChannel.send).not.toHaveBeenCalled();
});

test("auto refusal passes a real trigger to the shared delivery policy", async () => {
  await expect(
    handleAutoStartMeeting(client, voiceChannel, textChannel, {
      startTriggeredByUserId: creator.id,
    }),
  ).resolves.toBe(false);
  expect(notifyRecordingLimit).toHaveBeenCalledWith(
    expect.objectContaining({
      limitSurface: "auto_start",
      outcome: "blocked_start",
      userId: "actor-1",
      usedMinutes: 240,
    }),
    textChannel,
  );
  expect(initializeMeeting).not.toHaveBeenCalled();
});
