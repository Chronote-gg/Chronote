/** @jest-environment node */
jest.mock("dotenv", () => ({ config: () => ({ parsed: {} }) }));
jest.mock("../../src/services/discordCacheService", () => ({
  listBotGuildsCached: jest.fn(async () => [
    { id: "guild-1", name: "Server X" },
  ]),
  listGuildChannelsCached: jest.fn(async () => [
    { id: "voice-1", name: "Channel Y", type: 2 },
    { id: "text-1", name: "general", type: 0 },
  ]),
  listGuildRolesCached: jest.fn(async () => [
    { id: "role-design", name: "Design", permissions: "0" },
    { id: "guild-1", name: "@everyone", permissions: "0" },
  ]),
}));
jest.mock("../../src/services/langfusePromptService", () => ({
  getLangfuseChatPrompt: jest.fn(async () => ({
    messages: [{ role: "system", content: "Current notes prompt" }],
    source: "langfuse",
    langfusePrompt: { name: "notes", version: 7, isFallback: false },
  })),
}));
jest.mock("../../src/services/unifiedConfigService", () => ({
  resolveConfigSnapshot: jest.fn(async () => ({
    values: { "context.instructions": { value: "Server rules" } },
  })),
}));
jest.mock("../../src/services/channelContextService", () => ({
  fetchChannelContext: jest.fn(async () => ({ context: "Channel rules" })),
}));
jest.mock("../../src/services/meetingHistoryService", () => ({
  listRecentMeetingsForChannelService: jest.fn(),
}));
jest.mock("../../src/services/dictionaryService", () => ({
  listDictionaryEntriesService: jest.fn(async () => []),
}));
jest.mock("../../src/services/storageService", () => ({
  fetchJsonFromS3: jest.fn(),
}));
jest.mock("../../src/services/subscriptionService", () => ({
  resolveGuildSubscription: jest.fn(async () => ({ tier: "pro" })),
}));
const scopedRuntimeConfig = {
  premiumTranscription: { enabled: true, cleanupEnabled: true },
  dictionary: { maxEntries: 3, maxCharsTranscription: 10, maxCharsContext: 20 },
  visionCaptions: { enabled: false, maxImages: 0, maxTotalChars: 0 },
  modelChoices: {
    notes: "channel-notes-model",
    transcriptionCleanup: "channel-cleanup-model",
  },
  modelParams: { notes: { reasoningEffort: "high" } },
};
jest.mock("../../src/services/transcriptionCleanupService", () => ({
  ...jest.requireActual("../../src/services/transcriptionCleanupService"),
  cleanupContentTranscription: jest.fn(),
}));
jest.mock("../../src/services/meetingConfigService", () => ({
  resolveMeetingRuntimeConfig: jest.fn(async () => scopedRuntimeConfig),
}));
import { getLangfuseChatPrompt } from "../../src/services/langfusePromptService";
import { listRecentMeetingsForChannelService } from "../../src/services/meetingHistoryService";
import { fetchJsonFromS3 } from "../../src/services/storageService";
import { config } from "../../src/services/configService";
import {
  buildCurrentNotesInput,
  cleanupWithCurrentSettings,
} from "../../src/services/processingRetryNotesInput";
import { cleanupContentTranscription } from "../../src/services/transcriptionCleanupService";
import { resolveMeetingRuntimeConfig } from "../../src/services/meetingConfigService";
import type { MeetingHistory } from "../../src/types/db";

const signal = new AbortController().signal;
const timestamp = "2026-10-22T12:00:00.000Z";
const row: MeetingHistory = {
  guildId: "guild-1",
  channelId_timestamp: `voice-1#${timestamp}`,
  meetingId: "meeting-1",
  channelId: "voice-1",
  timestamp,
  chatS3Key: "p/chat.json",
  context: "Meeting rules",
  meetingCreatorId: "creator-1",
  participants: [
    { id: "user-1", username: "user-a", roleIds: ["role-design"] },
  ],
  duration: 60,
  transcribeMeeting: true,
  generateNotes: true,
};
const meetingAt = (at: string, notes: string): MeetingHistory => ({
  ...row,
  channelId_timestamp: `voice-1#${at}`,
  timestamp: at,
  notes,
});

test("builds the notes input from current server settings and only earlier meetings", async () => {
  jest
    .mocked(listRecentMeetingsForChannelService)
    .mockResolvedValue([
      meetingAt("2026-10-23T12:00:00.000Z", "Later synthetic notes"),
      meetingAt(timestamp, "This synthetic meeting"),
      meetingAt("2026-10-21T12:00:00.000Z", "Earlier synthetic notes"),
    ]);
  jest.mocked(fetchJsonFromS3).mockResolvedValue([
    {
      type: "message",
      user: { id: "user-1", username: "user-a" },
      channelId: "voice-1",
      content: "Please skip the budget item",
      timestamp,
    },
  ]);

  const input = await buildCurrentNotesInput(row, "Stored transcript", signal);

  const call = jest.mocked(getLangfuseChatPrompt).mock.calls[0][0];
  expect(call.name).toBe(config.langfuse.notesPromptName);
  const variables = call.variables ?? {};
  expect(variables.formattedContext).toEqual(
    expect.stringContaining("Server rules"),
  );
  expect(variables.formattedContext).toEqual(
    expect.stringContaining("Channel rules"),
  );
  expect(variables.formattedContext).toEqual(
    expect.stringContaining("Earlier synthetic notes"),
  );
  expect(variables.formattedContext).not.toEqual(
    expect.stringContaining("Later synthetic notes"),
  );
  expect(variables.formattedContext).not.toEqual(
    expect.stringContaining("This synthetic meeting"),
  );
  expect(variables).toMatchObject({
    serverName: "Server X",
    voiceChannelName: "Channel Y",
    channelNames: "Channel Y, general",
    transcript: "Stored transcript",
    chatContextBlock: expect.stringContaining("Please skip the budget item"),
    roles: expect.stringContaining("Design"),
  });
  expect(variables.roles).not.toEqual(expect.stringContaining("@everyone"));
  expect(input).toMatchObject({
    meetingId: "meeting-1",
    guildId: "guild-1",
    channelId: "voice-1",
    finalTranscript: "Stored transcript",
    startTime: new Date(timestamp),
    creator: { id: "creator-1" },
    guild: { id: "guild-1", name: "Server X" },
    voiceChannel: { id: "voice-1", name: "Channel Y" },
    signal,
    notesPrompt: {
      messages: [{ role: "system", content: "Current notes prompt" }],
      promptVisibleRoleIds: ["role-design"],
    },
  });
  expect(input.meetingName).toBeUndefined();
  expect(input.participants.get("user-1")?.username).toBe("user-a");
  expect(input.recovered).toBeUndefined();
});

test("throws when the notes prompt cannot be fetched", async () => {
  jest.mocked(listRecentMeetingsForChannelService).mockResolvedValue([]);
  jest
    .mocked(getLangfuseChatPrompt)
    .mockRejectedValueOnce(new Error("Langfuse unavailable"));

  await expect(
    buildCurrentNotesInput(row, "Stored transcript", signal),
  ).rejects.toThrow("Langfuse unavailable");
});

test("carries the meeting's server and channel scoped settings, as a live meeting would", async () => {
  jest.mocked(listRecentMeetingsForChannelService).mockResolvedValue([]);

  const input = await buildCurrentNotesInput(row, "Stored transcript", signal);

  expect(resolveMeetingRuntimeConfig).toHaveBeenCalledWith({
    guildId: "guild-1",
    channelId: "voice-1",
    userId: "creator-1",
    tier: "pro",
  });
  expect(input.runtimeConfig).toEqual({
    modelChoices: scopedRuntimeConfig.modelChoices,
    modelParams: scopedRuntimeConfig.modelParams,
    dictionary: scopedRuntimeConfig.dictionary,
    visionCaptions: scopedRuntimeConfig.visionCaptions,
  });
});

describe("cleanupWithCurrentSettings", () => {
  const mixed = "first line\nsecond line";
  beforeEach(() => {
    scopedRuntimeConfig.premiumTranscription = {
      enabled: true,
      cleanupEnabled: true,
    };
  });

  test("cleans with the current cleanup prompt and the channel's cleanup model", async () => {
    jest
      .mocked(cleanupContentTranscription)
      .mockResolvedValueOnce("First line.\nSecond line.");

    const cleaned = await cleanupWithCurrentSettings(row, mixed, signal);

    expect(cleaned).toBe("First line.\nSecond line.");
    const call = jest.mocked(getLangfuseChatPrompt).mock.calls.at(-1)?.[0];
    expect(call?.name).toBe(config.langfuse.transcriptionCleanupPromptName);
    expect(call?.variables).toMatchObject({
      transcription: mixed,
      serverName: "Server X",
      voiceChannelName: "Channel Y",
      roles: expect.stringContaining("Design"),
      formattedContext: expect.stringContaining("Server rules"),
    });
    const [meeting, , model] = jest.mocked(cleanupContentTranscription).mock
      .calls[0];
    expect(meeting).toMatchObject({
      meetingId: "meeting-1",
      creator: { id: "creator-1" },
      signal,
    });
    expect(model.model).toBe("channel-cleanup-model");
  });

  test("returns the transcript unchanged when current settings disable cleanup", async () => {
    scopedRuntimeConfig.premiumTranscription = {
      enabled: true,
      cleanupEnabled: false,
    };
    jest.mocked(cleanupContentTranscription).mockClear();

    await expect(cleanupWithCurrentSettings(row, mixed, signal)).resolves.toBe(
      mixed,
    );
    expect(cleanupContentTranscription).not.toHaveBeenCalled();
  });

  test("keeps the original text when the cleanup call fails", async () => {
    jest
      .mocked(cleanupContentTranscription)
      .mockRejectedValueOnce(new Error("provider down"));

    await expect(cleanupWithCurrentSettings(row, mixed, signal)).resolves.toBe(
      mixed,
    );
  });
});
