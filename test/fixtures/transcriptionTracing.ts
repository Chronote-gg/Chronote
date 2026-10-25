import { Readable } from "node:stream";
import { setImmediate } from "node:timers";
import type { ClientOptions } from "openai";
import type { BulkheadPolicy } from "cockatiel";
import type {
  Transcription,
  TranscriptionCreateParamsNonStreaming,
} from "openai/resources/audio";
import type { MeetingData } from "../../src/types/meeting-data";
import type { SnippetTranscriptionResult } from "../../src/types/audio";
import type { TranscriptionContentInput } from "../../src/services/transcriptionService";

const EVENT_TIMEOUT_MS = 1_000;
const ATTACHMENT_WARNING = "Failed to attach transcription audio to Langfuse.";

export const deferred = <T>() => Promise.withResolvers<T>();

export async function waitFor<T>(
  event: Promise<T>,
  label: string,
  timeoutMs = EVENT_TIMEOUT_MS,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      event,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Missing tracing event: ${label}`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export const flushTurn = () =>
  new Promise<void>((resolve) => setImmediate(resolve));

export type AttachmentFailure = "helper" | "update" | "warning";
type FixtureOptions = {
  queued?: boolean;
  attachmentFailure?: AttachmentFailure;
  realPolicies?: boolean;
  transport?: NonNullable<ClientOptions["fetch"]>;
  accountingFailure?: boolean;
};

type ObservationUpdate = {
  input?: Record<string, unknown>;
  model?: string;
  modelParameters?: Record<string, unknown>;
  output?: unknown;
  usageDetails?: Record<string, number>;
  metadata?: Record<string, unknown>;
};

export const validResponse: Transcription = {
  text: "The team approved the revised delivery schedule.",
  logprobs: [{ token: "The", logprob: -0.1, bytes: [84, 104, 101] }],
  usage: {
    type: "tokens",
    input_tokens: 23,
    output_tokens: 11,
    total_tokens: 34,
  },
};

function mockAudioFiles(
  attachment: ReturnType<typeof deferred<void>>,
  events: string[],
) {
  const mp3Deleted = jest.fn(() => {
    events.push("mp3-deleted");
  });
  const wavDeleted = jest.fn(() => {
    events.push("wav-deleted");
  });
  const pcmDeleted = jest.fn();
  const inputClosed = jest.fn();
  jest.doMock("node:fs", () => {
    const fs = jest.requireActual<typeof import("node:fs")>("node:fs");
    return {
      ...fs,
      existsSync: () => true,
      writeFileSync: jest.fn(),
      unlinkSync: (file: string) =>
        file.endsWith(".wav") ? wavDeleted() : pcmDeleted(),
      createReadStream: () => {
        const stream = Readable.from([Buffer.from("synthetic wav")]);
        stream.once("close", inputClosed);
        return stream;
      },
      promises: {
        ...fs.promises,
        stat: async () => ({ size: 12 }),
        readFile: async () => Buffer.alloc(12),
        unlink: async () => mp3Deleted(),
      },
    };
  });
  jest.doMock("fluent-ffmpeg", () => ({
    __esModule: true,
    default: () => {
      const handlers = new Map<string, (error?: unknown) => void>();
      const command = {
        inputOptions: () => command,
        outputOptions: () => command,
        audioCodec: () => command,
        toFormat: () => command,
        kill: jest.fn(),
        on: (event: string, callback: (error?: unknown) => void) => {
          handlers.set(event, callback);
          return command;
        },
        save: (output: string) => {
          if (output.endsWith(".mp3")) {
            void attachment.promise.then(
              () => {
                events.push("encoder-settled");
                handlers.get("end")?.();
              },
              (error) => handlers.get("error")?.(error),
            );
          } else {
            handlers.get("end")?.();
          }
          return command;
        },
      };
      return command;
    },
  }));
  jest.doMock("../../src/services/tempFileService", () => ({
    ensureMeetingTempDirSync: () => "/synthetic/tracing",
  }));
  return { mp3Deleted, wavDeleted, pcmDeleted, inputClosed };
}

function mockObservation(options: FixtureOptions, events: string[]) {
  const state: ObservationUpdate = {};
  const usageRecorded = deferred<void>();
  const attachmentRecorded = deferred<void>();
  const generationStarted = jest.fn();
  const generationEnded = jest.fn(() => {
    events.push("generation-ended");
  });
  const update = jest.fn((value: ObservationUpdate) => {
    if (value.usageDetails && options.accountingFailure) {
      throw new Error("accounting observation failed");
    }
    if (value.input?.audio && options.attachmentFailure === "update") {
      throw new Error("attachment update failed");
    }
    const metadata = { ...state.metadata, ...value.metadata };
    Object.assign(state, value, { metadata });
    if (value.input?.audio) {
      events.push("attachment-recorded");
      attachmentRecorded.resolve();
    }
    if (value.usageDetails) {
      events.push("usage-recorded");
      usageRecorded.resolve();
    }
  });
  jest.doMock("@langfuse/tracing", () => ({
    propagateAttributes: (_attributes: unknown, run: () => unknown) => run(),
    updateActiveObservation: update,
    startActiveObservation: async (_name: string, run: () => unknown) => {
      generationStarted();
      try {
        return await run();
      } finally {
        generationEnded();
      }
    },
  }));
  return {
    state,
    update,
    usageRecorded: usageRecorded.promise,
    attachmentRecorded: attachmentRecorded.promise,
    generationStarted,
    generationEnded,
  };
}

function mockScheduling(
  queue: ReturnType<typeof deferred<void>>,
  realPolicies = false,
) {
  const executionEntered = deferred<void>();
  const attachmentQueued = deferred<void>();
  const policyRejected = jest.fn();
  const bulkheadCreated = deferred<BulkheadPolicy>();
  jest.doMock("bottleneck", () => ({
    __esModule: true,
    default: class ControlledScheduler {
      constructor(private options: { maxConcurrent?: number }) {}
      schedule<T>(run: () => Promise<T>) {
        if (this.options.maxConcurrent === 1) {
          attachmentQueued.resolve();
          return queue.promise.then(run);
        }
        return Promise.resolve().then(run);
      }
    },
  }));
  if (realPolicies) {
    jest.doMock("cockatiel", () => {
      const actual =
        jest.requireActual<typeof import("cockatiel")>("cockatiel");
      return {
        ...actual,
        bulkhead: (...args: Parameters<typeof actual.bulkhead>) => {
          const policy = actual.bulkhead(...args);
          bulkheadCreated.resolve(policy);
          return policy;
        },
      };
    });
    jest.dontMock("bottleneck");
  } else {
    jest.doMock("cockatiel", () => {
      const actual =
        jest.requireActual<typeof import("cockatiel")>("cockatiel");
      const observe = async <T>(run: () => Promise<T>) => {
        executionEntered.resolve();
        try {
          return await run();
        } catch (error) {
          policyRejected(error);
          throw error;
        }
      };
      return {
        ...actual,
        bulkhead: () => ({ execute: observe }),
        wrap: () => ({ execute: observe }),
      };
    });
  }
  const waitForQueuedJobs = async (count: number) => {
    const policy = await bulkheadCreated.promise;
    const expectedSlots = 100 - count;
    const deadline = Date.now() + EVENT_TIMEOUT_MS;
    while (policy.queueSlots !== expectedSlots && Date.now() < deadline) {
      await flushTurn();
    }
    expect(policy.executionSlots).toBe(0);
    expect(policy.queueSlots).toBe(expectedSlots);
  };
  return {
    executionEntered: executionEntered.promise,
    attachmentQueued: attachmentQueued.promise,
    policyRejected,
    waitForQueuedJobs,
  };
}

function mockProvider(realTransport: boolean) {
  const provider = deferred<Transcription>();
  const providerEntered = deferred<void>();
  const providerSettled = deferred<void>();
  const create = jest.fn(
    async (
      request: TranscriptionCreateParamsNonStreaming<"json">,
      options: { signal: AbortSignal },
    ) => {
      expect(options.signal.aborted).toBe(false);
      if (!request.prompt) return validResponse;
      providerEntered.resolve();
      try {
        return await provider.promise;
      } finally {
        providerSettled.resolve();
      }
    },
  );
  if (realTransport) {
    jest.dontMock("../../src/services/openaiClient");
  } else {
    jest.doMock("../../src/services/openaiClient", () => ({
      createOpenAIClient: () => ({ audio: { transcriptions: { create } } }),
    }));
  }
  jest.doMock("../../src/services/modelFactory", () => ({
    getModelChoice: () => ({ model: "gpt-4o-transcribe" }),
  }));
  jest.doMock("../../src/services/meetingModelOverrides", () => ({
    getMeetingModelOverrides: () => undefined,
  }));
  jest.doMock("../../src/services/langfuseClient", () => ({
    isLangfuseTracingEnabled: () => true,
  }));
  jest.doMock("../../src/services/transcriptionPromptService", () => ({}));
  jest.doMock("../../src/services/openaiChatService", () => ({}));
  jest.doMock("syllable", () => ({ syllable: () => 12 }));
  return {
    provider,
    create,
    providerEntered: providerEntered.promise,
    providerSettled: providerSettled.promise,
  };
}

function mockAttachment(
  attachment: ReturnType<typeof deferred<void>>,
  options: FixtureOptions,
) {
  const attachmentEntered = deferred<void>();
  const helperStarted = jest.fn();
  const attachmentError = new Error("attachment preparation failed");
  jest.doMock("../../src/observability/langfuseAudioAttachment", () => {
    const actual = jest.requireActual<
      typeof import("../../src/observability/langfuseAudioAttachment")
    >("../../src/observability/langfuseAudioAttachment");
    return {
      buildLangfuseTranscriptionAudioAttachment: async (file: string) => {
        helperStarted(file);
        attachmentEntered.resolve();
        if (
          options.attachmentFailure === "helper" ||
          options.attachmentFailure === "warning"
        ) {
          await attachment.promise;
          throw attachmentError;
        }
        return actual.buildLangfuseTranscriptionAudioAttachment(file);
      },
    };
  });
  return { attachmentEntered: attachmentEntered.promise, helperStarted };
}

export async function buildTracingFixture(options: FixtureOptions = {}) {
  jest.resetModules();
  const events: string[] = [];
  const attachment = deferred<void>();
  const queue = deferred<void>();
  if (!options.queued) queue.resolve();
  const files = mockAudioFiles(attachment, events);
  const observation = mockObservation(options, events);
  const scheduling = mockScheduling(queue, options.realPolicies);
  const provider = mockProvider(Boolean(options.transport));
  const transport = options.transport
    ? jest.spyOn(globalThis, "fetch").mockImplementation(options.transport)
    : undefined;
  const helper = mockAttachment(attachment, options);
  const originalWarn = console.warn.bind(console);
  const warning = jest.spyOn(console, "warn");
  if (options.attachmentFailure === "warning") {
    warning.mockImplementation((message, ...args) => {
      if (message === ATTACHMENT_WARNING) throw new Error("warning failed");
      originalWarn(message, ...args);
    });
  }
  const unhandled = jest.fn();
  process.on("unhandledRejection", unhandled);
  const lifetime = await import("../../src/services/meetingProcessingLifetime");
  const service = await import("../../src/services/transcriptionService");
  const owner = {} as MeetingData;
  const signal = lifetime.getMeetingProcessingSignal(owner);
  const preparePrompt = jest.fn(async () => ({
    prompt: "  Project Orion delivery terminology.  ",
    langfusePrompt: undefined,
    source: "fallback" as const,
  }));
  const input: TranscriptionContentInput = {
    meetingId: "tracing-meeting",
    creator: { id: "creator" },
    guild: { id: "guild" },
    voiceChannel: { id: "voice" },
    signal,
    prompt: preparePrompt,
    effect: (run) => lifetime.runMeetingProcessingEffect(owner, run),
  };
  const tasks: Promise<SnippetTranscriptionResult>[] = [];
  const transcribe = (overrides: Partial<TranscriptionContentInput> = {}) => {
    const task = lifetime.runMeetingProcessingEffect(owner, () =>
      service.transcribeContentSnippet(
        { ...input, ...overrides },
        {
          userId: "speaker",
          timestamp: 123,
          chunks: [Buffer.alloc(192_000)],
        },
        {
          noiseGateEnabledOverride: false,
          suppressionEnabledOverride: false,
        },
      ),
    );
    tasks.push(task);
    return task;
  };
  const dispose = async () => {
    attachment.resolve();
    queue.resolve();
    provider.provider.resolve(validResponse);
    try {
      await waitFor(Promise.allSettled(tasks), "fixture cleanup");
      await flushTurn();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
      warning.mockRestore();
      transport?.mockRestore();
    }
  };
  return {
    ...files,
    ...observation,
    ...scheduling,
    ...provider,
    ...helper,
    attachment,
    releaseQueue: () => queue.resolve(),
    events,
    signal,
    warning,
    preparePrompt,
    transcribe,
    stop: () => lifetime.stopMeetingProcessing(owner),
    dispose,
  };
}

export type TracingFixture = Awaited<ReturnType<typeof buildTracingFixture>>;

export async function withTracingFixture(
  options: FixtureOptions,
  run: (fixture: TracingFixture) => Promise<void>,
) {
  const fixture = await buildTracingFixture(options);
  try {
    await run(fixture);
  } finally {
    await fixture.dispose();
  }
}
