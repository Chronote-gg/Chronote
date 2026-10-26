import { describe, expect, test, jest } from "@jest/globals";
import { completedTextResponse } from "../../src/testSupport/openaiResponse";
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
  const responsesCreate = jest
    .fn<() => Promise<ReturnType<typeof completedTextResponse>>>()
    .mockResolvedValue(completedTextResponse(options.responseContent ?? ""));
  const createOpenAIClient = jest.fn(() => ({
    responses: { create: responsesCreate },
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
    responsesCreate,
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
    runtimeConfig: buildRuntimeConfig(),
    ...overrides,
  }) as MeetingData;

const buildSparseMeeting = (): MeetingData =>
  buildMeeting({
    audioData: {
      currentSnippets: new Map(),
      audioFiles: [
        {
          userId: "user-1",
          timestamp: Date.parse("2025-01-01T00:00:05.000Z"),
          transcript: "hello",
          processing: false,
          audioOnlyProcessing: false,
        },
      ],
    },
  });

describe("autoRecordCancellationService", () => {
  test("returns false when meeting is not auto-recorded", async () => {
    const {
      evaluateAutoRecordCancellation,
      waitForFinishProcessing,
      responsesCreate,
    } = await loadModule();
    const meeting = buildMeeting({ isAutoRecording: false });
    const result = await evaluateAutoRecordCancellation(meeting);
    expect(result).toEqual({ cancel: false });
    expect(waitForFinishProcessing).not.toHaveBeenCalled();
    expect(responsesCreate).not.toHaveBeenCalled();
  });

  test("returns false when auto-cancel is disabled in config", async () => {
    const { evaluateAutoRecordCancellation, responsesCreate } =
      await loadModule();
    const meeting = buildMeeting({
      runtimeConfig: buildRuntimeConfig({
        autoRecordCancellation: { enabled: false },
      }),
    });
    const result = await evaluateAutoRecordCancellation(meeting);
    expect(result).toEqual({ cancel: false });
    expect(responsesCreate).not.toHaveBeenCalled();
  });

  test("returns false when duration exceeds heuristic threshold", async () => {
    const { evaluateAutoRecordCancellation, responsesCreate } =
      await loadModule();
    const meeting = buildMeeting({
      endTime: new Date("2025-01-01T00:03:00.000Z"),
    });
    const result = await evaluateAutoRecordCancellation(meeting);
    expect(result).toEqual({ cancel: false });
    expect(responsesCreate).not.toHaveBeenCalled();
  });

  test("returns cancel decision with default reason when model omits reason", async () => {
    const {
      evaluateAutoRecordCancellation,
      responsesCreate,
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
    expect(responsesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        max_output_tokens: 120,
        text: { format: { type: "json_object" } },
        store: false,
        input: [
          expect.objectContaining({ role: "system" }),
          expect.objectContaining({ role: "user" }),
        ],
      }),
      undefined,
    );
    expect(result).toEqual({
      cancel: true,
      reason: "Not enough content detected.",
    });
  });

  test.each(["", " \n\t "])(
    "keeps the meeting when completed Responses output is blank: %j",
    async (responseContent) => {
      const { evaluateAutoRecordCancellation, responsesCreate } =
        await loadModule({ responseContent });
      const meeting = buildSparseMeeting();

      await expect(evaluateAutoRecordCancellation(meeting)).resolves.toEqual({
        cancel: false,
      });
      expect(responsesCreate).toHaveBeenCalledTimes(1);
    },
  );

  test("returns false when model rejects cancellation", async () => {
    const { evaluateAutoRecordCancellation, responsesCreate } =
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

    expect(responsesCreate).toHaveBeenCalled();
    expect(result).toEqual({ cancel: false });
  });
});

test("failed sparse transcription is excluded before the actual cancellation provider", async () => {
  const { evaluateAutoRecordCancellation, responsesCreate } = await loadModule({
    responseContent: '{"cancel":true}',
  });
  const meeting = buildMeeting();
  meeting.audioData.audioFiles = [
    { transcriptionFailed: true, processing: false, transcript: "" },
  ] as never;
  await expect(evaluateAutoRecordCancellation(meeting)).rejects.toThrow(
    "processing",
  );
  expect(responsesCreate).not.toHaveBeenCalled();
});

test("actual automatic cancellation provider failure is propagated for durable failure", async () => {
  const { evaluateAutoRecordCancellation, responsesCreate } =
    await loadModule();
  const meeting = buildMeeting();
  meeting.audioData.audioFiles = [
    { transcript: "Hello", processing: false },
  ] as never;
  const failure = new Error("fixture cancellation provider unavailable");
  responsesCreate.mockRejectedValueOnce(failure);
  const errorOutput = jest
    .spyOn(console, "error")
    .mockImplementation(() => undefined);
  try {
    await expect(evaluateAutoRecordCancellation(meeting)).rejects.toBe(failure);
    expect(errorOutput).toHaveBeenCalledWith(
      "Auto-record cancellation check failed:",
      failure,
    );
  } finally {
    errorOutput.mockRestore();
  }
});

test("an ordinary empty-output error still propagates as a provider failure", async () => {
  const { evaluateAutoRecordCancellation, responsesCreate } =
    await loadModule();
  const meeting = buildSparseMeeting();
  const failure = new Error("OpenAI Responses output empty.");
  responsesCreate.mockRejectedValueOnce(failure);
  const errorOutput = jest
    .spyOn(console, "error")
    .mockImplementation(() => undefined);
  try {
    await expect(evaluateAutoRecordCancellation(meeting)).rejects.toBe(failure);
  } finally {
    errorOutput.mockRestore();
  }
});
