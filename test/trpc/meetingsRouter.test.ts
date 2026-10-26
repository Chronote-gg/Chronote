/** @jest-environment node */
import { beforeEach, describe, expect, test, jest } from "@jest/globals";
jest.mock("../../src/db", () => ({
  ...jest.requireActual("../../src/db"),
  getDeploymentControlRepository: () => ({
    checkAdmission: async () => ({ kind: "admitted" }),
  }),
}));
import { registerMeetingUpdateDeliveryDetailTests } from "./meetingUpdateDeliveryDetail.tests";
jest.mock("../../src/services/meetingUpdateService", () => ({
  updateMeeting: jest.fn(),
}));
import { updateMeeting } from "../../src/services/meetingUpdateService";
import {
  savedUpdate,
  expectSavedUpdateAcknowledgment,
} from "./meetingUpdateResult.fixture";
import { completedTextResponse } from "../../src/testSupport/openaiResponse";

import "../deployment/coldNetworkGuard.cjs";
import { verifyCorrectionDisconnect } from "../fixtures/correctionDisconnect";
import {
  updateDiscordMessage,
  createDiscordMessage,
  deleteDiscordMessage,
} from "../../src/services/discordMessageService";
jest.mock("../../src/services/discordMessageService", () => ({
  updateDiscordMessage: jest.fn(),
  createDiscordMessage: jest.fn(),
  deleteDiscordMessage: jest.fn(),
  fetchDiscordMessage: jest.fn(),
  updateDiscordMessageEmbeds: jest.fn(),
}));
import {
  fenceRuntimeWorkAdmissions,
  getRuntimeWorkAdmissionCheckpoints,
} from "../../src/services/runtimeWorkAdmissionService";
let mockApiEligible = true;
const mockApiSettled = jest.fn();
jest.mock("../../src/services/runtimeLifecycleService", () => ({
  beginRuntimeWork: () => {
    if (!mockApiEligible) throw new Error("Runtime warming");
    return { transition: () => {}, settle: mockApiSettled };
  },
  getRuntimeAdmissionContext: async () => ({ instanceId: "synthetic-api" }),
}));
import type { MeetingHistory } from "../../src/types/db";
import type { FeedbackRecord } from "../../src/types/db";
import type { MeetingEvent } from "../../src/types/meetingTimeline";
import { getMockUser } from "../../src/repositories/mockStore";
import { appRouter } from "../../src/trpc/router";
import {
  ensureManageGuildWithUserToken,
  ensureUserInGuild,
} from "../../src/services/guildAccessService";
import { getMeetingHistoryService } from "../../src/services/meetingHistoryService";
import { buildMeetingTimelineEventsFromHistory } from "../../src/services/meetingTimelineService";
import { getMeetingSummaryFeedback } from "../../src/services/summaryFeedbackService";
import { generateMeetingSummaries } from "../../src/services/meetingSummaryService";
import {
  fetchJsonFromS3,
  getSignedObjectUrl,
} from "../../src/services/storageService";
import { createOpenAIClient } from "../../src/services/openaiClient";
import { getLangfuseChatPrompt } from "../../src/services/langfusePromptService";
import {
  getModelChoice,
  type ModelChoice,
} from "../../src/services/modelFactory";
import {
  resolveChatParamsForRole,
  resolveModelParamsForContext,
} from "../../src/services/openaiModelParams";
import { resolveModelChoicesForContext } from "../../src/services/modelChoiceService";
import {
  ensureUserCanManageChannel,
  ensureUserCanViewChannel,
} from "../../src/services/discordPermissionsService";
import { ensureUserCanAccessMeeting } from "../../src/services/meetingAccessService";
import { checkUserMeetingAccess } from "../../src/services/meetingAccessService";
import { resolveMeetingArtifactAccess } from "../../src/services/meetingArtifactAccessService";
import { createDictionaryTeachingTokenStore } from "../../src/services/dictionaryTeachingTokenStore";
import {
  listBotGuildsCached,
  listGuildChannelsCached,
} from "../../src/services/discordCacheService";

jest.mock("../../src/services/guildAccessService", () => ({
  ensureManageGuildWithUserToken: jest.fn(),
  ensureUserInGuild: jest.fn(),
  ensureBotInGuild: jest.fn(),
}));

jest.mock("../../src/services/meetingHistoryService", () => ({
  getMeetingHistoryService: jest.fn(),
  listRecentMeetingsForGuildService: jest.fn(),
  updateMeetingArchiveService: jest.fn(),
}));

jest.mock("../../src/services/storageService", () => ({
  fetchJsonFromS3: jest.fn(),
  getSignedObjectUrl: jest.fn(),
}));

jest.mock("../../src/services/meetingTimelineService", () => ({
  // The real builder always returns an array, and the detail route now maps
  // over it to resolve mentions in event text.
  buildMeetingTimelineEventsFromHistory: jest.fn(() => []),
}));

jest.mock("../../src/services/summaryFeedbackService", () => ({
  getMeetingSummaryFeedback: jest.fn(),
}));

jest.mock("../../src/services/meetingSummaryService", () => ({
  generateMeetingSummaries: jest.fn(),
}));

jest.mock("../../src/services/openaiClient", () => ({
  createOpenAIClient: jest.fn(),
}));

jest.mock("../../src/services/langfusePromptService", () => ({
  getLangfuseChatPrompt: jest.fn(),
}));

jest.mock("../../src/services/modelFactory", () => ({
  buildModelOverrides: jest.fn((value) => value),
  getModelChoice: jest.fn(),
}));

jest.mock("../../src/services/openaiModelParams", () => ({
  resolveChatParamsForRole: jest.fn(),
  resolveModelParamsForContext: jest.fn(),
}));

jest.mock("../../src/services/modelChoiceService", () => ({
  resolveModelChoicesForContext: jest.fn(),
}));

jest.mock("../../src/services/discordPermissionsService", () => ({
  ensureUserCanViewChannel: jest.fn(),
  ensureUserCanManageChannel: jest.fn(),
}));

jest.mock("../../src/services/meetingAccessService", () => ({
  ensureUserCanAccessMeeting: jest.fn(),
  checkUserMeetingAccess: jest.fn(),
  resolvePersonalMeetingSharedGuildIds: jest.fn(async () => undefined),
}));

jest.mock("../../src/services/meetingArtifactAccessService", () => ({
  resolveMeetingArtifactAccess: jest.fn(),
  resolveServerMeetingArtifactAccess: jest.fn(),
}));

jest.mock("../../src/services/discordCacheService", () => ({
  listBotGuildsCached: jest.fn(),
  listGuildChannelsCached: jest.fn(),
  listGuildRolesCached: async () => [],
}));

import { buildCaller } from "../utils/trpcCaller";

describe("meetings router detail", () => {
  const mockedEnsureManageGuild = jest.mocked(ensureManageGuildWithUserToken);
  const mockedEnsureUserInGuild = jest.mocked(ensureUserInGuild);
  const mockedGetMeetingHistory = jest.mocked(getMeetingHistoryService);
  const mockedFetchJsonFromS3 = jest.mocked(fetchJsonFromS3);
  const mockedGetSignedObjectUrl = jest.mocked(getSignedObjectUrl);
  const mockedBuildTimeline = jest.mocked(
    buildMeetingTimelineEventsFromHistory,
  );
  const mockedGetSummaryFeedback = jest.mocked(getMeetingSummaryFeedback);
  const mockedEnsureMeetingAccess = jest.mocked(ensureUserCanAccessMeeting);
  const mockedCheckMeetingAccess = jest.mocked(checkUserMeetingAccess);
  const mockedListGuildChannels = jest.mocked(listGuildChannelsCached);
  const mockedResolveMeetingArtifactAccess = jest.mocked(
    resolveMeetingArtifactAccess,
  );

  beforeEach(() => {
    jest.resetAllMocks();
    // The real builder always returns an array, and the detail route maps over
    // it to resolve mentions in event text.
    mockedBuildTimeline.mockReturnValue([]);
    mockedEnsureManageGuild.mockResolvedValue(true);
    mockedEnsureUserInGuild.mockResolvedValue(true);
    mockedEnsureMeetingAccess.mockResolvedValue(true);
    mockedCheckMeetingAccess.mockResolvedValue({
      allowed: true,
      via: "channel_permissions",
    });
    mockedListGuildChannels.mockResolvedValue([
      { id: "channel-1", name: "voice", type: 2 },
    ]);
    mockedResolveMeetingArtifactAccess.mockResolvedValue({
      transcriptAccessEnabled: true,
      audioAccessEnabled: true,
    });
  });

  registerMeetingUpdateDeliveryDetailTests((row) => {
    mockedGetMeetingHistory.mockResolvedValue(row);
  });

  test("returns transcript, audio url, and summary feedback", async () => {
    const meetingId = "channel-1#2025-01-01T00:00:00.000Z";
    const history: MeetingHistory = {
      guildId: "guild-1",
      channelId_timestamp: meetingId,
      meetingId: "meeting-1",
      channelId: "channel-1",
      timestamp: "2025-01-01T00:00:00.000Z",
      participants: [{ id: "user-1", username: "Tester" }],
      duration: 1800,
      transcribeMeeting: true,
      generateNotes: true,
      notes: "Summary: weekly sync",
      transcriptS3Key: "transcripts/meeting-1.json",
      audioS3Key: "audio/meeting-1.mp3",
    };

    const transcriptPayload = { text: "Transcript text" };
    const events: MeetingEvent[] = [
      {
        id: "event-1",
        type: "voice",
        time: "2025-01-01T00:10:00.000Z",
        text: "Hello team",
      },
    ];

    mockedGetMeetingHistory.mockResolvedValue(history);
    mockedFetchJsonFromS3.mockResolvedValueOnce(transcriptPayload);
    mockedGetSignedObjectUrl.mockResolvedValue("https://example.com/audio.mp3");
    mockedBuildTimeline.mockReturnValue(events);
    const feedback: FeedbackRecord = {
      pk: "pk",
      sk: "sk",
      type: "feedback",
      targetType: "meeting_summary",
      targetId: meetingId,
      guildId: "guild-1",
      channelId: "channel-1",
      rating: "down",
      source: "web",
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
      userId: getMockUser().id,
    };
    mockedGetSummaryFeedback.mockResolvedValue(feedback);

    const result = await buildCaller().meetings.detail({
      serverId: "guild-1",
      meetingId,
    });

    expect(result.meeting.transcript).toBe("Transcript text");
    expect(result.meeting.audioUrl).toBe("https://example.com/audio.mp3");
    expect(result.meeting.summaryFeedback).toBe("down");
    expect(result.meeting.events).toEqual(events);
    expect(mockedGetSummaryFeedback).toHaveBeenCalledWith({
      channelIdTimestamp: meetingId,
      userId: getMockUser().id,
    });
  });

  test("returns persisted processing after access checks", async () => {
    const meetingId = "channel-1#2025-01-01T00:00:00.000Z";
    const history: MeetingHistory = {
      guildId: "guild-1",
      channelId_timestamp: meetingId,
      meetingId: "meeting-1",
      channelId: "channel-1",
      timestamp: "2025-01-01T00:00:00.000Z",
      participants: [],
      duration: 60,
      transcribeMeeting: true,
      generateNotes: true,
      notes: "",
      processing: { transcription: "empty", notes: "skipped" },
    };
    mockedGetMeetingHistory.mockResolvedValue(history);

    const result = await buildCaller().meetings.detail({
      serverId: "guild-1",
      meetingId,
    });

    expect(result.meeting.processing).toEqual(history.processing);
    expect(result.meeting.notes).toBe("");
    expect(mockedCheckMeetingAccess).toHaveBeenCalled();
  });

  test("withholds transcript and audio when server artifact access is disabled", async () => {
    const meetingId = "channel-1#2025-01-01T00:00:00.000Z";
    mockedGetMeetingHistory.mockResolvedValue({
      guildId: "guild-1",
      channelId_timestamp: meetingId,
      meetingId: "meeting-1",
      channelId: "channel-1",
      timestamp: "2025-01-01T00:00:00.000Z",
      participants: [],
      duration: 1800,
      transcribeMeeting: true,
      generateNotes: true,
      notes: "Summary remains available",
      transcriptS3Key: "transcripts/meeting-1.json",
      audioS3Key: "audio/meeting-1.mp3",
    });
    mockedResolveMeetingArtifactAccess.mockResolvedValue({
      transcriptAccessEnabled: false,
      audioAccessEnabled: false,
    });

    const result = await buildCaller().meetings.detail({
      serverId: "guild-1",
      meetingId,
    });

    expect(result.meeting).toMatchObject({
      notes: "Summary remains available",
      transcript: "",
      transcriptAccessEnabled: false,
      audioUrl: undefined,
      audioAccessEnabled: false,
      events: [],
    });
    expect(mockedFetchJsonFromS3).not.toHaveBeenCalled();
    expect(mockedGetSignedObjectUrl).not.toHaveBeenCalled();
    expect(mockedBuildTimeline).not.toHaveBeenCalled();
  });

  test("throws NOT_FOUND when meeting history is missing", async () => {
    mockedGetMeetingHistory.mockResolvedValue(undefined);

    await expect(
      buildCaller().meetings.detail({
        serverId: "guild-1",
        meetingId: "missing-meeting",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  test("uses meeting access checks without requiring current guild membership", async () => {
    const meetingId = "channel-1#2025-01-01T00:00:00.000Z";
    const history: MeetingHistory = {
      guildId: "guild-1",
      channelId_timestamp: meetingId,
      meetingId: "meeting-1",
      channelId: "channel-1",
      timestamp: "2025-01-01T00:00:00.000Z",
      participants: [{ id: getMockUser().id, username: "Tester" }],
      duration: 1800,
      transcribeMeeting: true,
      generateNotes: true,
      notes: "Summary: private sync",
    };
    mockedEnsureUserInGuild.mockResolvedValue(false);
    mockedGetMeetingHistory.mockResolvedValue(history);

    const result = await buildCaller().meetings.detail({
      serverId: "guild-1",
      meetingId,
    });

    expect(result.meeting.id).toBe(meetingId);
    expect(mockedEnsureUserInGuild).not.toHaveBeenCalled();
    expect(mockedCheckMeetingAccess).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: "guild-1",
        meeting: history,
        userId: getMockUser().id,
      }),
    );
  });

  test("throws FORBIDDEN when meeting access denies the direct detail request", async () => {
    const meetingId = "channel-1#2025-01-01T00:00:00.000Z";
    mockedGetMeetingHistory.mockResolvedValue({
      guildId: "guild-1",
      channelId_timestamp: meetingId,
      meetingId: "meeting-1",
      channelId: "channel-1",
      timestamp: "2025-01-01T00:00:00.000Z",
      participants: [],
      duration: 1800,
      transcribeMeeting: true,
      generateNotes: true,
      notes: "Summary: private sync",
    });
    mockedCheckMeetingAccess.mockResolvedValueOnce({
      allowed: false,
      missing: ["voice_connect"],
    });

    await expect(
      buildCaller().meetings.detail({
        serverId: "guild-1",
        meetingId,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("meetings notes correction mutations", () => {
  const mockedEnsureManageGuild = jest.mocked(ensureManageGuildWithUserToken);
  const mockedEnsureUserInGuild = jest.mocked(ensureUserInGuild);
  const mockedGetMeetingHistory = jest.mocked(getMeetingHistoryService);
  const mockedFetchJsonFromS3 = jest.mocked(fetchJsonFromS3);
  const mockedGenerateMeetingSummaries = jest.mocked(generateMeetingSummaries);
  const mockedCreateOpenAIClient = jest.mocked(createOpenAIClient);
  const mockedGetLangfuseChatPrompt = jest.mocked(getLangfuseChatPrompt);
  const mockedGetModelChoice = jest.mocked(getModelChoice);
  const mockedResolveChatParamsForRole = jest.mocked(resolveChatParamsForRole);
  const mockedResolveModelParamsForContext = jest.mocked(
    resolveModelParamsForContext,
  );
  const mockedResolveModelChoicesForContext = jest.mocked(
    resolveModelChoicesForContext,
  );
  const mockedEnsureUserCanViewChannel = jest.mocked(ensureUserCanViewChannel);
  const mockedEnsureUserCanManageChannel = jest.mocked(
    ensureUserCanManageChannel,
  );
  const mockedEnsureMeetingAccess = jest.mocked(ensureUserCanAccessMeeting);
  const mockedCheckMeetingAccess = jest.mocked(checkUserMeetingAccess);
  const mockedListBotGuilds = jest.mocked(listBotGuildsCached);
  const mockedListGuildChannels = jest.mocked(listGuildChannelsCached);
  const mockedResolveMeetingArtifactAccess = jest.mocked(
    resolveMeetingArtifactAccess,
  );

  const mockedUpdateMeeting = jest.mocked(updateMeeting);

  beforeEach(() => {
    jest.resetAllMocks();
    mockedEnsureManageGuild.mockResolvedValue(true);
    mockedEnsureUserInGuild.mockResolvedValue(true);
    mockedEnsureUserCanViewChannel.mockResolvedValue(true);
    mockedEnsureUserCanManageChannel.mockResolvedValue(true);
    mockedEnsureMeetingAccess.mockResolvedValue(true);
    mockedCheckMeetingAccess.mockResolvedValue({
      allowed: true,
      via: "channel_permissions",
    });
    mockedListBotGuilds.mockResolvedValue([
      { id: "guild-1", name: "Mock guild" },
    ]);
    mockedListGuildChannels.mockResolvedValue([
      { id: "channel-1", name: "voice", type: 2 },
      { id: "text-1", name: "notes", type: 0 },
    ]);
    mockedResolveMeetingArtifactAccess.mockResolvedValue({
      transcriptAccessEnabled: true,
      audioAccessEnabled: true,
    });
    mockedGetLangfuseChatPrompt.mockResolvedValue({
      messages: [{ role: "user", content: "prompt" }],
      langfusePrompt: undefined,
      source: "fallback",
    });
    const modelChoice: ModelChoice = { provider: "openai", model: "gpt-test" };
    mockedGetModelChoice.mockReturnValue(modelChoice);
    mockedResolveChatParamsForRole.mockReturnValue({});
    mockedResolveModelParamsForContext.mockResolvedValue({
      meetingSummary: {
        samplingMode: "reasoning",
        reasoningEffort: "none",
      },
      notesCorrection: {
        samplingMode: "reasoning",
        reasoningEffort: "none",
      },
    });
    mockedResolveModelChoicesForContext.mockResolvedValue({
      meetingSummary: undefined,
      notesCorrection: undefined,
    });
    const createResponse = jest.fn(async () =>
      completedTextResponse("Updated notes"),
    );
    mockedCreateOpenAIClient.mockReturnValue({
      responses: { create: createResponse },
    } as unknown as ReturnType<typeof createOpenAIClient>);
    mockedGenerateMeetingSummaries.mockResolvedValue({
      summarySentence: "New summary sentence",
      summaryLabel: "New summary label",
    });
  });

  test("actual HTTP correction remains owned after disconnect and cannot publish after shutdown", async () => {
    let release!: (value: unknown) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const provider = new Promise((resolve) => {
      release = resolve;
    });
    mockedGetMeetingHistory.mockResolvedValue({
      guildId: "guild-1",
      channelId_timestamp: "channel-1#2025-01-01",
      meetingId: "synthetic",
      notes: "Original",
      notesVersion: 1,
    } as MeetingHistory);
    mockedCreateOpenAIClient.mockReturnValue({
      responses: {
        create: () => {
          entered();
          return provider;
        },
      },
    } as unknown as ReturnType<typeof createOpenAIClient>);
    await verifyCorrectionDisconnect({
      router: appRouter,
      started,
      settled: mockApiSettled,
      release,
    });
  });
  test("warm correction router rejects before history/provider dispatch", async () => {
    mockApiEligible = false;
    try {
      await expect(
        buildCaller().meetings.suggestNotesCorrection({
          serverId: "guild-1",
          meetingId: "channel-1#2025-01-01",
          suggestion: "Fix",
        }),
      ).rejects.toThrow();
      expect(mockedGetMeetingHistory).not.toHaveBeenCalled();
      expect(mockedCreateOpenAIClient).not.toHaveBeenCalled();
    } finally {
      mockApiEligible = true;
    }
  });
  test.each([true, false])(
    "actual canonical action ACK=%s retains request ownership without caller Discord mutations",
    async (acknowledged) => {
      const meetingId = "channel-1#2025-01-01";
      mockedGetMeetingHistory.mockResolvedValue({
        guildId: "guild-1",
        channelId_timestamp: meetingId,
        channelId: "channel-1",
        meetingId: "synthetic",
        notes: "Original",
        notesVersion: 1,
        notesChannelId: "synthetic-text",
        notesMessageIds: ["synthetic-old"],
      } as MeetingHistory);
      const token = await buildCaller().meetings.suggestNotesCorrection({
        serverId: "guild-1",
        meetingId,
        suggestion: "Fix",
      });
      let release!: () => void,
        reject!: (error: Error) => void,
        entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      mockedUpdateMeeting.mockImplementationOnce((input) => {
        if (!input.operation)
          throw new Error("Correction action requires runtime operation");
        return input.operation.mutate(() => {
          entered();
          return new Promise<ReturnType<typeof savedUpdate>>(
            (resolve, fail) => {
              release = () => resolve(savedUpdate());
              reject = fail;
            },
          );
        });
      });
      const previous = new Set(
        getRuntimeWorkAdmissionCheckpoints().map((entry) => entry.id),
      );
      const task = buildCaller()
        .meetings.applyNotesCorrection({
          serverId: "guild-1",
          meetingId,
          token: token.token,
        })
        .catch((error: unknown) => error);
      try {
        await started;
        const claim = getRuntimeWorkAdmissionCheckpoints().find(
          (entry) => !previous.has(entry.id),
        );
        expect(claim?.effects.length).toBeGreaterThan(0);
        fenceRuntimeWorkAdmissions();
        if (acknowledged) release();
        else reject(new Error("Synthetic lost canonical ACK"));
        await task;
        expect(
          getRuntimeWorkAdmissionCheckpoints().some(
            (entry) => entry.id === claim?.id,
          ),
        ).toBe(!acknowledged);
        expect(updateDiscordMessage).not.toHaveBeenCalled();
        expect(createDiscordMessage).not.toHaveBeenCalled();
        expect(deleteDiscordMessage).not.toHaveBeenCalled();
      } finally {
        release();
        await task;
      }
    },
  );
  test("suggestNotesCorrection returns a diff and token", async () => {
    const meetingId = "channel-1#2025-01-01T00:00:00.000Z";
    mockedGetMeetingHistory.mockResolvedValue({
      guildId: "guild-1",
      channelId_timestamp: meetingId,
      meetingId: "meeting-1",
      channelId: "channel-1",
      timestamp: "2025-01-01T00:00:00.000Z",
      duration: 1800,
      transcribeMeeting: true,
      generateNotes: true,
      notes: "Old notes",
      transcriptS3Key: "transcripts/meeting-1.json",
      notesVersion: 1,
    } as unknown as MeetingHistory);

    mockedFetchJsonFromS3.mockResolvedValueOnce({ text: "Transcript" });

    const result = await buildCaller().meetings.suggestNotesCorrection({
      serverId: "guild-1",
      meetingId,
      suggestion: "Fix that one thing",
    });

    expect(result.token).toEqual(expect.any(String));
    expect(result.changed).toBe(true);
    expect(result.diff).toContain("- Old notes");
    expect(result.diff).toContain("+ Updated notes");
  });

  test("suggestNotesCorrection caps the diff line count", async () => {
    const meetingId = "channel-1#2025-01-01T00:00:00.000Z";
    mockedGetMeetingHistory.mockResolvedValue({
      guildId: "guild-1",
      channelId_timestamp: meetingId,
      meetingId: "meeting-1",
      channelId: "channel-1",
      timestamp: "2025-01-01T00:00:00.000Z",
      duration: 1800,
      transcribeMeeting: true,
      generateNotes: true,
      notes: "Old notes",
      transcriptS3Key: "transcripts/meeting-1.json",
      notesVersion: 1,
    } as unknown as MeetingHistory);

    mockedFetchJsonFromS3.mockResolvedValueOnce({ text: "Transcript" });

    const updated = Array.from(
      { length: 1000 },
      (_, idx) => `Line ${idx + 1}`,
    ).join("\n");
    mockedCreateOpenAIClient.mockReturnValue({
      responses: { create: async () => completedTextResponse(updated) },
    } as unknown as ReturnType<typeof createOpenAIClient>);

    const result = await buildCaller().meetings.suggestNotesCorrection({
      serverId: "guild-1",
      meetingId,
      suggestion: "Make it long",
    });

    expect(result.changed).toBe(true);
    expect(result.diff.split("\n").length).toBe(600);
  });

  test("suggestNotesCorrection preserves blank-line changes in diff", async () => {
    const meetingId = "channel-1#2025-01-01T00:00:00.000Z";
    mockedGetMeetingHistory.mockResolvedValue({
      guildId: "guild-1",
      channelId_timestamp: meetingId,
      meetingId: "meeting-1",
      channelId: "channel-1",
      timestamp: "2025-01-01T00:00:00.000Z",
      duration: 1800,
      transcribeMeeting: true,
      generateNotes: true,
      notes: "Line 1\nLine 2",
      transcriptS3Key: "transcripts/meeting-1.json",
      notesVersion: 1,
    } as unknown as MeetingHistory);

    mockedFetchJsonFromS3.mockResolvedValueOnce({ text: "Transcript" });

    const createResponse = jest.fn(async () =>
      completedTextResponse("Line 1\n\nLine 2"),
    );
    mockedCreateOpenAIClient.mockReturnValue({
      responses: { create: createResponse },
    } as unknown as ReturnType<typeof createOpenAIClient>);

    const result = await buildCaller().meetings.suggestNotesCorrection({
      serverId: "guild-1",
      meetingId,
      suggestion: "Insert a blank line",
    });

    expect(result.changed).toBe(true);
    expect(result.diff.length).toBeGreaterThan(0);
    expect(result.diff.split("\n").some((line) => line === "+ ")).toBe(true);
  });

  test("suggestNotesCorrection throws when generation fails", async () => {
    const meetingId = "channel-1#2025-01-01T00:00:00.000Z";
    mockedGetMeetingHistory.mockResolvedValue({
      guildId: "guild-1",
      channelId_timestamp: meetingId,
      meetingId: "meeting-1",
      channelId: "channel-1",
      timestamp: "2025-01-01T00:00:00.000Z",
      duration: 1800,
      transcribeMeeting: true,
      generateNotes: true,
      notes: "Old notes",
      transcriptS3Key: "transcripts/meeting-1.json",
      notesVersion: 1,
    } as unknown as MeetingHistory);

    mockedFetchJsonFromS3.mockResolvedValueOnce({ text: "Transcript" });

    mockedCreateOpenAIClient.mockReturnValue({
      responses: {
        create: async () => {
          throw new Error("boom");
        },
      },
    } as unknown as ReturnType<typeof createOpenAIClient>);

    await expect(
      buildCaller().meetings.suggestNotesCorrection({
        serverId: "guild-1",
        meetingId,
        suggestion: "Fix it",
      }),
    ).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
  });

  test("applyNotesCorrection recomputes summary and clears pending on conflict", async () => {
    const meetingId = "channel-1#2025-01-01T00:00:00.000Z";
    mockedGetMeetingHistory.mockResolvedValue({
      guildId: "guild-1",
      channelId_timestamp: meetingId,
      meetingId: "meeting-1",
      channelId: "channel-1",
      timestamp: "2025-01-01T00:00:00.000Z",
      duration: 1800,
      transcribeMeeting: true,
      generateNotes: true,
      notes: "Old notes",
      transcriptS3Key: "transcripts/meeting-1.json",
      notesVersion: 1,
      summarySentence: "Prev sentence",
      summaryLabel: "Prev label",
    } as unknown as MeetingHistory);

    mockedFetchJsonFromS3.mockResolvedValueOnce({ text: "Transcript" });

    const suggestion = await buildCaller().meetings.suggestNotesCorrection({
      serverId: "guild-1",
      meetingId,
      suggestion: "Fix it",
    });

    mockedUpdateMeeting.mockResolvedValueOnce({ kind: "conflict" });
    await expect(
      buildCaller().meetings.applyNotesCorrection({
        serverId: "guild-1",
        meetingId,
        token: suggestion.token,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    await expect(
      buildCaller().meetings.applyNotesCorrection({
        serverId: "guild-1",
        meetingId,
        token: suggestion.token,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  test("applyNotesCorrection records provenance and offers bounded teaching context", async () => {
    const meetingId = "channel-1#2025-01-01T00:00:00.000Z";
    mockedGetMeetingHistory.mockResolvedValue({
      guildId: "guild-1",
      channelId_timestamp: meetingId,
      meetingId: "meeting-1",
      channelId: "channel-1",
      timestamp: "2025-01-01T00:00:00.000Z",
      duration: 1800,
      transcribeMeeting: true,
      generateNotes: true,
      notes: "John Smith owns the Apollo rollout.",
      transcriptS3Key: "transcripts/meeting-1.json",
      notesVersion: 3,
      summarySentence: "Previous summary",
      summaryLabel: "Apollo rollout",
    } as unknown as MeetingHistory);
    mockedFetchJsonFromS3.mockResolvedValueOnce({
      text: "Jon Smythe from Apollo owns the rollout.",
    });
    const createResponse = jest.fn(async () =>
      completedTextResponse("Jon Smythe owns the Apollo rollout."),
    );
    mockedCreateOpenAIClient.mockReturnValue({
      responses: { create: createResponse },
    } as unknown as ReturnType<typeof createOpenAIClient>);

    const suggestion = await buildCaller().meetings.suggestNotesCorrection({
      serverId: "guild-1",
      meetingId,
      suggestion: "John Smith should be Jon Smythe.",
    });
    mockedUpdateMeeting.mockResolvedValueOnce(savedUpdate());

    const result = await buildCaller().meetings.applyNotesCorrection({
      serverId: "guild-1",
      meetingId,
      token: suggestion.token,
    });

    expect(result.dictionaryTeachingContextToken).toEqual(expect.any(String));
    expect(result.dictionaryTeachingContextExpiresAtMs).toEqual(
      expect.any(Number),
    );
    expect(result.dictionaryTeachingInstruction).toBe(
      "John Smith should be Jon Smythe.",
    );
    expect(mockedUpdateMeeting).toHaveBeenCalledWith(
      expect.objectContaining({
        mutation: expect.objectContaining({ kind: "correction" }),
        notesEdit: expect.objectContaining({
          expectedNotesVersion: 3,
          source: {
            type: "notes_correction",
            correctionId: expect.any(String),
          },
          suggestion: expect.objectContaining({
            correctionId: expect.any(String),
            source: "web",
            baseNotesVersion: 3,
            resultingNotesVersion: 4,
          }),
        }),
        signal: expect.any(AbortSignal),
        operation: expect.objectContaining({ signal: expect.any(AbortSignal) }),
      }),
    );
  });

  test("omits transcript excerpts from teaching context when transcript access is disabled", async () => {
    const meetingId = "channel-1#2025-01-01T00:00:00.000Z";
    mockedGetMeetingHistory.mockResolvedValue({
      guildId: "guild-1",
      channelId_timestamp: meetingId,
      meetingId: "meeting-1",
      channelId: "channel-1",
      timestamp: "2025-01-01T00:00:00.000Z",
      duration: 1800,
      transcribeMeeting: true,
      generateNotes: true,
      notes: "John Smith owns the Apollo rollout.",
      transcriptS3Key: "transcripts/meeting-1.json",
      notesVersion: 3,
    } as unknown as MeetingHistory);
    mockedFetchJsonFromS3.mockResolvedValueOnce({
      text: "Jon Smythe from Apollo owns the rollout.",
    });
    mockedResolveMeetingArtifactAccess.mockResolvedValue({
      transcriptAccessEnabled: false,
      audioAccessEnabled: true,
    });
    mockedUpdateMeeting.mockResolvedValueOnce(savedUpdate());

    const suggestion = await buildCaller().meetings.suggestNotesCorrection({
      serverId: "guild-1",
      meetingId,
      suggestion: "John Smith should be Jon Smythe.",
    });
    const result = await buildCaller().meetings.applyNotesCorrection({
      serverId: "guild-1",
      meetingId,
      token: suggestion.token,
    });

    const context = await createDictionaryTeachingTokenStore({
      maxPending: 200,
    }).getContext(result.dictionaryTeachingContextToken!);
    expect(context?.context.notesDiff).toBeTruthy();
    expect(context?.context.transcriptExcerpt).toBeUndefined();
  });

  test("does not retain dictionary teaching context for a correction requester without Manage Server", async () => {
    const meetingId = "channel-1#2025-01-01T00:00:00.000Z";
    const user = getMockUser();
    mockedGetMeetingHistory.mockResolvedValue({
      guildId: "guild-1",
      channelId_timestamp: meetingId,
      meetingId: "meeting-1",
      channelId: "channel-1",
      timestamp: "2025-01-01T00:00:00.000Z",
      duration: 1800,
      transcribeMeeting: true,
      generateNotes: true,
      notes: "John Smith owns the Apollo rollout.",
      transcriptS3Key: "transcripts/meeting-1.json",
      notesVersion: 1,
      meetingCreatorId: user.id,
    } as unknown as MeetingHistory);
    mockedFetchJsonFromS3.mockResolvedValueOnce({
      text: "Jon Smythe owns the Apollo rollout.",
    });
    mockedUpdateMeeting.mockResolvedValueOnce(savedUpdate());
    mockedEnsureManageGuild.mockResolvedValue(false);

    const suggestion = await buildCaller(user).meetings.suggestNotesCorrection({
      serverId: "guild-1",
      meetingId,
      suggestion: "John Smith should be Jon Smythe.",
    });
    const result = await buildCaller(user).meetings.applyNotesCorrection({
      serverId: "guild-1",
      meetingId,
      token: suggestion.token,
    });

    expect(result).toEqual({
      ok: true,
      kind: "saved",
      delivery: savedUpdate().delivery,
      dictionaryTeachingContextToken: undefined,
      dictionaryTeachingContextExpiresAtMs: undefined,
      dictionaryTeachingInstruction: "John Smith should be Jon Smythe.",
    });
  });

  test("applyNotesCorrection rejects applying someone else's token", async () => {
    const meetingId = "channel-1#2025-01-01T00:00:00.000Z";
    mockedGetMeetingHistory.mockResolvedValue({
      guildId: "guild-1",
      channelId_timestamp: meetingId,
      meetingId: "meeting-1",
      channelId: "channel-1",
      timestamp: "2025-01-01T00:00:00.000Z",
      duration: 1800,
      transcribeMeeting: true,
      generateNotes: true,
      notes: "Old notes",
      transcriptS3Key: "transcripts/meeting-1.json",
      notesVersion: 1,
    } as unknown as MeetingHistory);

    mockedFetchJsonFromS3.mockResolvedValueOnce({ text: "Transcript" });
    const suggestion = await buildCaller().meetings.suggestNotesCorrection({
      serverId: "guild-1",
      meetingId,
      suggestion: "Fix it",
    });

    const otherUser = {
      ...getMockUser(),
      id: "other-user",
      username: "OtherUser",
    };

    await expect(
      buildCaller(otherUser).meetings.applyNotesCorrection({
        serverId: "guild-1",
        meetingId,
        token: suggestion.token,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("meetings updateNotes mutation", () => {
  const mockedEnsureUserInGuild = jest.mocked(
    (
      jest.requireMock("../../src/services/guildAccessService") as {
        ensureUserInGuild: typeof import("../../src/services/guildAccessService").ensureUserInGuild;
      }
    ).ensureUserInGuild,
  );
  const mockedGetMeetingHistory = jest.mocked(getMeetingHistoryService);
  const mockedEnsureUserCanViewChannel = jest.mocked(ensureUserCanViewChannel);
  const mockedEnsureUserCanManageChannel = jest.mocked(
    ensureUserCanManageChannel,
  );
  const mockedCheckMeetingAccess = jest.mocked(checkUserMeetingAccess);
  const mockedUpdateMeeting = jest.mocked(updateMeeting);

  beforeEach(() => {
    jest.resetAllMocks();
    mockedEnsureUserInGuild.mockResolvedValue(true);
    mockedEnsureUserCanViewChannel.mockResolvedValue(true);
    mockedEnsureUserCanManageChannel.mockResolvedValue(true);
    mockedCheckMeetingAccess.mockResolvedValue({
      allowed: true,
      via: "channel_permissions",
    });
    mockedUpdateMeeting.mockResolvedValue(savedUpdate());
  });

  test("saves notes for the meeting starter", async () => {
    const meetingId = "channel-1#2025-01-01T00:00:00.000Z";
    const user = getMockUser();
    mockedGetMeetingHistory.mockResolvedValue({
      guildId: "guild-1",
      channelId_timestamp: meetingId,
      meetingId: "meeting-1",
      channelId: "channel-1",
      timestamp: "2025-01-01T00:00:00.000Z",
      duration: 1800,
      transcribeMeeting: true,
      generateNotes: true,
      notes: "Old notes",
      transcriptS3Key: "transcripts/meeting-1.json",
      meetingCreatorId: user.id,
      notesVersion: 3,
    } as unknown as MeetingHistory);

    const delta = { ops: [{ insert: "Hello\n" }] };
    const result = await buildCaller(user).meetings.updateNotes({
      serverId: "guild-1",
      meetingId,
      delta,
      expectedPreviousVersion: 3,
    });

    expectSavedUpdateAcknowledgment(result);
    expect(updateMeeting).toHaveBeenCalled();
    expect(mockedUpdateMeeting).toHaveBeenCalledWith(
      expect.objectContaining({
        key: { guildId: "guild-1", channelId_timestamp: meetingId },
        mutation: { kind: "notes", notes: "Hello", notesDelta: delta },
        actor: { editedBy: user.id },
        notesEdit: { expectedNotesVersion: 3, source: { type: "web_editor" } },
      }),
    );
  });

  test("rejects version mismatch with CONFLICT", async () => {
    const meetingId = "channel-1#2025-01-01T00:00:00.000Z";
    const user = getMockUser();
    mockedGetMeetingHistory.mockResolvedValue({
      guildId: "guild-1",
      channelId_timestamp: meetingId,
      meetingId: "meeting-1",
      channelId: "channel-1",
      timestamp: "2025-01-01T00:00:00.000Z",
      duration: 1800,
      transcribeMeeting: true,
      generateNotes: true,
      notes: "Old notes",
      transcriptS3Key: "transcripts/meeting-1.json",
      meetingCreatorId: user.id,
      notesVersion: 3,
    } as unknown as MeetingHistory);

    await expect(
      buildCaller(user).meetings.updateNotes({
        serverId: "guild-1",
        meetingId,
        delta: { ops: [{ insert: "Hello\n" }] },
        expectedPreviousVersion: 2,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(mockedUpdateMeeting).not.toHaveBeenCalled();
  });

  test("forbids non-owner edits when not auto-recorded", async () => {
    const meetingId = "channel-1#2025-01-01T00:00:00.000Z";
    mockedGetMeetingHistory.mockResolvedValue({
      guildId: "guild-1",
      channelId_timestamp: meetingId,
      meetingId: "meeting-1",
      channelId: "channel-1",
      timestamp: "2025-01-01T00:00:00.000Z",
      duration: 1800,
      transcribeMeeting: true,
      generateNotes: true,
      notes: "Old notes",
      transcriptS3Key: "transcripts/meeting-1.json",
      meetingCreatorId: "someone-else",
      isAutoRecording: false,
      notesVersion: 3,
    } as unknown as MeetingHistory);

    await expect(
      buildCaller().meetings.updateNotes({
        serverId: "guild-1",
        meetingId,
        delta: { ops: [{ insert: "Hello\n" }] },
        expectedPreviousVersion: 3,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  test("allows ManageChannel edits when auto-recorded", async () => {
    const meetingId = "channel-1#2025-01-01T00:00:00.000Z";
    const user = getMockUser();
    mockedGetMeetingHistory.mockResolvedValue({
      guildId: "guild-1",
      channelId_timestamp: meetingId,
      meetingId: "meeting-1",
      channelId: "channel-1",
      timestamp: "2025-01-01T00:00:00.000Z",
      duration: 1800,
      transcribeMeeting: true,
      generateNotes: true,
      notes: "Old notes",
      transcriptS3Key: "transcripts/meeting-1.json",
      meetingCreatorId: "someone-else",
      isAutoRecording: true,
      notesVersion: 1,
    } as unknown as MeetingHistory);

    const result = await buildCaller(user).meetings.updateNotes({
      serverId: "guild-1",
      meetingId,
      delta: { ops: [{ insert: "Hello\n" }] },
      expectedPreviousVersion: 1,
    });

    expectSavedUpdateAcknowledgment(result);
    expect(mockedEnsureUserCanManageChannel).toHaveBeenCalled();
  });

  test("rejects oversized delta payload", async () => {
    const meetingId = "channel-1#2025-01-01T00:00:00.000Z";
    const user = getMockUser();
    mockedGetMeetingHistory.mockResolvedValue({
      guildId: "guild-1",
      channelId_timestamp: meetingId,
      meetingId: "meeting-1",
      channelId: "channel-1",
      timestamp: "2025-01-01T00:00:00.000Z",
      duration: 1800,
      transcribeMeeting: true,
      generateNotes: true,
      notes: "Old notes",
      transcriptS3Key: "transcripts/meeting-1.json",
      meetingCreatorId: user.id,
      notesVersion: 1,
    } as unknown as MeetingHistory);

    await expect(
      buildCaller(user).meetings.updateNotes({
        serverId: "guild-1",
        meetingId,
        delta: { ops: [{ insert: "a".repeat(100_000) }] },
        expectedPreviousVersion: 1,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  test("rejects empty markdown output", async () => {
    const meetingId = "channel-1#2025-01-01T00:00:00.000Z";
    const user = getMockUser();
    mockedGetMeetingHistory.mockResolvedValue({
      guildId: "guild-1",
      channelId_timestamp: meetingId,
      meetingId: "meeting-1",
      channelId: "channel-1",
      timestamp: "2025-01-01T00:00:00.000Z",
      duration: 1800,
      transcribeMeeting: true,
      generateNotes: true,
      notes: "Old notes",
      transcriptS3Key: "transcripts/meeting-1.json",
      meetingCreatorId: user.id,
      notesVersion: 1,
    } as unknown as MeetingHistory);

    await expect(
      buildCaller(user).meetings.updateNotes({
        serverId: "guild-1",
        meetingId,
        delta: { ops: [{ insert: "\n" }] },
        expectedPreviousVersion: 1,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("meetings importNotes mutation", () => {
  const mockedEnsureUserInGuild = jest.mocked(
    (
      jest.requireMock("../../src/services/guildAccessService") as {
        ensureUserInGuild: typeof import("../../src/services/guildAccessService").ensureUserInGuild;
      }
    ).ensureUserInGuild,
  );
  const mockedGetMeetingHistory = jest.mocked(getMeetingHistoryService);
  const mockedCheckMeetingAccess = jest.mocked(checkUserMeetingAccess);
  const mockedUpdateMeeting = jest.mocked(updateMeeting);

  beforeEach(() => {
    jest.resetAllMocks();
    mockedEnsureUserInGuild.mockResolvedValue(true);
    mockedCheckMeetingAccess.mockResolvedValue({
      allowed: true,
      via: "channel_permissions",
    });
    mockedUpdateMeeting.mockResolvedValue(savedUpdate());
  });

  test("saves imported notes with HTTP source metadata", async () => {
    const meetingId = "channel-1#2025-01-01T00:00:00.000Z";
    const user = getMockUser();
    mockedGetMeetingHistory.mockResolvedValue({
      guildId: "guild-1",
      channelId_timestamp: meetingId,
      meetingId: "meeting-1",
      channelId: "channel-1",
      timestamp: "2025-01-01T00:00:00.000Z",
      duration: 1800,
      transcribeMeeting: true,
      generateNotes: true,
      notes: "Old notes",
      transcriptS3Key: "transcripts/meeting-1.json",
      meetingCreatorId: user.id,
      notesVersion: 3,
    } as unknown as MeetingHistory);

    const result = await buildCaller(user).meetings.importNotes({
      serverId: "guild-1",
      meetingId,
      notes: "Imported notes",
      mode: "replace",
      sourceName: "External notes",
      sourceUrl: "https://example.com/notes",
      expectedPreviousVersion: 3,
    });

    expectSavedUpdateAcknowledgment(result);
    expect(mockedUpdateMeeting).toHaveBeenCalledWith(
      expect.objectContaining({
        key: { guildId: "guild-1", channelId_timestamp: meetingId },
        mutation: { kind: "notes", notes: "Imported notes", notesDelta: null },
        actor: { editedBy: user.id },
        notesEdit: {
          expectedNotesVersion: 3,
          source: {
            type: "manual_import",
            importMode: "replace",
            sourceName: "External notes",
            sourceUrl: "https://example.com/notes",
          },
        },
      }),
    );
  });

  test("rejects non-http source URLs", async () => {
    await expect(
      buildCaller().meetings.importNotes({
        serverId: "guild-1",
        meetingId: "channel-1#2025-01-01T00:00:00.000Z",
        notes: "Imported notes",
        mode: "replace",
        sourceUrl: "javascript:alert(1)",
        expectedPreviousVersion: 1,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(mockedGetMeetingHistory).not.toHaveBeenCalled();
    expect(mockedUpdateMeeting).not.toHaveBeenCalled();
  });
});
