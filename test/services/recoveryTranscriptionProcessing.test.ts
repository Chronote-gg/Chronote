/** @jest-environment node */
import { completedTextResponse as mockCompletedTextResponse } from "../../src/testSupport/openaiResponse";
jest.mock("dotenv", () => ({ config: () => ({ parsed: {} }) }));
jest.mock("../../src/services/transcriptionService", () => ({
  ...jest.requireActual("../../src/services/transcriptionService"),
  transcribeContentSnippet: jest.fn(async () => ({
    status: "succeeded",
    text: "New verified interval.",
  })),
}));
import {
  capturePcmBudget,
  createRecordingCheckpointCapture,
  PCM_RESERVED_COPIES,
} from "../../src/services/recordingCheckpointCapture";
import { transcribeContentSnippet } from "../../src/services/transcriptionService";
jest.mock("../../src/services/mixedPcmService", () => ({
  renderMixedPcmTracks: jest.fn(async (_tracks, output) => output),
}));
jest.mock("../../src/services/openaiClient", () => ({
  buildOpenAISafetyIdentifier: (id: string) => id,
  createOpenAIClient: jest.fn(() => ({
    responses: {
      create: jest.fn(async () =>
        mockCompletedTextResponse("Original saved cleanup result."),
      ),
    },
  })),
}));
import { createHash } from "node:crypto";
import { recoveryFixture } from "./meetingRecoveryFixtures";
import {
  readRecoveryContent,
  recoverTranscript,
  recoveryPcmBudget,
} from "../../src/services/meetingRecoveryContent";
import { LIFECYCLE } from "../../src/services/lifecycleTiming";
import { PROCESSING_RETRY_MAX_CONCURRENT } from "../../src/constants";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { renderMixedPcmTracks } from "../../src/services/mixedPcmService";
import { generationContextSchema } from "../../src/types/recordingContent";
import { createOpenAIClient } from "../../src/services/openaiClient";
async function fixture(complete = false) {
  const f = await recoveryFixture();
  const controller = new AbortController();
  const signal = controller.signal;
  const content = await readRecoveryContent(f.claim.history, f.reader, signal);
  if (content.context.settings.availability !== "available")
    throw new Error("settings");
  content.context.settings.value.processing = {
    cleanupMinimumRetainedLineRatio: 0.75,
  };
  content.context.settings.value.premiumTranscription = {
    enabled: true,
    cleanupEnabled: true,
  };
  content.context.context.transcriptionFormattedContext =
    "Frozen transcription context";
  content.context.context.transcriptionMaxContextLength = 1000;
  content.context.cleanupRoleNames = "Frozen role names";
  const prompt = {
    availability: "available" as const,
    value: {
      type: "chat" as const,
      name: "frozen-cleanup",
      version: 31,
      label: "original",
      template: [
        {
          role: "user" as const,
          content: "{{formattedContext}} {{roles}} {{transcription}}",
        },
      ],
    },
  };
  content.context.prompts.cleanup = prompt;
  if (complete) {
    content.manifest.captureState = {
      kind: "complete",
      startedAt: f.claim.history.timestamp,
      endedAt: "2026-01-01T00:00:01Z",
    };
    const bytes = Buffer.alloc(192000);
    const object = {
      key: "generated-audio",
      byteLength: bytes.length,
      checksumSha256: createHash("sha256").update(bytes).digest("hex"),
    };
    f.objects.set(object.key, bytes);
    const audio = {
      kind: "audio" as const,
      sourceId: "user:123",
      sequence: 0,
      contentType: "audio/pcm",
      object,
      format: {
        encoding: "pcm_s16le" as const,
        channels: 2,
        sampleRate: 48000,
      },
      coverage: {
        kind: "known" as const,
        intervals: [
          { sourceId: "user:123", startOffsetMs: 0, durationMs: 1000 },
        ],
      },
    };
    content.verified.push(audio);
    content.manifest.artifacts.push(audio);
    for (const entry of content.entries ?? [])
      entry.correspondence = {
        kind: "pcm",
        spans: [
          { sourceId: "user:123", sequence: 0, startByte: 0, endByte: 192000 },
        ],
      };
  }
  return { ...f, content, signal, controller };
}
beforeEach(() => jest.clearAllMocks());
test("partial capture uses frozen cleanup", async () => {
  const f = await fixture();
  expect(
    await recoverTranscript(f.content, f.reader, f.signal, (run) => run()),
  ).toMatchObject({ text: "Original saved cleanup result." });
  expect(f.content.processing).toEqual({
    cleanup: "acknowledged",
    finalText: "Original saved cleanup result.",
  });
  expect(createOpenAIClient).toHaveBeenCalledWith(
    expect.objectContaining({
      langfusePrompt: expect.objectContaining({ version: 31 }),
      userId: "123",
    }),
  );
  const client = jest.mocked(createOpenAIClient).mock.results[0].value;
  expect(client.responses.create).toHaveBeenCalledWith(
    expect.objectContaining({
      model: "original-model",
      input: expect.any(Array),
      store: false,
    }),
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  const sdkSignal = jest.mocked(client.responses.create).mock.calls[0][1]
    ?.signal;
  expect(sdkSignal?.aborted).toBe(false);
  f.controller.abort(new Error("cancel recovery"));
  expect(sdkSignal?.aborted).toBe(true);
});
// A recording the previous version captured carries settings, prompts and a
// processed-transcript outcome this version no longer has. It must still load,
// re-transcribe its uncovered audio without a prompt, and finish.
test("a recording saved by the previous version recovers without its removed stages", async () => {
  const f = await fixture(true);
  const legacyContext = generationContextSchema.parse({
    ...f.content.context,
    settings: {
      availability: "available",
      value: {
        ...(f.content.context.settings.availability === "available"
          ? f.content.context.settings.value
          : {}),
        processing: {
          cleanupMinimumRetainedLineRatio: 0.75,
          finalPass: { chunkSeconds: 300, repeatWindowSeconds: 180 },
        },
        models: {
          notes: { model: "original-model", provider: "openai", params: {} },
          meetingSummary: {
            model: "original-model",
            provider: "openai",
            params: {},
          },
          transcription: {
            model: "gpt-4o-transcribe",
            provider: "openai",
            params: {},
          },
          transcriptionCleanup: {
            model: "original-model",
            provider: "openai",
            params: {},
          },
          transcriptionCoalesce: {
            model: "gpt-5.6-luna",
            provider: "openai",
            params: { reasoning_effort: "low" },
          },
        },
        transcription: {
          ...(f.content.context.settings.availability === "available"
            ? f.content.context.settings.value.transcription
            : {}),
          language: "en",
          promptEchoEnabled: true,
          voteEnabled: true,
          finalPassEnabled: true,
        },
      },
    },
    prompts: {
      ...f.content.context.prompts,
      transcription: {
        availability: "available",
        value: {
          type: "text",
          name: "original-audio",
          version: 9,
          label: "original",
          template: "Original audio prompt",
        },
      },
      coalesce: { availability: "unavailable" },
      finalPass: { availability: "unavailable" },
    },
  });
  f.content.context = legacyContext;
  f.content.entries = [];
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  await recoverTranscript(f.content, f.reader, f.signal, (run) => run());
  const [input] = jest.mocked(transcribeContentSnippet).mock.calls[0];
  expect(input).not.toHaveProperty("prompt");
  expect(input.runtimeConfig?.modelChoices).toEqual({
    transcription: "gpt-transcribe",
  });
  expect(input.runtimeConfig?.transcription.language).toBe("en");
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalledWith(
    "Recovery transcription model superseded.",
    expect.objectContaining({ frozenModel: "gpt-4o-transcribe" }),
  );
  warn.mockRestore();
  expect(renderMixedPcmTracks).not.toHaveBeenCalled();
  expect(f.content.processing).toEqual({
    cleanup: "acknowledged",
    finalText: "Original saved cleanup result.",
  });
});
test("missing original processing inputs reconcile while a verified processed transcript needs no audio or provider", async () => {
  const f = await fixture();
  if (f.content.context.settings.availability !== "available")
    throw new Error("settings");
  delete f.content.context.settings.value.processing;
  await expect(
    recoverTranscript(f.content, f.reader, f.signal, (run) => run()),
  ).rejects.toThrow("Original cleanup");
  f.content.processing = {
    cleanup: "acknowledged",
    finalText: "Verified processed text",
  };
  expect(
    await recoverTranscript(f.content, f.reader, f.signal, (run) => run()),
  ).toMatchObject({ text: "Verified processed text" });
  expect(createOpenAIClient).not.toHaveBeenCalled();
});
test("legacy processed transcript with PCM reconciles before any provider replay", async () => {
  const f = await fixture(true);
  f.content.processing = {
    finalPass: "acknowledged",
    cleanup: "disabled",
    finalText: "Previously acknowledged processed text.",
  };
  await expect(
    recoverTranscript(f.content, f.reader, f.signal, (run) => run()),
  ).rejects.toThrow("overlap");
  expect(transcribeContentSnippet).not.toHaveBeenCalled();
  expect(createOpenAIClient).not.toHaveBeenCalled();
});

function addIntervalAudio(
  f: Awaited<ReturnType<typeof fixture>>,
  intervals: { startOffsetMs: number; durationMs: number }[],
) {
  if (f.content.context.settings.availability !== "available")
    throw new Error("settings");
  f.content.context.settings.value.premiumTranscription.enabled = false;
  f.content.entries = [];
  const bytes = Buffer.concat(
    intervals.map((interval, index) =>
      Buffer.alloc(Math.round(interval.durationMs * 192), (index % 250) + 1),
    ),
  );
  const object = {
    key: "generated-intervals",
    byteLength: bytes.length,
    checksumSha256: createHash("sha256").update(bytes).digest("hex"),
  };
  f.objects.set(object.key, bytes);
  const audio = {
    kind: "audio" as const,
    sourceId: "user:123",
    sequence: 0,
    contentType: "audio/pcm",
    object,
    format: { encoding: "pcm_s16le" as const, sampleRate: 48000, channels: 2 },
    coverage: {
      kind: "known" as const,
      intervals: intervals.map((interval) => ({
        sourceId: "user:123",
        ...interval,
      })),
    },
  };
  f.content.verified.push(audio);
  f.content.manifest.artifacts.push(audio);
  return audio;
}

test("1001 jittered packets use one accounted ASR chunk with exact source bytes and ephemeral gap silence", async () => {
  const f = await fixture();
  const intervals = Array.from({ length: 1001 }, (_, i) => ({
    startOffsetMs: i * 21,
    durationMs: 20,
  }));
  const audio = addIntervalAudio(f, intervals);
  const coverage = structuredClone(audio.coverage);
  jest
    .mocked(transcribeContentSnippet)
    .mockImplementationOnce(async (_input, snippet) => {
      const buffer = snippet.chunks[0];
      expect(buffer.length).toBe(21020 * 192);
      expect(recoveryPcmBudget.snapshot().reservedBytes).toBe(
        buffer.length * 4,
      );
      for (let i = 0; i < 1001; i++) {
        expect(
          buffer
            .subarray(i * 21 * 192, (i * 21 + 20) * 192)
            .equals(Buffer.alloc(3840, (i % 250) + 1)),
        ).toBe(true);
        if (i < 1000)
          expect(
            buffer
              .subarray((i * 21 + 20) * 192, (i + 1) * 21 * 192)
              .equals(Buffer.alloc(192)),
          ).toBe(true);
      }
      return { status: "succeeded", text: "Grouped real conversation." };
    });
  const result = await recoverTranscript(f.content, f.reader, f.signal, (run) =>
    run(),
  );
  expect(transcribeContentSnippet).toHaveBeenCalledTimes(1);
  expect(result.segments).toHaveLength(1);
  expect(audio.coverage).toEqual(coverage);
  expect(recoveryPcmBudget.snapshot().reservedBytes).toBe(0);
});

test("long intervals and long gaps split into at most 30s scratch with an exact final tail", async () => {
  const f = await fixture();
  addIntervalAudio(f, [
    { startOffsetMs: 0, durationMs: 31000 },
    { startOffsetMs: 90000, durationMs: 400 },
  ]);
  await recoverTranscript(f.content, f.reader, f.signal, (run) => run());
  const calls = jest.mocked(transcribeContentSnippet).mock.calls;
  expect(calls.map(([, snippet]) => snippet.chunks[0].length)).toEqual([
    30000 * 192,
    1000 * 192,
    400 * 192,
  ]);
  expect(
    calls.map(
      ([, snippet]) =>
        snippet.timestamp - Date.parse(f.claim.history.timestamp),
    ),
  ).toEqual([0, 30000, 90000]);
  expect(calls.at(-1)![1].chunks[0]).toEqual(Buffer.alloc(76800, 2));
  expect(recoveryPcmBudget.snapshot().reservedBytes).toBe(0);
});

test("scratch ownership remains charged until an aborted actual call settles", async () => {
  const f = await fixture();
  addIntervalAudio(f, [
    { startOffsetMs: 0, durationMs: 400 },
    { startOffsetMs: 90000, durationMs: 400 },
  ]);
  const controller = new AbortController();
  let settle!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    settle = resolve;
  });
  jest.mocked(transcribeContentSnippet).mockImplementationOnce(async () => {
    entered();
    await pending;
    return { status: "succeeded", text: "Owned operation settled." };
  });
  const work = recoverTranscript(
    f.content,
    f.reader,
    controller.signal,
    (run) => run(),
  );
  const rejection = expect(work).rejects.toThrow("stopped");
  await started;
  controller.abort(new Error("stopped"));
  expect(recoveryPcmBudget.snapshot().reservedBytes).toBe(76800 * 4);
  settle();
  await rejection;
  expect(recoveryPcmBudget.snapshot().reservedBytes).toBe(0);
  expect(transcribeContentSnippet).toHaveBeenCalledTimes(1);
});

test("provider failure releases scratch and cannot start the later group", async () => {
  const f = await fixture();
  addIntervalAudio(f, [
    { startOffsetMs: 0, durationMs: 400 },
    { startOffsetMs: 90000, durationMs: 400 },
  ]);
  jest
    .mocked(transcribeContentSnippet)
    .mockRejectedValueOnce(new Error("provider failed"));
  await expect(
    recoverTranscript(f.content, f.reader, f.signal, (run) => run()),
  ).rejects.toThrow("provider failed");
  expect(recoveryPcmBudget.snapshot().reservedBytes).toBe(0);
  expect(transcribeContentSnippet).toHaveBeenCalledTimes(1);
});

/** Runs `work` while `budget` is fully reserved, then frees it again. */
async function whileFull(
  budget: typeof capturePcmBudget,
  work: () => Promise<void>,
) {
  const bytes = budget.snapshot().limitBytes / PCM_RESERVED_COPIES;
  expect(budget.reserve(bytes)).toBe(true);
  try {
    await work();
  } finally {
    budget.release(bytes);
  }
  expect(budget.snapshot().reservedBytes).toBe(0);
}

test("an exhausted recovery PCM budget refuses allocation and transcription", async () => {
  const f = await fixture();
  addIntervalAudio(f, [{ startOffsetMs: 0, durationMs: 400 }]);
  await whileFull(recoveryPcmBudget, async () => {
    await expect(
      recoverTranscript(f.content, f.reader, f.signal, (run) => run()),
    ).rejects.toThrow("budget unavailable");
    expect(transcribeContentSnippet).not.toHaveBeenCalled();
  });
});

test("the recovery budget holds one largest group for every concurrent load", () => {
  const largestGroupBytes = 30 * 192000;
  const loads =
    LIFECYCLE.maxConcurrentFinishes + PROCESSING_RETRY_MAX_CONCURRENT;
  for (let load = 0; load < loads; load++)
    expect(recoveryPcmBudget.reserve(largestGroupBytes)).toBe(true);
  expect(recoveryPcmBudget.reserve(largestGroupBytes)).toBe(false);
  recoveryPcmBudget.release(loads * largestGroupBytes);
  expect(recoveryPcmBudget.snapshot().reservedBytes).toBe(0);
});

test("a full capture budget does not refuse a recovery group", async () => {
  const f = await fixture();
  addIntervalAudio(f, [{ startOffsetMs: 0, durationMs: 400 }]);
  await whileFull(capturePcmBudget, async () => {
    await recoverTranscript(f.content, f.reader, f.signal, (run) => run());
    expect(transcribeContentSnippet).toHaveBeenCalledTimes(1);
  });
  expect(recoveryPcmBudget.snapshot().reservedBytes).toBe(0);
});

test("a full recovery budget does not refuse a live capture chunk", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "budget-capture-"));
  const controller = new AbortController();
  const stopCapture = jest.fn();
  const capture = createRecordingCheckpointCapture({
    directory,
    startedAt: 0,
    signal: controller.signal,
    commit: async () => true,
    stopCapture,
  });
  try {
    await whileFull(recoveryPcmBudget, async () => {
      expect(capture.push("user", Buffer.alloc(3840), 0)).toBe(true);
      expect(stopCapture).not.toHaveBeenCalled();
    });
  } finally {
    capture.retire();
    rmSync(directory, { recursive: true, force: true });
  }
  expect(capturePcmBudget.snapshot().reservedBytes).toBe(0);
});

test.each(["alignment", "bytes", "overlap"])(
  "invalid %s mapping refuses transcription without allocating scratch",
  async (kind) => {
    const f = await fixture();
    const audio = addIntervalAudio(f, [
      { startOffsetMs: 0, durationMs: 20 },
      { startOffsetMs: 21, durationMs: 20 },
    ]);
    if (kind === "alignment") audio.coverage.intervals[0].startOffsetMs = 0.001;
    if (kind === "bytes") audio.coverage.intervals[0].durationMs = 19;
    if (kind === "overlap") audio.coverage.intervals[1].startOffsetMs = 19;
    await expect(
      recoverTranscript(f.content, f.reader, f.signal, (run) => run()),
    ).rejects.toThrow("PCM");
    expect(transcribeContentSnippet).not.toHaveBeenCalled();
    expect(recoveryPcmBudget.snapshot().reservedBytes).toBe(0);
  },
);

function representedEntry(
  f: Awaited<ReturnType<typeof fixture>>,
  text: string,
  spans: {
    sourceId: string;
    sequence: number;
    startByte: number;
    endByte: number;
  }[],
) {
  return {
    sourceId: "user:123",
    userId: "123",
    source: "voice" as const,
    timestamp: Date.parse(f.claim.history.timestamp),
    text,
    speakerLabel: "Speaker",
    completedAt: f.claim.history.timestamp,
    revision: 0,
    correspondence: { kind: "pcm" as const, spans },
  };
}
const span = (startByte: number, endByte: number, sequence = 0) => ({
  sourceId: "user:123",
  sequence,
  startByte,
  endByte,
});

test("mapped saved prefix is retained once and only its real PCM tail reaches ASR", async () => {
  const f = await fixture();
  addIntervalAudio(f, [
    { startOffsetMs: 0, durationMs: 400 },
    { startOffsetMs: 400, durationMs: 400 },
  ]);
  f.content.entries = [representedEntry(f, "Saved prefix.", [span(0, 76800)])];
  const result = await recoverTranscript(f.content, f.reader, f.signal, (run) =>
    run(),
  );
  expect(transcribeContentSnippet).toHaveBeenCalledTimes(1);
  expect(
    jest.mocked(transcribeContentSnippet).mock.calls[0][1].chunks[0],
  ).toEqual(Buffer.alloc(76800, 2));
  expect(result.text.match(/Saved prefix\./g)).toHaveLength(1);
  expect(result.segments).toHaveLength(2);
});

test("equal words and timestamps remain separate disjoint utterances", async () => {
  const f = await fixture();
  addIntervalAudio(f, [{ startOffsetMs: 0, durationMs: 40 }]);
  f.content.entries = [
    representedEntry(f, "again", [span(0, 3840)]),
    representedEntry(f, "again", [span(3840, 7680)]),
  ];
  const result = await recoverTranscript(f.content, f.reader, f.signal, (run) =>
    run(),
  );
  expect(result.segments.map((item) => item.text)).toEqual(["again", "again"]);
  expect(transcribeContentSnippet).not.toHaveBeenCalled();
});

test("represented middle input splits residual runs while preserving observed gap positions", async () => {
  const f = await fixture();
  addIntervalAudio(f, [
    { startOffsetMs: 0, durationMs: 400 },
    { startOffsetMs: 401, durationMs: 400 },
    { startOffsetMs: 802, durationMs: 400 },
  ]);
  f.content.entries = [representedEntry(f, "middle", [span(76800, 153600)])];
  await recoverTranscript(f.content, f.reader, f.signal, (run) => run());
  const calls = jest.mocked(transcribeContentSnippet).mock.calls;
  expect(calls.map(([, item]) => item.chunks[0])).toEqual([
    Buffer.alloc(76800, 1),
    Buffer.alloc(76800, 3),
  ]);
  expect(
    calls.map(
      ([, item]) => item.timestamp - Date.parse(f.claim.history.timestamp),
    ),
  ).toEqual([0, 802]);
  expect(recoveryPcmBudget.snapshot().reservedBytes).toBe(0);
});

test.each(["complete", "tail", "empty", "supplemental"] as const)(
  "acknowledged mapped finalText %s never replays its saved provider stages",
  async (kind) => {
    const f = await fixture();
    addIntervalAudio(f, [{ startOffsetMs: 0, durationMs: 40 }]);
    f.content.processing = {
      finalPass: "acknowledged",
      cleanup: "acknowledged",
      finalText: kind === "empty" ? "" : "  exact saved block\n",
      correspondence: {
        kind: "pcm",
        spans: [span(0, kind === "tail" ? 3840 : 7680)],
      },
      ...(kind === "supplemental" ? { supplementalEntries: true } : {}),
    };
    const saved = structuredClone(f.content.processing);
    if (kind === "tail" || kind === "supplemental")
      await expect(
        recoverTranscript(f.content, f.reader, f.signal, (run) => run()),
      ).rejects.toThrow("overlap");
    else
      expect(
        (await recoverTranscript(f.content, f.reader, f.signal, (run) => run()))
          .text,
      ).toBe(saved.finalText);
    expect(f.content.processing).toEqual(saved);
    expect(transcribeContentSnippet).not.toHaveBeenCalled();
    expect(createOpenAIClient).not.toHaveBeenCalled();
  },
);

test("terminal omitted input is not resurrected and a pending piece cannot cover a different sequence", async () => {
  const f = await fixture();
  addIntervalAudio(f, [{ startOffsetMs: 0, durationMs: 400 }]);
  f.content.omitted = { kind: "pcm", spans: [span(0, 76800)] };
  expect(
    (await recoverTranscript(f.content, f.reader, f.signal, (run) => run()))
      .text,
  ).toBe("");
  expect(transcribeContentSnippet).not.toHaveBeenCalled();
  delete f.content.omitted;
  f.content.entries = [
    representedEntry(f, "Open piece text", [span(0, 76800, 99)]),
  ];
  await recoverTranscript(f.content, f.reader, f.signal, (run) => run());
  expect(transcribeContentSnippet).toHaveBeenCalledTimes(1);
});

test.each([
  "unaligned",
  "out-of-bounds",
  "overlapping",
  "wrong-source",
] as const)(
  "malformed %s correspondence refuses providers and scratch",
  async (kind) => {
    const f = await fixture();
    addIntervalAudio(f, [{ startOffsetMs: 0, durationMs: 20 }]);
    let spans = [span(0, 3840)];
    if (kind === "unaligned") spans = [span(1, 3840)];
    if (kind === "out-of-bounds") spans = [span(0, 3844)];
    if (kind === "overlapping") spans = [span(0, 2000), span(1000, 3840)];
    if (kind === "wrong-source")
      spans = [{ ...span(0, 3840), sourceId: "user:other" }];
    f.content.entries = [representedEntry(f, "saved", spans)];
    await expect(
      recoverTranscript(f.content, f.reader, f.signal, (run) => run()),
    ).rejects.toThrow();
    expect(transcribeContentSnippet).not.toHaveBeenCalled();
    expect(recoveryPcmBudget.snapshot().reservedBytes).toBe(0);
  },
);

test.each(["text_only", "disjoint", "audio_only", "missing_pcm"] as const)(
  "safe %s legacy boundary remains automatic",
  async (kind) => {
    const f = await fixture();
    if (kind !== "missing_pcm")
      addIntervalAudio(f, [{ startOffsetMs: 0, durationMs: 400 }]);
    if (kind === "text_only")
      f.content.entries = [
        {
          ...representedEntry(f, "Independent text", []),
          correspondence: { kind: "text_only" },
        },
      ];
    if (kind === "disjoint") {
      const entry = {
        ...representedEntry(f, "Other source", []),
        correspondence: undefined,
      };
      f.content.entries = [
        { ...entry, sourceId: "user:other", userId: "other" },
      ];
    }
    if (kind === "missing_pcm")
      f.content.entries = [
        representedEntry(f, "Independently verified text", [span(0, 3840)]),
      ];
    await expect(
      recoverTranscript(f.content, f.reader, f.signal, (run) => run()),
    ).resolves.toHaveProperty("text");
    expect(transcribeContentSnippet).toHaveBeenCalledTimes(
      kind === "missing_pcm" ? 0 : 1,
    );
  },
);
