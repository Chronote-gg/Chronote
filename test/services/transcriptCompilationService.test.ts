/** @jest-environment node */
import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import type { Client } from "discord.js";
import type { MeetingData } from "../../src/types/meeting-data";
import type { ChatPromptResult } from "../../src/services/langfusePromptService";
import type { SavedRecordingSettings } from "../../src/types/recordingContent";
import { chat } from "../../src/services/openaiChatService";
import { getTranscriptionCleanupPrompt } from "../../src/services/transcriptionPromptService";
import { updateActiveObservation } from "@langfuse/tracing";
import * as constants from "../../src/constants";
import {
  compileTranscriptions,
  createMeetingTranscriptCompiler,
} from "../../src/services/transcriptCompilationService";

const cleanupSettings: {
  readonly TRANSCRIPTION_CLEANUP_LINES_DIFFERENCE_ISSUE: number;
} = constants;

type CleanupModel = SavedRecordingSettings["models"]["transcriptionCleanup"];
const mockModel: CleanupModel = {
  provider: "openai",
  model: "synthetic-cleanup-model",
  params: { temperature: 0.2, verbosity: "low" },
};
jest.mock("../../src/services/openaiChatService", () => ({ chat: jest.fn() }));
jest.mock("../../src/services/transcriptionPromptService", () => ({
  getTranscriptionCleanupPrompt: jest.fn(),
}));
jest.mock("../../src/services/modelFactory", () => ({
  ...jest.requireActual<typeof import("../../src/services/modelFactory")>(
    "../../src/services/modelFactory",
  ),
  getModelChoice: () => ({
    provider: mockModel.provider,
    model: mockModel.model,
  }),
}));
jest.mock("../../src/services/openaiModelParams", () => ({
  resolveChatParamsForRole: () => mockModel.params,
}));
jest.mock("@langfuse/tracing", () => ({
  ...jest.requireActual<typeof import("@langfuse/tracing")>(
    "@langfuse/tracing",
  ),
  updateActiveObservation: jest.fn(),
}));

const HEADER =
  "NOTICE: Transcription is automatically generated and may not be perfectly accurate!\n" +
  "-----------------------------------------------------------------------------------\n";
const ACCEPTED =
  "Accepted first line\nAccepted second line\nAccepted third line";
const prompt: ChatPromptResult = {
  messages: [{ role: "system", content: "Synthetic cleanup context" }],
  langfusePrompt: { name: "synthetic-cleanup", version: 1, isFallback: false },
  source: "langfuse",
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function buildCompilerFixture(options: { cues?: { text: string }[] } = {}) {
  const files = [0, 1, 2].map((index) => ({
    userId: "speaker",
    timestamp: 1000 + index * 1000,
    transcript: `Synthetic words ${index + 1}`,
    processing: false,
    audioOnlyProcessing: false,
  }));
  const meeting = {
    meetingId: "synthetic-meeting",
    creator: { id: "creator" },
    guild: { id: "synthetic-guild", members: { cache: new Map() } },
    voiceChannel: { id: "synthetic-voice" },
    participants: new Map(),
    audioData: {
      audioFiles: files,
      currentSnippets: new Map(),
      cueEvents: options.cues?.map((cue) => ({
        ...cue,
        userId: "cue-speaker",
        timestamp: 500,
      })),
    },
    runtimeConfig: {
      premiumTranscription: { enabled: true, cleanupEnabled: true },
      modelChoices: {},
      modelParams: {},
    },
  } as unknown as MeetingData;
  const client = { users: { cache: new Map() } } as unknown as Client;
  const ack =
    jest.fn<(outcome: "acknowledged" | "fallback" | "disabled") => void>();
  const original = files
    .map(
      (file) =>
        `[speaker @ ${new Date(file.timestamp).toLocaleString()}]: ${
          file.transcript
        }`,
    )
    .join("\n");
  return { client, meeting, files, ack, cleanup: jest.mocked(chat), original };
}
function holdNextCleanup(f: ReturnType<typeof buildCompilerFixture>) {
  const entered = deferred<void>();
  const pending = deferred<string>();
  f.cleanup.mockImplementationOnce(() => {
    entered.resolve();
    return pending.promise;
  });
  return { entered, pending };
}
beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(chat).mockReset().mockResolvedValue(ACCEPTED);
  jest
    .mocked(getTranscriptionCleanupPrompt)
    .mockReset()
    .mockImplementation(async () => prompt);
  jest.mocked(updateActiveObservation).mockReset();
  mockModel.model = "synthetic-cleanup-model";
  mockModel.params = { temperature: 0.2, verbosity: "low" };
  jest.replaceProperty(
    cleanupSettings,
    "TRANSCRIPTION_CLEANUP_LINES_DIFFERENCE_ISSUE",
    0.8,
  );
  prompt.messages = [{ role: "system", content: "Synthetic cleanup context" }];
  prompt.langfusePrompt = {
    name: "synthetic-cleanup",
    version: 1,
    isFallback: false,
  };
});

afterEach(() => {
  jest.restoreAllMocks();
});

test.each([undefined, [], [{ text: "" }]])(
  "reuses accepted equivalent cleanup with cues %j",
  async (cues) => {
    const f = buildCompilerFixture({ cues });
    const compile = createMeetingTranscriptCompiler(f.client, f.meeting);
    const notes = await compile({ cleanupAcknowledged: f.ack });
    const upload = await compile({ includeCues: true });
    expect(upload).toBe(notes);
    expect(f.cleanup).toHaveBeenCalledTimes(1);
    expect(f.ack).toHaveBeenLastCalledWith("acknowledged");
    expect(updateActiveObservation).toHaveBeenLastCalledWith({
      metadata: { transcriptionCleanupReuseHit: true },
    });
  },
);

type Fixture = ReturnType<typeof buildCompilerFixture>;
const misses: [string, (f: Fixture) => void][] = [
  [
    "transcript",
    (f) => {
      f.files[0].transcript = "Changed synthetic words";
    },
  ],
  [
    "speaker",
    (f) => {
      f.meeting.participants.set("speaker", {
        id: "speaker",
        username: "speaker",
        displayName: "Synthetic speaker",
      });
    },
  ],
  [
    "timestamp",
    (f) => {
      f.files[0].timestamp += 60_000;
    },
  ],
  [
    "rendered messages",
    () => {
      prompt.messages[0].content = "Changed synthetic context";
    },
  ],
  [
    "prompt name",
    () => {
      prompt.langfusePrompt!.name = "other-synthetic-cleanup";
    },
  ],
  [
    "prompt version",
    () => {
      prompt.langfusePrompt!.version++;
    },
  ],
  [
    "prompt fallback",
    () => {
      prompt.langfusePrompt!.isFallback = true;
    },
  ],
  [
    "model",
    () => {
      mockModel.model = "other-synthetic-model";
    },
  ],
  [
    "params",
    () => {
      mockModel.params.temperature = 0.5;
    },
  ],
  [
    "retention ratio",
    () => {
      jest.replaceProperty(
        cleanupSettings,
        "TRANSCRIPTION_CLEANUP_LINES_DIFFERENCE_ISSUE",
        0.7,
      );
    },
  ],
];
test.each(misses)(
  "changed %s invalidates the accepted result",
  async (_name, change) => {
    const f = buildCompilerFixture();
    const compile = createMeetingTranscriptCompiler(f.client, f.meeting);
    await compile();
    change(f);
    f.cleanup.mockResolvedValueOnce(
      "Second accepted line\nSecond accepted line\nSecond accepted line",
    );
    const output = await compile();
    expect(output).toBe(
      HEADER +
        "Second accepted line\nSecond accepted line\nSecond accepted line",
    );
    expect(f.cleanup).toHaveBeenCalledTimes(2);
  },
);
test.each(["Synthetic cue", "   "])(
  "meaningful cue %j invalidates reuse",
  async (text) => {
    const f = buildCompilerFixture({ cues: [{ text }] });
    const compile = createMeetingTranscriptCompiler(f.client, f.meeting);
    await compile();
    f.cleanup.mockResolvedValueOnce(
      "Accepted cue\nAccepted first\nAccepted second\nAccepted third",
    );
    await compile({ includeCues: true });
    expect(f.cleanup).toHaveBeenCalledTimes(2);
    const messages = f.cleanup.mock.calls[1][1].messages;
    expect(getTranscriptionCleanupPrompt).toHaveBeenLastCalledWith(
      f.meeting,
      `[cue-speaker @ ${new Date(500).toLocaleString()}]: ${text}\n${
        f.original
      }`,
    );
    expect(messages).toEqual(prompt.messages);
  },
);
test("copied equivalent params with reversed insertion order reuse the accepted result", async () => {
  const f = buildCompilerFixture();
  const compile = createMeetingTranscriptCompiler(f.client, f.meeting);
  const first = await compile();
  mockModel.params = { verbosity: "low", temperature: 0.2 };
  expect(await compile()).toBe(first);
  expect(f.cleanup).toHaveBeenCalledTimes(1);
});
test("a successful unchanged transcript is reusable and keeps the exact header", async () => {
  const f = buildCompilerFixture();
  f.cleanup.mockResolvedValue(f.original);
  const compile = createMeetingTranscriptCompiler(f.client, f.meeting);
  expect(await compile({ cleanupAcknowledged: f.ack })).toBe(
    HEADER + f.original,
  );
  expect(await compile({ cleanupAcknowledged: f.ack })).toBe(
    HEADER + f.original,
  );
  expect(f.cleanup).toHaveBeenCalledTimes(1);
  expect(f.ack.mock.calls).toEqual([["acknowledged"], ["acknowledged"]]);
});
test.each(["provider rejection", "retention rejection"])(
  "%s leaves a second compilation its retry opportunity",
  async (failure) => {
    const f = buildCompilerFixture();
    if (failure === "provider rejection") {
      f.cleanup.mockRejectedValueOnce(new Error("Synthetic provider failure"));
    } else {
      f.cleanup.mockResolvedValueOnce("Too few lines");
    }
    const compile = createMeetingTranscriptCompiler(f.client, f.meeting);
    const firstOutput = await compile({ cleanupAcknowledged: f.ack });
    const firstAcknowledgement = f.ack.mock.calls[0][0];
    const originalWithHeader = HEADER + f.original;
    const acceptedWithHeader = HEADER + ACCEPTED;
    const secondOutput = await compile({ cleanupAcknowledged: f.ack });
    expect(firstOutput).toBe(originalWithHeader);
    expect(firstAcknowledgement).toBe("fallback");
    expect(secondOutput).toBe(acceptedWithHeader);
    expect(f.cleanup).toHaveBeenCalledTimes(2);
    expect(f.ack).toHaveBeenLastCalledWith("acknowledged");
  },
);
test.each(["empty", "disabled"])(
  "%s input does no cleanup work",
  async (kind) => {
    const f = buildCompilerFixture();
    if (kind === "empty") f.meeting.audioData.audioFiles = [];
    else f.meeting.runtimeConfig!.premiumTranscription.cleanupEnabled = false;
    const compile = createMeetingTranscriptCompiler(f.client, f.meeting);
    const output = await compile({ cleanupAcknowledged: f.ack });
    expect(output).toBe(kind === "empty" ? "" : HEADER + f.original);
    expect(f.cleanup).not.toHaveBeenCalled();
    expect(getTranscriptionCleanupPrompt).not.toHaveBeenCalled();
    expect(f.ack).toHaveBeenCalledWith("disabled");
  },
);
test("separate compiler closures for the same meeting do not share accepted output", async () => {
  const f = buildCompilerFixture();
  await createMeetingTranscriptCompiler(f.client, f.meeting)();
  await createMeetingTranscriptCompiler(f.client, f.meeting)();
  expect(f.cleanup).toHaveBeenCalledTimes(2);
});
test("standalone compilation gets a fresh lifetime on every call", async () => {
  const f = buildCompilerFixture();
  await compileTranscriptions(f.client, f.meeting);
  await compileTranscriptions(f.client, f.meeting);
  expect(f.cleanup).toHaveBeenCalledTimes(2);
});
test("an unsettled cleanup is never reused", async () => {
  const f = buildCompilerFixture();
  const { entered, pending } = holdNextCleanup(f);
  const compile = createMeetingTranscriptCompiler(f.client, f.meeting);
  const first = compile();
  await entered.promise;
  expect(await compile()).toBe(HEADER + ACCEPTED);
  pending.resolve(ACCEPTED);
  await first;
  expect(f.cleanup).toHaveBeenCalledTimes(2);
});
test("abort before a reuse hit prevents successful return", async () => {
  const f = buildCompilerFixture();
  const controller = new AbortController();
  f.meeting.ownershipSignal = controller.signal;
  const compile = createMeetingTranscriptCompiler(f.client, f.meeting);
  await compile();
  const reason = new Error("Synthetic cancellation");
  controller.abort(reason);
  await expect(compile({ cleanupAcknowledged: f.ack })).rejects.toBe(reason);
  expect(f.cleanup).toHaveBeenCalledTimes(1);
  expect(f.ack).not.toHaveBeenCalled();
});
test("abort during preparation prevents provider dispatch", async () => {
  const f = buildCompilerFixture();
  const controller = new AbortController();
  f.meeting.ownershipSignal = controller.signal;
  const entered = deferred<void>();
  const pending = deferred<ChatPromptResult>();
  jest.mocked(getTranscriptionCleanupPrompt).mockImplementationOnce(() => {
    entered.resolve();
    return pending.promise;
  });
  const compilation = createMeetingTranscriptCompiler(
    f.client,
    f.meeting,
  )({ cleanupAcknowledged: f.ack });
  await entered.promise;
  const reason = new Error("Synthetic preparation cancellation");
  controller.abort(reason);
  pending.resolve(prompt);
  await expect(compilation).rejects.toBe(reason);
  expect(f.cleanup).not.toHaveBeenCalled();
  expect(f.ack).not.toHaveBeenCalled();
});
test("abort after provider settlement prevents admission", async () => {
  const f = buildCompilerFixture();
  const controller = new AbortController();
  f.meeting.ownershipSignal = controller.signal;
  const reason = new Error("Synthetic settlement cancellation");
  f.cleanup.mockImplementationOnce(async () => {
    controller.abort(reason);
    return ACCEPTED;
  });
  const compile = createMeetingTranscriptCompiler(f.client, f.meeting);
  await expect(compile({ cleanupAcknowledged: f.ack })).rejects.toBe(reason);
  expect(f.ack).not.toHaveBeenCalled();
  f.meeting.ownershipSignal = new AbortController().signal;
  expect(await compile()).toBe(HEADER + ACCEPTED);
  expect(f.cleanup).toHaveBeenCalledTimes(2);
});
test("a late file stays outside the transcript while cleanup is held", async () => {
  const f = buildCompilerFixture();
  const { entered, pending } = holdNextCleanup(f);
  const compilation = createMeetingTranscriptCompiler(f.client, f.meeting)();
  await entered.promise;
  f.meeting.audioData.audioFiles.push({
    userId: "late-speaker",
    timestamp: 4000,
    transcript: "Late synthetic words",
    processing: false,
    audioOnlyProcessing: false,
  });
  pending.resolve(ACCEPTED);
  expect(await compilation).toBe(HEADER + ACCEPTED);
  expect(getTranscriptionCleanupPrompt).toHaveBeenCalledWith(
    f.meeting,
    f.original,
  );
});
test("reuse diagnostics cannot change a successful compilation", async () => {
  const f = buildCompilerFixture();
  const compile = createMeetingTranscriptCompiler(f.client, f.meeting);
  const first = await compile();
  jest.mocked(updateActiveObservation).mockImplementationOnce(() => {
    throw new Error("Synthetic diagnostics failure");
  });
  expect(await compile()).toBe(first);
  expect(f.cleanup).toHaveBeenCalledTimes(1);
});
