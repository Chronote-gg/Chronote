import { jest } from "@jest/globals";
import type { MeetingData } from "../../src/types/meeting-data";
import type { AudioSnippet } from "../../src/types/audio";

const meeting = {
  meetingId: "meeting-1",
  creator: { id: "user-1" },
  guild: { id: "guild-1" },
  voiceChannel: { id: "voice-1" },
  runtimeConfig: {
    transcription: {
      suppressionEnabled: false,
      promptEchoEnabled: false,
      voteEnabled: false,
      noiseGate: { enabled: false },
    },
    modelParams: {},
    modelChoices: {},
  },
} as MeetingData;

const snippet: AudioSnippet = {
  userId: "user-1",
  timestamp: 1,
  chunks: [Buffer.alloc(100)],
};

async function loadModule(options: {
  providerResult?: string;
  providerError?: { status?: number; code?: number; secret?: string };
  providerErrorOnce?: { status?: number; code?: number; secret?: string };
  conversionError?: Error;
}) {
  jest.resetModules();
  const success = {
    text: options.providerResult ?? "hello",
    logprobs: [],
  };
  const create = jest.fn();
  if (options.providerError) {
    create.mockRejectedValue(options.providerError as never);
  } else if (options.providerErrorOnce) {
    create
      .mockRejectedValueOnce(options.providerErrorOnce as never)
      .mockResolvedValue(success as never);
  } else {
    create.mockResolvedValue(success as never);
  }
  const handlers = new Map<string, (...args: unknown[]) => void>();

  jest.doMock("node:fs", () => ({
    ...jest.requireActual<typeof import("node:fs")>("node:fs"),
    createReadStream: jest.fn(() => ({})),
    existsSync: jest.fn(() => true),
    unlinkSync: jest.fn(),
    writeFileSync: jest.fn(),
  }));
  jest.doMock("fluent-ffmpeg", () => ({
    __esModule: true,
    default: jest.fn(() => ({
      inputFormat: jest.fn().mockReturnThis(),
      inputOptions: jest.fn().mockReturnThis(),
      outputOptions: jest.fn().mockReturnThis(),
      on: jest.fn(function (
        event: string,
        callback: (...args: unknown[]) => void,
      ) {
        handlers.set(event, callback);
        return this;
      }),
      save: jest.fn(() => {
        if (options.conversionError) {
          handlers.get("error")?.(options.conversionError);
        } else {
          handlers.get("end")?.();
        }
      }),
    })),
  }));
  jest.doMock("../../src/services/transcriptionPromptService", () => ({
    getTranscriptionPrompt: jest.fn().mockResolvedValue({
      prompt: "",
      langfusePrompt: undefined,
    }),
    getTranscriptionCleanupPrompt: jest.fn(),
    getTranscriptionCoalescePrompt: jest.fn(),
  }));
  jest.doMock("../../src/services/openaiClient", () => ({
    createOpenAIClient: jest.fn(() => ({
      audio: { transcriptions: { create } },
    })),
  }));
  jest.doMock("../../src/services/modelFactory", () => ({
    getModelChoice: jest.fn(() => ({ model: "mock-transcription" })),
  }));
  jest.doMock("../../src/services/meetingModelOverrides", () => ({
    getMeetingModelOverrides: jest.fn(),
  }));
  jest.doMock("../../src/services/langfuseClient", () => ({
    isLangfuseTracingEnabled: jest.fn(() => false),
  }));
  jest.doMock("bottleneck", () => ({
    __esModule: true,
    default: class BottleneckMock {
      schedule(task: () => Promise<unknown>) {
        return task();
      }
    },
  }));
  jest.doMock("cockatiel", () => ({
    bulkhead: jest.fn(() => ({})),
    circuitBreaker: jest.fn(() => ({})),
    retry: jest.fn(() => ({})),
    wrap: jest.fn(() => ({
      execute: async (fn: () => Promise<unknown>) => {
        try {
          return await fn();
        } catch {
          return await fn();
        }
      },
    })),
    ConsecutiveBreaker: jest.fn(),
    ExponentialBackoff: jest.fn(),
    handleAll: {},
  }));

  return await import("../../src/services/transcriptionService");
}

describe("transcribeSnippet terminal result", () => {
  test("returns successful empty text as a completed transcription", async () => {
    const service = await loadModule({ providerResult: "" });
    await expect(service.transcribeSnippet(meeting, snippet)).resolves.toEqual({
      status: "succeeded",
      text: "",
    });
  });

  test("returns a terminal provider failure without placeholder content", async () => {
    const service = await loadModule({
      providerError: { status: 503, secret: "request body" },
    });
    await expect(service.transcribeSnippet(meeting, snippet)).resolves.toEqual({
      status: "failed",
      reason: "transcription_error",
    });
  });

  test("returns success when a provider retry recovers", async () => {
    const service = await loadModule({
      providerErrorOnce: { status: 503 },
      providerResult: "recovered",
    });
    await expect(service.transcribeSnippet(meeting, snippet)).resolves.toEqual({
      status: "succeeded",
      text: "recovered",
    });
  });

  test("distinguishes conversion failure from provider failure", async () => {
    const service = await loadModule({ conversionError: new Error("bad pcm") });
    await expect(service.transcribeSnippet(meeting, snippet)).resolves.toEqual({
      status: "failed",
      reason: "conversion_error",
    });
  });
});
