import { beforeEach, describe, expect, test, jest } from "@jest/globals";
import type { Request, Response } from "express";
import type { MeetingHistory } from "../../src/types/db";
import type { FeedbackRecord } from "../../src/types/db";
import type { MeetingEvent } from "../../src/types/meetingTimeline";
import { getMockUser } from "../../src/repositories/mockStore";
import { appRouter } from "../../src/trpc/router";
import {
  ensureManageGuildWithUserToken,
  ensureUserInGuild,
} from "../../src/services/guildAccessService";
import {
  getMeetingHistoryService,
  updateMeetingNotesService,
} from "../../src/services/meetingHistoryService";
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
  updateMeetingNotesService: jest.fn(),
  updateMeetingNotesMessageMetadataService: jest.fn(),
  updateMeetingArchiveService: jest.fn(),
  updateMeetingNameService: jest.fn(),
}));

jest.mock("../../src/services/storageService", () => ({
  fetchJsonFromS3: jest.fn(),
  getSignedObjectUrl: jest.fn(),
}));

jest.mock("../../src/services/meetingTimelineService", () => ({
  buildMeetingTimelineEventsFromHistory: jest.fn(),
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
}));

jest.mock("../../src/services/discordCacheService", () => ({
  listBotGuildsCached: jest.fn(),
  listGuildChannelsCached: jest.fn(),
}));

const buildCaller = (user = getMockUser()) =>
  appRouter.createCaller({
    req: { session: {} } as Request,
    res: {} as Response,
    user,
  });

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

  beforeEach(() => {
    jest.resetAllMocks();
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

  test("throws NOT_FOUND when meeting history is missing", async () => {
    mockedGetMeetingHistory.mockResolvedValue(undefined);

    await expect(
      buildCaller().meetings.detail({
        serverId: "guild-1",
        meetingId: "missing-meeting",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("meetings notes correction mutations", () => {
  const mockedEnsureManageGuild = jest.mocked(ensureManageGuildWithUserToken);
  const mockedEnsureUserInGuild = jest.mocked(
    (
      jest.requireMock("../../src/services/guildAccessService") as {
        ensureUserInGuild: typeof import("../../src/services/guildAccessService").ensureUserInGuild;
      }
    ).ensureUserInGuild,
  );
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

  const mockedUpdateMeetingNotesService = jest.mocked(
    updateMeetingNotesService,
  );

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
    const createCompletion = jest.fn(async () => ({
      choices: [
        {
          message: { content: "Updated notes" },
        },
      ],
    }));
    mockedCreateOpenAIClient.mockReturnValue({
      chat: {
        completions: {
          create: createCompletion,
        },
      },
    } as unknown as ReturnType<typeof createOpenAIClient>);
    mockedGenerateMeetingSummaries.mockResolvedValue({
      summarySentence: "New summary sentence",
      summaryLabel: "New summary label",
    });
  });

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
      chat: {
        completions: {
          create: async () => ({
            choices: [
              {
                message: { content: updated },
              },
            ],
          }),
        },
      },
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

    const createCompletion = jest.fn(async () => ({
      choices: [
        {
          message: { content: "Line 1\n\nLine 2" },
        },
      ],
    }));
    mockedCreateOpenAIClient.mockReturnValue({
      chat: {
        completions: {
          create: createCompletion,
        },
      },
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
      chat: {
        completions: {
          create: async () => {
            throw new Error("boom");
          },
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

    mockedUpdateMeetingNotesService.mockResolvedValueOnce(false);
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
  const mockedUpdateMeetingNotesService = jest.mocked(
    updateMeetingNotesService,
  );

  beforeEach(() => {
    jest.resetAllMocks();
    mockedEnsureUserInGuild.mockResolvedValue(true);
    mockedEnsureUserCanViewChannel.mockResolvedValue(true);
    mockedEnsureUserCanManageChannel.mockResolvedValue(true);
    mockedCheckMeetingAccess.mockResolvedValue({
      allowed: true,
      via: "channel_permissions",
    });
    mockedUpdateMeetingNotesService.mockResolvedValue(true);
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

    expect(result).toEqual({ ok: true });
    expect(mockedUpdateMeetingNotesService).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: "guild-1",
        channelId_timestamp: meetingId,
        notes: "Hello",
        notesDelta: delta,
        notesVersion: 4,
        editedBy: user.id,
        expectedPreviousVersion: 3,
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

    expect(mockedUpdateMeetingNotesService).not.toHaveBeenCalled();
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

    expect(result).toEqual({ ok: true });
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
