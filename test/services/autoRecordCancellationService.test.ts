import { describe, expect, test, jest } from "@jest/globals";
import type { ChatEntry } from "../../src/types/chat";
import type { MeetingRuntimeConfig } from "../../src/config/types";
import type { MeetingData } from "../../src/types/meeting-data";

type LoadOptions = {
  mockEnabled?: boolean;
  nodeEnv?: string;
  responseContent?: string;
};

const loadModule = async (options: LoadOptions = {}) => {
  jest.resetModules();

  const config = {
    mock: { enabled: options.mockEnabled ?? false },
    server: { nodeEnv: options.nodeEnv ?? "production" },
    database: {
      useLocalDynamoDB: false,
      tablePrefix: "",
    },
    discord: {
      clientId: "mock-client",
    },
    notes: { model: "gpt-5.2" },
    liveVoice: {
      gateModel: "gpt-5-mini",
      responderModel: "gpt-4o-mini",
      ttsModel: "gpt-4o-mini-tts",
    },
  };
  const waitForFinishProcessing = jest
    .fn<() => Promise<void>>()
    .mockResolvedValue(undefined);
  const completionCreate = jest
    .fn<() => Promise<{ choices: { message: { content: string } }[] }>>()
    .mockResolvedValue({
      choices: [{ message: { content: options.responseContent ?? "" } }],
    });
  const createOpenAIClient = jest.fn(() => ({
    chat: { completions: { create: completionCreate } },
  }));
  const getModelChoice = jest.fn(() => ({ model: "gpt-4o-mini" }));
  const buildModelOverrides = jest.fn(() => undefined);

  jest.doMock("../../src/services/configService", () => ({ config }));
  jest.doMock("../../src/audio", () => ({ waitForFinishProcessing }));
  jest.doMock("../../src/services/openaiClient", () => ({
    createOpenAIClient,
  }));
  jest.doMock("../../src/services/modelFactory", () => ({
    buildModelOverrides,
    getModelChoice,
  }));

  const module =
    await import("../../src/services/autoRecordCancellationService");
  return {
    ...module,
    waitForFinishProcessing,
    completionCreate,
    createOpenAIClient,
  };
};

const buildChatEntry = (content: string): ChatEntry =>
  ({
    type: "message",
    user: { id: "user-1", username: "User" },
    channelId: "voice-1",
    content,
    timestamp: "2025-01-01T00:00:00.000Z",
  }) as ChatEntry;

const buildRuntimeConfig = (
  overrides: Partial<MeetingRuntimeConfig> = {},
): MeetingRuntimeConfig => {
  const base: MeetingRuntimeConfig = {
    transcription: {
      suppressionEnabled: true,
      suppressionHardSilenceDbfs: -60,
      suppressionRateMaxSeconds: 3,
      suppressionRateMinWords: 4,
      suppressionRateMinSyllables: 8,
      suppressionRateMaxSyllablesPerSecond: 7,
      promptEchoEnabled: true,
      voteEnabled: true,
      fastSilenceMs: 500,
      slowSilenceMs: 1000,
      minSnippetSeconds: 1,
      maxSnippetMs: 15000,
      fastFinalizationEnabled: false,
      interjectionEnabled: false,
      interjectionMinSpeakerSeconds: 1,
      noiseGate: {
        enabled: true,
        windowMs: 20,
        peakDbfs: -45,
        minActiveWindows: 2,
        minPeakAboveNoiseDb: 15,
        applyToFast: true,
        applyToSlow: true,
      },
      finalPassEnabled: false,
    },
    premiumTranscription: {
      enabled: false,
      cleanupEnabled: false,
    },
    dictionary: {
      maxEntries: 0,
      maxCharsTranscription: 0,
      maxCharsContext: 0,
    },
    autoRecordCancellation: {
      enabled: true,
    },
    visionCaptions: {
      enabled: false,
      maxImages: 0,
      maxTotalChars: 0,
    },
    modelParams: {},
  };

  return {
    ...base,
    ...overrides,
    transcription: { ...base.transcription, ...overrides.transcription },
    premiumTranscription: {
      ...base.premiumTranscription,
      ...overrides.premiumTranscription,
    },
    dictionary: { ...base.dictionary, ...overrides.dictionary },
    autoRecordCancellation: {
      ...base.autoRecordCancellation,
      ...overrides.autoRecordCancellation,
    },
    visionCaptions: {
      ...base.visionCaptions,
      ...overrides.visionCaptions,
    },
  };
};

const buildMeeting = (overrides: Partial<MeetingData> = {}): MeetingData =>
  ({
    meetingId: "meeting-1",
    chatLog: [],
    attendance: new Set<string>(),
    connection: {},
    textChannel: {},
    voiceChannel: { id: "voice-1" },
    guildId: "guild-1",
    channelId: "voice-1",
    audioData: {
      currentSnippets: new Map(),
      audioFiles: [],
    },
    startTime: new Date("2025-01-01T00:00:00.000Z"),
    endTime: new Date("2025-01-01T00:00:30.000Z"),
    creator: { id: "user-1" },
    guild: { id: "guild-1" },
    isAutoRecording: true,
    finishing: false,
    isFinished: Promise.resolve(),
    setFinished: () => {},
    finished: false,
    transcribeMeeting: true,
    generateNotes: true,
    participants: new Map(),
    ...overrides,
  }) as MeetingData;

describe("autoRecordCancellationService", () => {
  test("returns false when meeting is not auto-recorded", async () => {
    const {
      evaluateAutoRecordCancellation,
      waitForFinishProcessing,
      completionCreate,
    } = await loadModule();
    const meeting = buildMeeting({ isAutoRecording: false });
    const result = await evaluateAutoRecordCancellation(meeting);
    expect(result).toEqual({ cancel: false });
    expect(waitForFinishProcessing).not.toHaveBeenCalled();
    expect(completionCreate).not.toHaveBeenCalled();
  });

  test("returns false when auto-cancel is disabled in config", async () => {
    const { evaluateAutoRecordCancellation, completionCreate } =
      await loadModule();
    const meeting = buildMeeting({
      runtimeConfig: buildRuntimeConfig({
        autoRecordCancellation: { enabled: false },
      }),
    });
    const result = await evaluateAutoRecordCancellation(meeting);
    expect(result).toEqual({ cancel: false });
    expect(completionCreate).not.toHaveBeenCalled();
  });

  test("returns false when duration exceeds heuristic threshold", async () => {
    const { evaluateAutoRecordCancellation, completionCreate } =
      await loadModule();
    const meeting = buildMeeting({
      endTime: new Date("2025-01-01T00:03:00.000Z"),
    });
    const result = await evaluateAutoRecordCancellation(meeting);
    expect(result).toEqual({ cancel: false });
    expect(completionCreate).not.toHaveBeenCalled();
  });

  test("returns cancel decision with default reason when model omits reason", async () => {
    const {
      evaluateAutoRecordCancellation,
      completionCreate,
      waitForFinishProcessing,
    } = await loadModule({
      responseContent: JSON.stringify({ cancel: true }),
    });
    const meeting = buildMeeting({
      chatLog: [buildChatEntry("Hello")],
      audioData: {
        currentSnippets: new Map(),
        audioFiles: [
          {
            userId: "user-1",
            timestamp: Date.parse("2025-01-01T00:00:05.000Z"),
            transcript: "hello world",
            processing: false,
            audioOnlyProcessing: false,
          },
        ],
      },
    });

    const result = await evaluateAutoRecordCancellation(meeting);

    expect(waitForFinishProcessing).toHaveBeenCalled();
    expect(completionCreate).toHaveBeenCalled();
    expect(result).toEqual({
      cancel: true,
      reason: "Not enough content detected.",
    });
  });

  test("returns false when model rejects cancellation", async () => {
    const { evaluateAutoRecordCancellation, completionCreate } =
      await loadModule({
        responseContent: JSON.stringify({
          cancel: false,
          reason: "Has content.",
        }),
      });
    const meeting = buildMeeting({
      audioData: {
        currentSnippets: new Map(),
        audioFiles: [
          {
            userId: "user-1",
            timestamp: Date.parse("2025-01-01T00:00:05.000Z"),
            transcript: "hello world",
            processing: false,
            audioOnlyProcessing: false,
          },
        ],
      },
    });

    const result = await evaluateAutoRecordCancellation(meeting);

    expect(completionCreate).toHaveBeenCalled();
    expect(result).toEqual({ cancel: false });
  });
});
