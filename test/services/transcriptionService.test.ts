import { describe, expect, test, jest } from "@jest/globals";
import type { MeetingData } from "../../src/types/meeting-data";
import type { TranscriptVariant } from "../../src/types/audio";

const buildMeeting = (): MeetingData =>
  ({
    meetingId: "meeting-1",
    creator: { id: "user-1" },
    guild: { id: "guild-1" },
    voiceChannel: { id: "voice-1" },
    runtimeConfig: {
      modelParams: {},
      modelChoices: {},
    },
  }) as MeetingData;

const loadModule = async () => {
  jest.resetModules();
  const getTranscriptionCleanupPrompt = jest.fn().mockResolvedValue({
    messages: [{ role: "system", content: "cleanup" }],
    langfusePrompt: { name: "cleanup", version: 1, isFallback: false },
  });
  const getTranscriptionCoalescePrompt = jest.fn().mockResolvedValue({
    messages: [{ role: "system", content: "coalesce" }],
    langfusePrompt: { name: "coalesce", version: 1, isFallback: false },
  });
  const chat = jest.fn().mockResolvedValue("cleaned");
  const getModelChoice = jest.fn(() => ({ model: "gpt-5.1" }));

  jest.doMock("../../src/services/transcriptionPromptService", () => ({
    getTranscriptionCleanupPrompt,
    getTranscriptionCoalescePrompt,
  }));
  jest.doMock("../../src/services/openaiChatService", () => ({ chat }));
  jest.doMock("../../src/services/modelFactory", () => ({ getModelChoice }));
  jest.doMock("../../src/services/meetingModelOverrides", () => ({
    getMeetingModelOverrides: jest.fn(),
  }));
  jest.doMock("bottleneck", () => ({
    __esModule: true,
    default: class BottleneckMock {
      schedule(task: () => Promise<unknown>) {
        return Promise.resolve().then(task);
      }
    },
  }));
  jest.doMock("cockatiel", () => ({
    bulkhead: jest.fn(() => ({})),
    circuitBreaker: jest.fn(() => ({})),
    retry: jest.fn(() => ({})),
    wrap: jest.fn(() => ({ execute: (fn: () => Promise<unknown>) => fn() })),
    ConsecutiveBreaker: jest.fn(),
    ExponentialBackoff: jest.fn(),
    handleAll: jest.fn(),
  }));

  const module = await import("../../src/services/transcriptionService");
  return {
    module,
    chat,
    getTranscriptionCleanupPrompt,
    getTranscriptionCoalescePrompt,
    getModelChoice,
  };
};

describe("transcriptionService", () => {
  test("cleanupTranscription uses the cleanup prompt and chat", async () => {
    const { module, chat, getTranscriptionCleanupPrompt, getModelChoice } =
      await loadModule();
    const meeting = buildMeeting();

    const output = await module.cleanupTranscription(meeting, "raw transcript");

    expect(output).toBe("cleaned");
    expect(getTranscriptionCleanupPrompt).toHaveBeenCalledWith(
      meeting,
      "raw transcript",
    );
    expect(getModelChoice).toHaveBeenCalledWith(
      "transcriptionCleanup",
      undefined,
    );
    expect(chat).toHaveBeenCalledWith(
      meeting,
      { messages: [{ role: "system", content: "cleanup" }] },
      expect.objectContaining({
        traceName: "transcription-cleanup",
        generationName: "transcription-cleanup",
        modelParamRole: "transcriptionCleanup",
      }),
    );
  });

  test("coalesceTranscription uses the coalesce prompt and chat", async () => {
    const { module, chat, getTranscriptionCoalescePrompt, getModelChoice } =
      await loadModule();
    const meeting = buildMeeting();
    const input = {
      slowTranscript: "slow text",
      fastTranscripts: [
        {
          revision: 1,
          text: "fast text",
          createdAt: "2025-01-01T00:00:00.000Z",
        } as TranscriptVariant,
      ],
    };

    const output = await module.coalesceTranscription(meeting, input);

    expect(output).toBe("cleaned");
    expect(getTranscriptionCoalescePrompt).toHaveBeenCalledWith(meeting, input);
    expect(getModelChoice).toHaveBeenCalledWith(
      "transcriptionCoalesce",
      undefined,
    );
    expect(chat).toHaveBeenCalledWith(
      meeting,
      { messages: [{ role: "system", content: "coalesce" }] },
      expect.objectContaining({
        traceName: "transcription-coalesce",
        generationName: "transcription-coalesce",
        modelParamRole: "transcriptionCoalesce",
      }),
    );
  });
});
