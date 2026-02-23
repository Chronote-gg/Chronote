import { beforeEach, describe, expect, test, jest } from "@jest/globals";
import type { DictionaryEntry, MeetingHistory } from "../../src/types/db";
import type { MeetingRuntimeConfig } from "../../src/config/types";
import type { MeetingData } from "../../src/types/meeting-data";
import { CONFIG_KEYS } from "../../src/config/keys";
import {
  FAST_SILENCE_THRESHOLD,
  MAX_SNIPPET_LENGTH,
  MINIMUM_TRANSCRIPTION_LENGTH,
  NOISE_GATE_APPLY_TO_FAST,
  NOISE_GATE_APPLY_TO_SLOW,
  NOISE_GATE_ENABLED,
  NOISE_GATE_MIN_ACTIVE_WINDOWS,
  NOISE_GATE_MIN_PEAK_ABOVE_NOISE_DB,
  NOISE_GATE_PEAK_DBFS,
  NOISE_GATE_WINDOW_MS,
  SILENCE_THRESHOLD,
  TRANSCRIPTION_HARD_SILENCE_DBFS,
  TRANSCRIPTION_RATE_MAX_SECONDS,
  TRANSCRIPTION_RATE_MAX_SYLLABLES_PER_SECOND,
  TRANSCRIPTION_RATE_MIN_SYLLABLES,
  TRANSCRIPTION_RATE_MIN_WORDS,
} from "../../src/constants";
import {
  buildMeetingContext,
  formatContextForPrompt,
} from "../../src/services/contextService";
import { fetchChannelContext } from "../../src/services/channelContextService";
import { listRecentMeetingsForChannelService } from "../../src/services/meetingHistoryService";
import { resolveConfigSnapshot } from "../../src/services/unifiedConfigService";

jest.mock("../../src/services/channelContextService", () => ({
  fetchChannelContext: jest.fn(),
}));
jest.mock("../../src/services/meetingHistoryService", () => ({
  listRecentMeetingsForChannelService: jest.fn(),
}));
jest.mock("../../src/services/unifiedConfigService", () => ({
  resolveConfigSnapshot: jest.fn(),
}));

const mockedFetchChannelContext = fetchChannelContext as jest.MockedFunction<
  typeof fetchChannelContext
>;
const mockedListRecentMeetings =
  listRecentMeetingsForChannelService as jest.MockedFunction<
    typeof listRecentMeetingsForChannelService
  >;
const mockedResolveConfigSnapshot =
  resolveConfigSnapshot as jest.MockedFunction<typeof resolveConfigSnapshot>;

const DEFAULT_NOISE_GATE_CONFIG = {
  enabled: NOISE_GATE_ENABLED,
  windowMs: NOISE_GATE_WINDOW_MS,
  peakDbfs: NOISE_GATE_PEAK_DBFS,
  minActiveWindows: NOISE_GATE_MIN_ACTIVE_WINDOWS,
  minPeakAboveNoiseDb: NOISE_GATE_MIN_PEAK_ABOVE_NOISE_DB,
  applyToFast: NOISE_GATE_APPLY_TO_FAST,
  applyToSlow: NOISE_GATE_APPLY_TO_SLOW,
};

const DEFAULT_TRANSCRIPTION_CONFIG: MeetingRuntimeConfig["transcription"] = {
  suppressionEnabled: false,
  suppressionHardSilenceDbfs: TRANSCRIPTION_HARD_SILENCE_DBFS,
  suppressionRateMaxSeconds: TRANSCRIPTION_RATE_MAX_SECONDS,
  suppressionRateMinWords: TRANSCRIPTION_RATE_MIN_WORDS,
  suppressionRateMinSyllables: TRANSCRIPTION_RATE_MIN_SYLLABLES,
  suppressionRateMaxSyllablesPerSecond:
    TRANSCRIPTION_RATE_MAX_SYLLABLES_PER_SECOND,
  promptEchoEnabled: true,
  voteEnabled: true,
  fastSilenceMs: FAST_SILENCE_THRESHOLD,
  slowSilenceMs: SILENCE_THRESHOLD,
  minSnippetSeconds: MINIMUM_TRANSCRIPTION_LENGTH,
  maxSnippetMs: MAX_SNIPPET_LENGTH,
  fastFinalizationEnabled: false,
  interjectionEnabled: false,
  interjectionMinSpeakerSeconds: MINIMUM_TRANSCRIPTION_LENGTH,
  noiseGate: DEFAULT_NOISE_GATE_CONFIG,
  finalPassEnabled: false,
};

const buildRuntimeConfig = (
  overrides: Partial<MeetingRuntimeConfig> = {},
): MeetingRuntimeConfig => {
  const transcriptionOverrides: Partial<MeetingRuntimeConfig["transcription"]> =
    overrides.transcription ?? {};
  const noiseGateOverrides = transcriptionOverrides.noiseGate ?? {};
  const noiseGate = { ...DEFAULT_NOISE_GATE_CONFIG, ...noiseGateOverrides };
  return {
    transcription: {
      ...DEFAULT_TRANSCRIPTION_CONFIG,
      ...transcriptionOverrides,
      noiseGate,
    },
    premiumTranscription: {
      enabled: false,
      cleanupEnabled: false,
      ...overrides.premiumTranscription,
    },
    dictionary: {
      maxEntries: 3,
      maxCharsTranscription: 200,
      maxCharsContext: 500,
      ...overrides.dictionary,
    },
    autoRecordCancellation: {
      enabled: false,
      ...overrides.autoRecordCancellation,
    },
    visionCaptions: {
      enabled: false,
      maxImages: 0,
      maxTotalChars: 0,
      ...overrides.visionCaptions,
    },
    modelParams: overrides.modelParams,
    modelChoices: overrides.modelChoices,
  };
};

const buildHistory = (
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

const buildMeeting = (overrides: Partial<MeetingData> = {}): MeetingData =>
  ({
    guildId: "guild-1",
    voiceChannel: { id: "voice-1" },
    meetingContext: "Discuss launch",
    dictionaryEntries: [
      {
        guildId: "guild-1",
        termKey: "chronote",
        term: "Chronote",
        definition: "Meeting notes bot",
        createdAt: "2025-01-01T00:00:00.000Z",
        createdBy: "user-1",
        updatedAt: "2025-01-01T00:00:00.000Z",
        updatedBy: "user-1",
      },
    ],
    runtimeConfig: buildRuntimeConfig(),
    ...overrides,
  }) as MeetingData;

describe("contextService", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  test("buildMeetingContext composes server, channel, memory, and dictionary data", async () => {
    mockedResolveConfigSnapshot.mockResolvedValue({
      values: {
        [CONFIG_KEYS.context.instructions]: {
          key: CONFIG_KEYS.context.instructions,
          value: "Server context",
          source: "server",
        },
      },
      experimentalEnabled: false,
      missingRequired: [],
    } as Awaited<ReturnType<typeof resolveConfigSnapshot>>);
    mockedFetchChannelContext.mockResolvedValue({
      guildId: "guild-1",
      channelId: "voice-1",
      context: "Channel context",
      updatedAt: "2025-01-01T00:00:00.000Z",
      updatedBy: "user-1",
    });
    mockedListRecentMeetings.mockResolvedValue([buildHistory()]);

    const meeting = buildMeeting();
    const result = await buildMeetingContext(meeting, true);

    expect(result).toMatchObject({
      meetingContext: "Discuss launch",
      serverContext: "Server context",
      channelContext: "Channel context",
    });
    expect(result.dictionaryEntries).toHaveLength(1);
    expect(result.dictionaryBudgets).toEqual({
      maxEntries: 3,
      maxCharsTranscription: 200,
      maxCharsContext: 500,
    });
    expect(result.recentMeetings).toHaveLength(1);
    expect(mockedListRecentMeetings).toHaveBeenCalledWith(
      "guild-1",
      "voice-1",
      expect.any(Number),
    );
  });

  test("buildMeetingContext returns partial context on errors", async () => {
    mockedResolveConfigSnapshot.mockRejectedValue(new Error("boom"));
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    const meeting = buildMeeting({ meetingContext: "Fallback" });
    const result = await buildMeetingContext(meeting, true);

    expect(result.meetingContext).toBe("Fallback");
    expect(result.dictionaryEntries).toHaveLength(1);
    expect(result.serverContext).toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  test("formatContextForPrompt includes dictionary and memory for notes only", () => {
    const context = {
      serverContext: "Server context",
      channelContext: "Channel context",
      meetingContext: "Meeting context",
      dictionaryEntries: [
        {
          guildId: "guild-1",
          termKey: "chronote",
          term: "Chronote",
          definition: "Meeting notes bot",
          createdAt: "2025-01-01T00:00:00.000Z",
          createdBy: "user-1",
          updatedAt: "2025-01-01T00:00:00.000Z",
          updatedBy: "user-1",
        },
      ] as DictionaryEntry[],
      dictionaryBudgets: {
        maxEntries: 5,
        maxCharsTranscription: 200,
        maxCharsContext: 200,
      },
      recentMeetings: [
        buildHistory({
          notes: "Recap with decisions",
          context: "Prior context",
        }),
      ],
    };

    const notesContext = formatContextForPrompt(context, "notes");
    expect(notesContext).toContain("**Server Context:** Server context");
    expect(notesContext).toContain("**Channel Context:** Channel context");
    expect(notesContext).toContain("**Meeting Context:** Meeting context");
    expect(notesContext).toContain("**Dictionary:**");
    expect(notesContext).toContain("- Chronote: Meeting notes bot");
    expect(notesContext).toContain("Previous Meetings in This Channel");

    const transcriptionContext = formatContextForPrompt(
      context,
      "transcription",
    );
    expect(transcriptionContext).toContain("**Dictionary:**");
    expect(transcriptionContext).not.toContain(
      "Previous Meetings in This Channel",
    );

    const imageContext = formatContextForPrompt(context, "image");
    expect(imageContext).not.toContain("**Dictionary:**");
  });
});
