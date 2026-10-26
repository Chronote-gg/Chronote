/** @jest-environment node */
import { jest } from "@jest/globals";
jest.mock("dotenv", () => ({ config: jest.fn() }));
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
  holdConversion?: boolean;
  unlinkError?: Error;
}) {
  jest.resetModules();
  const success = {
    text: options.providerResult ?? "hello",
    logprobs: [],
  };
  const { default: OpenAI } = await import("openai");
  const providerError = (details: { status?: number }) =>
    new OpenAI.APIError(
      details.status,
      { message: "synthetic provider failure" },
      "synthetic provider failure",
      new Headers({ "retry-after-ms": "0" }),
    );
  const create = jest.fn();
  if (options.providerError) {
    create.mockRejectedValue(providerError(options.providerError) as never);
  } else if (options.providerErrorOnce) {
    create
      .mockRejectedValueOnce(providerError(options.providerErrorOnce) as never)
      .mockResolvedValue(success as never);
  } else {
    create.mockResolvedValue(success as never);
  }
  const kill = jest.fn();
  const handlers = new Map<string, (...args: unknown[]) => void>();

  const unlinkSync = options.unlinkError
    ? jest
        .fn()
        .mockImplementationOnce(() => {
          throw options.unlinkError;
        })
        .mockImplementation(() => undefined)
    : jest.fn();
  jest.doMock("node:fs", () => ({
    ...jest.requireActual<typeof import("node:fs")>("node:fs"),
    createReadStream: jest.fn(() =>
      jest
        .requireActual<typeof import("node:stream")>("node:stream")
        .Readable.from([Buffer.from("synthetic")]),
    ),
    existsSync: jest.fn(() => true),
    unlinkSync,
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
      kill,
      save: jest.fn(() => {
        if (options.holdConversion) return;
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
    ...jest.requireActual<typeof import("cockatiel")>("cockatiel"),
    bulkhead: () => ({ execute: (run: () => Promise<unknown>) => run() }),
    wrap: () => ({ execute: (run: () => Promise<unknown>) => run() }),
  }));

  return {
    service: await import("../../src/services/transcriptionService"),
    unlinkSync,
    create,
    kill,
    handlers,
    lifetime: await import("../../src/services/meetingProcessingLifetime"),
  };
}

describe("transcribeSnippet terminal result", () => {
  test("returns successful empty text as a completed transcription", async () => {
    const { service } = await loadModule({ providerResult: "" });
    await expect(service.transcribeSnippet(meeting, snippet)).resolves.toEqual({
      status: "succeeded",
      text: "",
    });
  });

  test("returns a terminal provider failure without placeholder content", async () => {
    const { service } = await loadModule({
      providerError: { status: 503, secret: "request body" },
    });
    await expect(service.transcribeSnippet(meeting, snippet)).resolves.toEqual({
      status: "failed",
      reason: "transcription_error",
    });
  });

  test("returns success when a provider retry recovers", async () => {
    const { service } = await loadModule({
      providerErrorOnce: { status: 503 },
      providerResult: "recovered",
    });
    await expect(service.transcribeSnippet(meeting, snippet)).resolves.toEqual({
      status: "succeeded",
      text: "recovered",
    });
  });

  test("distinguishes conversion failure from provider failure", async () => {
    const { service } = await loadModule({
      conversionError: new Error("bad pcm"),
    });
    await expect(service.transcribeSnippet(meeting, snippet)).resolves.toEqual({
      status: "failed",
      reason: "conversion_error",
    });
  });

  test("preserves success and attempts both cleanups when one unlink fails", async () => {
    const { service, unlinkSync } = await loadModule({
      providerResult: "kept",
      unlinkError: new Error("locked"),
    });

    await expect(service.transcribeSnippet(meeting, snippet)).resolves.toEqual({
      status: "succeeded",
      text: "kept",
    });
    expect(unlinkSync).toHaveBeenCalledTimes(2);
  });

  test("preserves terminal failure and attempts both cleanups when one unlink fails", async () => {
    const { service, unlinkSync } = await loadModule({
      providerError: { status: 503 },
      unlinkError: new Error("locked"),
    });

    await expect(service.transcribeSnippet(meeting, snippet)).resolves.toEqual({
      status: "failed",
      reason: "transcription_error",
    });
    expect(unlinkSync).toHaveBeenCalledTimes(2);
  });
});

test("interruption reaches the issued transcription SDK call and retains its actual lifetime", async () => {
  const { service, create, lifetime } = await loadModule({});
  let resolve!: (value: { text: string; logprobs: never[] }) => void;
  let started!: () => void;
  const dispatched = new Promise<void>((done) => {
    started = done;
  });
  create.mockImplementationOnce(() => {
    started();
    return new Promise((done) => {
      resolve = done;
    });
  });
  const owned = lifetime.runMeetingProcessingEffect(meeting, () =>
    service.transcribeSnippet(meeting, snippet),
  );
  await dispatched;
  const options = create.mock.calls[0][1] as
    { signal?: AbortSignal } | undefined;
  expect(options?.signal?.aborted).toBe(false);
  let settled = false;
  const stopped = lifetime.stopMeetingProcessing(meeting).then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(options?.signal?.aborted).toBe(true);
  expect(settled).toBe(false);
  const diagnostic = jest.spyOn(console, "error").mockImplementation(() => {});
  resolve({ text: "late provider result", logprobs: [] });
  await expect(owned).resolves.toMatchObject({ status: "failed" });
  await stopped;
  expect(create).toHaveBeenCalledTimes(1);
  diagnostic.mockRestore();
});

test("conversion cancellation waits for observed encoder termination before deleting input", async () => {
  const { service, create, kill, handlers, unlinkSync, lifetime } =
    await loadModule({ holdConversion: true });
  const owned = lifetime.runMeetingProcessingEffect(meeting, () =>
    service.transcribeSnippet(meeting, snippet),
  );
  const diagnostic = jest.spyOn(console, "error").mockImplementation(() => {});
  let settled = false;
  const drain = lifetime.stopMeetingProcessing(meeting).then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(kill).toHaveBeenCalledWith("SIGTERM");
  expect(settled).toBe(false);
  expect(unlinkSync).not.toHaveBeenCalled();
  handlers.get("end")!();
  await expect(owned).resolves.toMatchObject({ status: "failed" });
  await drain;
  expect(create).not.toHaveBeenCalled();
  expect(unlinkSync).toHaveBeenCalledTimes(2);
  diagnostic.mockRestore();
});
