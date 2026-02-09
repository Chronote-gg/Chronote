import type { ButtonInteraction, Client } from "discord.js";
import type { MeetingData } from "../../src/types/meeting-data";
import { Collection } from "discord.js";
import {
  handleEndMeetingButton,
  handleEndMeetingOther,
} from "../../src/commands/endMeeting";
import { startProcessingSnippet } from "../../src/audio";
import { withMeetingEndTrace } from "../../src/observability/meetingTrace";
import { evaluateAutoRecordCancellation } from "../../src/services/autoRecordCancellationService";
import {
  buildMixedAudio,
  cleanupSpeakerTracks,
  closeOutputFile,
  waitForAudioOnlyFinishProcessing,
} from "../../src/audio";
import { uploadMeetingArtifacts } from "../../src/services/uploadService";
import { saveMeetingHistoryToDatabase } from "../../src/commands/saveMeetingHistory";
import { getGuildLimits } from "../../src/services/subscriptionService";
import { updateMeetingStatusService } from "../../src/services/meetingHistoryService";
import { getMeeting } from "../../src/meetings";
import { describeAutoRecordRule } from "../../src/utils/meetingLifecycle";
import { MEETING_END_REASONS } from "../../src/types/meetingLifecycle";

jest.mock("../../src/audio", () => ({
  buildMixedAudio: jest.fn(),
  cleanupSpeakerTracks: jest.fn(),
  closeOutputFile: jest.fn(),
  compileTranscriptions: jest.fn(),
  startProcessingSnippet: jest.fn(),
  waitForAudioOnlyFinishProcessing: jest.fn(),
  waitForFinishProcessing: jest.fn(),
}));
jest.mock("../../src/embed", () => ({
  updateMeetingProcessingMessage: jest.fn(),
  updateMeetingSummaryMessage: jest.fn(),
}));
jest.mock("../../src/util", () => ({
  deleteDirectoryRecursively: jest.fn(),
  deleteIfExists: jest.fn(),
}));
jest.mock("../../src/services/meetingNotesService", () => ({
  ensureMeetingNotes: jest.fn(),
  ensureMeetingSummaries: jest.fn(),
}));
jest.mock("../../src/commands/saveMeetingHistory", () => ({
  saveMeetingHistoryToDatabase: jest.fn(),
}));
jest.mock("../../src/services/meetingHistoryService", () => ({
  updateMeetingStatusService: jest.fn(),
}));
jest.mock("../../src/utils/chatLog", () => ({
  renderChatEntryLine: jest.fn().mockReturnValue(""),
}));
jest.mock("../../src/services/uploadService", () => ({
  uploadMeetingArtifacts: jest.fn(),
}));
jest.mock("../../src/services/subscriptionService", () => ({
  getGuildLimits: jest.fn(),
}));
jest.mock("../../src/audio/soundCues", () => ({
  stopThinkingCueLoop: jest.fn(),
}));
jest.mock("../../src/observability/meetingTrace", () => ({
  withMeetingEndTrace: jest.fn(),
  withMeetingEndStep: jest.fn(
    (_meeting: unknown, _name: string, run: () => unknown) => run(),
  ),
}));
jest.mock("../../src/services/autoRecordCancellationService", () => ({
  evaluateAutoRecordCancellation: jest.fn(),
}));
jest.mock("../../src/services/autoRecordJoinSuppressionService", () => ({
  __esModule: true,
  autoRecordJoinSuppressionService: {
    suppressUntilEmpty: jest.fn(),
  },
}));
jest.mock("../../src/metrics", () => ({
  meetingsCancelled: { inc: jest.fn() },
}));
jest.mock("../../src/utils/meetingLifecycle", () => ({
  describeAutoRecordRule: jest.fn(),
}));
jest.mock("../../src/meetings", () => ({
  deleteMeeting: jest.fn(),
  getMeeting: jest.fn(),
  hasMeeting: jest.fn(),
}));
jest.mock("../../src/services/meetingUsageService", () => ({
  getNextAvailableAt: jest.fn(),
  getRollingUsageForGuild: jest.fn(),
  getRollingWindowMs: jest.fn(),
}));
jest.mock("../../src/utils/upgradePrompt", () => ({
  buildUpgradeTextOnly: jest.fn((content: string) => content),
}));
jest.mock("node:fs", () => ({
  mkdirSync: jest.fn(),
  promises: {
    mkdir: jest.fn().mockResolvedValue(undefined),
    rm: jest.fn().mockResolvedValue(undefined),
  },
  writeFileSync: jest.fn(),
}));

const mockedStartProcessingSnippet =
  startProcessingSnippet as jest.MockedFunction<typeof startProcessingSnippet>;
const mockedWithMeetingEndTrace = withMeetingEndTrace as jest.MockedFunction<
  typeof withMeetingEndTrace
>;
const mockedEvaluateAutoRecordCancellation =
  evaluateAutoRecordCancellation as jest.MockedFunction<
    typeof evaluateAutoRecordCancellation
  >;
const mockedBuildMixedAudio = buildMixedAudio as jest.MockedFunction<
  typeof buildMixedAudio
>;
const mockedCleanupSpeakerTracks = cleanupSpeakerTracks as jest.MockedFunction<
  typeof cleanupSpeakerTracks
>;
const mockedCloseOutputFile = closeOutputFile as jest.MockedFunction<
  typeof closeOutputFile
>;
const mockedWaitForAudioOnlyFinishProcessing =
  waitForAudioOnlyFinishProcessing as jest.MockedFunction<
    typeof waitForAudioOnlyFinishProcessing
  >;
const mockedUploadMeetingArtifacts =
  uploadMeetingArtifacts as jest.MockedFunction<typeof uploadMeetingArtifacts>;
const mockedSaveMeetingHistoryToDatabase =
  saveMeetingHistoryToDatabase as jest.MockedFunction<
    typeof saveMeetingHistoryToDatabase
  >;
const mockedGetGuildLimits = getGuildLimits as jest.MockedFunction<
  typeof getGuildLimits
>;
const mockedUpdateMeetingStatusService =
  updateMeetingStatusService as jest.MockedFunction<
    typeof updateMeetingStatusService
  >;
const mockedGetMeeting = getMeeting as jest.MockedFunction<typeof getMeeting>;
const mockedDescribeAutoRecordRule =
  describeAutoRecordRule as jest.MockedFunction<typeof describeAutoRecordRule>;

describe("handleEndMeetingOther", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedCleanupSpeakerTracks.mockResolvedValue(undefined);
  });

  it("flushes active snippets before disconnecting the voice connection", async () => {
    const events: string[] = [];
    mockedStartProcessingSnippet.mockImplementation(() => {
      events.push("flush");
    });
    mockedWithMeetingEndTrace.mockImplementation(async (_meeting, fn) => fn());
    mockedEvaluateAutoRecordCancellation.mockResolvedValue({ cancel: false });
    mockedBuildMixedAudio.mockResolvedValue(undefined);
    mockedCloseOutputFile.mockResolvedValue(undefined);
    mockedWaitForAudioOnlyFinishProcessing.mockResolvedValue(undefined);
    mockedUploadMeetingArtifacts.mockResolvedValue(undefined);
    mockedSaveMeetingHistoryToDatabase.mockResolvedValue(undefined);
    mockedGetGuildLimits.mockResolvedValue({ limits: {} } as never);
    mockedUpdateMeetingStatusService.mockResolvedValue(undefined);

    const connection = {
      disconnect: jest.fn(() => {
        events.push("disconnect");
      }),
      destroy: jest.fn(() => {
        events.push("destroy");
      }),
    };

    const meeting = {
      guildId: "guild-1",
      channelId: "text-1",
      meetingId: "meeting-1",
      voiceChannel: { id: "voice-1", name: "Voice" },
      textChannel: {
        send: jest.fn(),
        messages: { fetch: jest.fn() },
      },
      connection,
      chatLog: [],
      audioData: {
        audioFiles: [],
        currentSnippets: new Map([
          [
            "user-1",
            {
              userId: "user-1",
              timestamp: Date.now(),
              chunks: [Buffer.from("test")],
              fastRevision: 0,
              fastTranscribed: false,
            },
          ],
        ]),
        outputFileName: "recording.mp3",
      },
      startTime: new Date("2025-01-01T00:00:00.000Z"),
      endTime: undefined,
      finishing: false,
      finished: false,
      transcribeMeeting: false,
      generateNotes: false,
      isAutoRecording: false,
      creator: { id: "user-1" },
      guild: { id: "guild-1", name: "Guild", members: { cache: new Map() } },
      ttsQueue: { stopAndClear: jest.fn() },
      setFinished: jest.fn(),
    } as unknown as MeetingData;

    await handleEndMeetingOther({} as Client, meeting);

    expect(events.indexOf("flush")).toBeGreaterThanOrEqual(0);
    expect(events.indexOf("flush")).toBeLessThan(events.indexOf("disconnect"));
    expect(events.indexOf("disconnect")).toBeLessThan(
      events.indexOf("destroy"),
    );
  });

  it("skips auto-record cancellation evaluation when meeting.cancelled is set", async () => {
    const { autoRecordJoinSuppressionService } = jest.requireMock(
      "../../src/services/autoRecordJoinSuppressionService",
    ) as {
      autoRecordJoinSuppressionService: {
        suppressUntilEmpty: jest.Mock;
      };
    };

    mockedWithMeetingEndTrace.mockImplementation(async (_meeting, fn) => fn());
    mockedWaitForAudioOnlyFinishProcessing.mockResolvedValue(undefined);
    mockedCloseOutputFile.mockResolvedValue(undefined);
    mockedDescribeAutoRecordRule.mockReturnValue(
      "Auto-record rule: test-channel",
    );
    mockedSaveMeetingHistoryToDatabase.mockResolvedValue(undefined);

    const members = new Collection<
      string,
      { id: string; user: { bot: boolean } }
    >([
      ["user-1", { id: "user-1", user: { bot: false } }],
      ["bot-1", { id: "bot-1", user: { bot: true } }],
    ]);

    const meeting = {
      guildId: "guild-1",
      channelId: "text-1",
      meetingId: "meeting-1",
      voiceChannel: {
        id: "voice-1",
        name: "Voice",
        members,
      },
      textChannel: {
        send: jest.fn().mockResolvedValue(undefined),
        messages: { fetch: jest.fn() },
      },
      connection: {
        disconnect: jest.fn(),
        destroy: jest.fn(),
      },
      chatLog: [],
      audioData: {
        audioFiles: [],
        currentSnippets: new Map(),
        outputFileName: "recording.mp3",
      },
      startTime: new Date("2025-01-01T00:00:00.000Z"),
      endTime: undefined,
      finishing: false,
      finished: false,
      transcribeMeeting: false,
      generateNotes: false,
      isAutoRecording: true,
      cancelled: true,
      cancellationReason: "Stopped by user",
      endReason: MEETING_END_REASONS.DISMISSED,
      endTriggeredByUserId: "user-1",
      creator: { id: "bot-1" },
      guild: { id: "guild-1", members: { cache: new Map() } },
      ttsQueue: { stopAndClear: jest.fn() },
      setFinished: jest.fn(),
    } as unknown as MeetingData;

    await handleEndMeetingOther({} as Client, meeting);

    expect(mockedEvaluateAutoRecordCancellation).not.toHaveBeenCalled();
    expect(mockedBuildMixedAudio).not.toHaveBeenCalled();
    expect(mockedUploadMeetingArtifacts).not.toHaveBeenCalled();
    expect(
      autoRecordJoinSuppressionService.suppressUntilEmpty,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: "guild-1",
        channelId: "voice-1",
        nonBotMemberIds: ["user-1"],
        reason: "explicit_end",
      }),
    );
  });
});

describe("handleEndMeetingButton", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("acknowledges the end meeting button when auto-recording is cancelled", async () => {
    mockedWithMeetingEndTrace.mockImplementation(async (_meeting, fn) => fn());
    mockedEvaluateAutoRecordCancellation.mockResolvedValue({
      cancel: true,
      reason: "No meaningful content detected.",
    });
    mockedWaitForAudioOnlyFinishProcessing.mockResolvedValue(undefined);
    mockedCloseOutputFile.mockResolvedValue(undefined);
    mockedDescribeAutoRecordRule.mockReturnValue(
      "Auto-record rule: test-channel",
    );

    const meeting = {
      guildId: "guild-1",
      channelId: "text-1",
      meetingId: "meeting-1",
      voiceChannel: { id: "voice-1", name: "Voice" },
      textChannel: {
        send: jest.fn().mockResolvedValue(undefined),
        messages: { fetch: jest.fn() },
      },
      connection: {
        disconnect: jest.fn(),
        destroy: jest.fn(),
      },
      chatLog: [],
      audioData: {
        audioFiles: [],
        currentSnippets: new Map(),
        outputFileName: "recording.mp3",
      },
      startTime: new Date("2025-01-01T00:00:00.000Z"),
      endTime: undefined,
      finishing: false,
      finished: false,
      transcribeMeeting: false,
      generateNotes: false,
      isAutoRecording: true,
      creator: { id: "user-1" },
      guild: { id: "guild-1", members: { cache: new Map() } },
      ttsQueue: { stopAndClear: jest.fn() },
      setFinished: jest.fn(),
    } as unknown as MeetingData;

    mockedGetMeeting.mockReturnValue(meeting);

    const interaction = {
      guildId: "guild-1",
      user: { id: "user-1" },
      deferred: false,
      replied: false,
      deferUpdate: jest.fn().mockResolvedValue(undefined),
      reply: jest.fn().mockResolvedValue(undefined),
    } as unknown as ButtonInteraction;

    await handleEndMeetingButton({} as Client, interaction);

    expect(interaction.deferUpdate).toHaveBeenCalled();
  });

  it("suppresses auto-record rejoin until the channel is empty", async () => {
    const { autoRecordJoinSuppressionService } = jest.requireMock(
      "../../src/services/autoRecordJoinSuppressionService",
    ) as {
      autoRecordJoinSuppressionService: {
        suppressUntilEmpty: jest.Mock;
      };
    };

    mockedWithMeetingEndTrace.mockImplementation(async (_meeting, fn) => fn());
    mockedEvaluateAutoRecordCancellation.mockResolvedValue({
      cancel: false,
    });
    mockedWaitForAudioOnlyFinishProcessing.mockResolvedValue(undefined);
    mockedCloseOutputFile.mockResolvedValue(undefined);
    mockedDescribeAutoRecordRule.mockReturnValue(
      "Auto-record rule: test-channel",
    );

    const members = new Collection<
      string,
      { id: string; user: { bot: boolean } }
    >([
      ["user-1", { id: "user-1", user: { bot: false } }],
      ["bot-1", { id: "bot-1", user: { bot: true } }],
    ]);

    const meeting = {
      guildId: "guild-1",
      channelId: "text-1",
      meetingId: "meeting-1",
      voiceChannel: {
        id: "voice-1",
        name: "Voice",
        members,
      },
      textChannel: {
        send: jest.fn().mockResolvedValue(undefined),
        messages: { fetch: jest.fn() },
      },
      connection: {
        disconnect: jest.fn(),
        destroy: jest.fn(),
      },
      chatLog: [],
      audioData: {
        audioFiles: [],
        currentSnippets: new Map(),
        outputFileName: "recording.mp3",
      },
      startTime: new Date("2025-01-01T00:00:00.000Z"),
      endTime: undefined,
      finishing: false,
      finished: false,
      transcribeMeeting: false,
      generateNotes: false,
      isAutoRecording: true,
      creator: { id: "user-1" },
      guild: { id: "guild-1", members: { cache: new Map() } },
      ttsQueue: { stopAndClear: jest.fn() },
      setFinished: jest.fn(),
    } as unknown as MeetingData;

    mockedGetMeeting.mockReturnValue(meeting);

    const interaction = {
      guildId: "guild-1",
      user: { id: "user-1" },
      deferred: false,
      replied: false,
      deferUpdate: jest.fn().mockResolvedValue(undefined),
      reply: jest.fn().mockResolvedValue(undefined),
    } as unknown as ButtonInteraction;

    await handleEndMeetingButton({} as Client, interaction);

    expect(
      autoRecordJoinSuppressionService.suppressUntilEmpty,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: "guild-1",
        channelId: "voice-1",
        nonBotMemberIds: ["user-1"],
        reason: "explicit_end",
      }),
    );
  });
});
