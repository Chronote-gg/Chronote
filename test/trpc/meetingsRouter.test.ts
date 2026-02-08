import { beforeEach, describe, expect, test, jest } from "@jest/globals";
import type { Request, Response } from "express";
import type { MeetingHistory } from "../../src/types/db";
import type { FeedbackRecord } from "../../src/types/db";
import type { MeetingEvent } from "../../src/types/meetingTimeline";
import { getMockUser } from "../../src/repositories/mockStore";
import { appRouter } from "../../src/trpc/router";
import { ensureManageGuildWithUserToken } from "../../src/services/guildAccessService";
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

jest.mock("../../src/services/guildAccessService", () => ({
  ensureManageGuildWithUserToken: jest.fn(),
  ensureUserInGuild: jest.fn(),
  ensureBotInGuild: jest.fn(),
}));

jest.mock("../../src/services/meetingHistoryService", () => ({
  getMeetingHistoryService: jest.fn(),
  listRecentMeetingsForGuildService: jest.fn(),
  updateMeetingNotesService: jest.fn(),
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

const buildCaller = (user = getMockUser()) =>
  appRouter.createCaller({
    req: { session: {} } as Request,
    res: {} as Response,
    user,
  });

describe("meetings router detail", () => {
  const mockedEnsureManageGuild = jest.mocked(ensureManageGuildWithUserToken);
  const mockedGetMeetingHistory = jest.mocked(getMeetingHistoryService);
  const mockedFetchJsonFromS3 = jest.mocked(fetchJsonFromS3);
  const mockedGetSignedObjectUrl = jest.mocked(getSignedObjectUrl);
  const mockedBuildTimeline = jest.mocked(
    buildMeetingTimelineEventsFromHistory,
  );
  const mockedGetSummaryFeedback = jest.mocked(getMeetingSummaryFeedback);

  beforeEach(() => {
    jest.resetAllMocks();
    mockedEnsureManageGuild.mockResolvedValue(true);
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

  const mockedUpdateMeetingNotesService = jest.mocked(
    updateMeetingNotesService,
  );

  beforeEach(() => {
    jest.resetAllMocks();
    mockedEnsureManageGuild.mockResolvedValue(true);
    mockedEnsureUserInGuild.mockResolvedValue(true);
    mockedEnsureUserCanViewChannel.mockResolvedValue(true);
    mockedEnsureUserCanManageChannel.mockResolvedValue(true);
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
