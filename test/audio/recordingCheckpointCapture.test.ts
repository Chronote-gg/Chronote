/** @jest-environment node */
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CAPTURE_PCM_LIMIT_BYTES,
  PCM_RESERVED_COPIES,
  createRecordingCheckpointCapture,
  getCheckpointPcmBudget,
  releaseCheckpointPcm,
  reserveCheckpointPcm,
} from "../../src/services/recordingCheckpointCapture";
import type * as LifecycleTiming from "../../src/services/lifecycleTiming";
import type { CheckpointArtifactInput } from "../../src/types/recordingCheckpoint";

let directory: string;
beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(0);
  directory = mkdtempSync(path.join(tmpdir(), "checkpoint-capture-"));
});
afterEach(() => {
  jest.useRealTimers();
  rmSync(directory, { recursive: true, force: true });
});
function fixture(
  commit = jest.fn<
    Promise<boolean>,
    [readonly CheckpointArtifactInput[], AbortSignal]
  >(async () => true),
) {
  const controller = new AbortController();
  const stopped = jest.fn();
  const capture = createRecordingCheckpointCapture({
    directory,
    startedAt: 0,
    signal: controller.signal,
    commit,
    stopCapture: stopped,
  });
  return { capture, controller, commit, stopped };
}
const pcm = () => Buffer.alloc(3840, 1);
const PRESSURE_PCM_BYTES = CAPTURE_PCM_LIMIT_BYTES / 2 / PCM_RESERVED_COPIES;
/** Other meetings hold the budget up to `headroom` PCM bytes below the pressure line. */
function otherMeetingsHoldBelowPressure(headroom: number) {
  const bytes = PRESSURE_PCM_BYTES - headroom;
  expect(reserveCheckpointPcm(bytes)).toBe(true);
  return () => releaseCheckpointPcm(bytes);
}
const contextSnapshot = (sequence: number): CheckpointArtifactInput => ({
  kind: "context",
  sourceId: "context",
  sequence,
  bytes: Buffer.from("{}"),
  checksumSha256: "a".repeat(64),
  contentType: "application/json",
  coverage: { kind: "unknown" },
});

test("finish waits for the already scheduled save retry", async () => {
  jest.useRealTimers();
  const commit = jest
    .fn<Promise<boolean>, [readonly CheckpointArtifactInput[], AbortSignal]>()
    .mockResolvedValueOnce(false)
    .mockResolvedValue(true);
  const f = fixture(commit);
  f.capture.queueContent(contextSnapshot(1));
  await f.capture.settled();
  let result: boolean | undefined;
  const finishing = f.capture.finish().then((value) => {
    result = value;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(result).toBeUndefined();
  await finishing;
  expect(result).toBe(true);
  expect(commit).toHaveBeenCalledTimes(3);
  f.controller.abort();
  await f.capture.settled();
  f.capture.releaseSettledBuffers();
});

test("finish preserves failed bytes after the existing three attempts", async () => {
  jest.useRealTimers();
  const commit = jest.fn(async () => false);
  const f = fixture(commit);
  f.capture.queueContent(contextSnapshot(1));
  expect(await f.capture.finish()).toBe(false);
  expect(commit).toHaveBeenCalledTimes(3);
  expect(f.capture.pending()).toHaveLength(1);
  expect(readdirSync(directory)).toEqual(["context-1.json"]);
  f.controller.abort();
  await f.capture.settled();
  f.capture.releaseSettledBuffers();
});

test("ownership loss cancels a stop waiting for its save retry", async () => {
  jest.useRealTimers();
  const commit = jest.fn(async () => false);
  const f = fixture(commit);
  f.capture.queueContent(contextSnapshot(1));
  await f.capture.settled();
  let settled = false;
  const finishing = f.capture.finish().then((value) => {
    settled = true;
    return value;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(settled).toBe(false);
  f.controller.abort();
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve("abort wait timed out"), 500);
  });
  try {
    expect(await Promise.race([finishing, timeout])).toBe(false);
  } finally {
    clearTimeout(timer!);
  }
  expect(commit).toHaveBeenCalledTimes(1);
  expect(f.capture.pending()).toHaveLength(1);
  await f.capture.settled();
  f.capture.releaseSettledBuffers();
});

test("a retired capture publishes, retries and reports nothing more and frees its buffers", async () => {
  let commitSignal: AbortSignal | undefined;
  const commit = jest.fn(
    (_artifacts: readonly CheckpointArtifactInput[], signal: AbortSignal) => {
      commitSignal = signal;
      return new Promise<boolean>((resolve) =>
        signal.addEventListener("abort", () => resolve(false), { once: true }),
      );
    },
  );
  const f = fixture(commit);
  const before = getCheckpointPcmBudget().reservedBytes;
  f.capture.push("user", pcm(), 0);
  f.capture.queueContent(contextSnapshot(1));
  await jest.advanceTimersByTimeAsync(30_000);
  expect(commit).toHaveBeenCalled();

  f.capture.retire();

  expect(commitSignal?.aborted).toBe(true);
  expect(getCheckpointPcmBudget().reservedBytes).toBe(before);
  expect(f.capture.push("user", pcm(), 31_000)).toBe(false);
  expect(f.capture.queueContent(contextSnapshot(2))).toBe(false);
  const calls = commit.mock.calls.length;
  await jest.advanceTimersByTimeAsync(120_000);
  expect(commit).toHaveBeenCalledTimes(calls);
  expect(f.stopped).not.toHaveBeenCalled();
  f.controller.abort();
  await jest.advanceTimersByTimeAsync(0);
  expect(f.stopped).not.toHaveBeenCalled();
  expect(f.capture.pending()).toEqual([]);
});

test("a failed local write stops the capture", async () => {
  const stopped = jest.fn();
  const snapshot = contextSnapshot(1);
  // The capture writes exclusively, so an existing file makes the write fail.
  writeFileSync(
    path.join(directory, `${snapshot.kind}-${snapshot.sequence}.json`),
    "",
  );
  const capture = createRecordingCheckpointCapture({
    directory,
    startedAt: 0,
    signal: new AbortController().signal,
    commit: async () => true,
    stopCapture: stopped,
  });
  expect(capture.queueContent(snapshot)).toBe(false);
  expect(stopped).toHaveBeenCalledWith(
    "storage_preservation",
    expect.objectContaining({ cause: "local_write_failed" }),
  );
  await capture.settled();
});

test.each([true, false])(
  "superseded snapshots are removed only when their replacement is acknowledged (%s)",
  async (replacementAccepted) => {
    let finishFirst!: (value: boolean) => void;
    const first = new Promise<boolean>((resolve) => {
      finishFirst = resolve;
    });
    const commit = jest
      .fn<Promise<boolean>, [readonly CheckpointArtifactInput[], AbortSignal]>()
      .mockImplementationOnce(() => first)
      .mockResolvedValue(replacementAccepted);
    const f = fixture(commit);
    const queue = (sequence: number) =>
      f.capture.queueContent(contextSnapshot(sequence));
    queue(1);
    await Promise.resolve();
    queue(2);
    queue(3);
    queue(4);
    expect(readdirSync(directory).sort()).toEqual([
      "context-1.json",
      "context-2.json",
      "context-3.json",
      "context-4.json",
    ]);
    finishFirst(true);
    await f.capture.settled();
    expect(readdirSync(directory).sort()).toEqual(
      replacementAccepted
        ? []
        : ["context-2.json", "context-3.json", "context-4.json"],
    );
    expect(commit.mock.calls.map(([items]) => items[0].sequence)).toEqual([
      1, 4,
    ]);
    f.capture.fence();
    await f.capture.settled();
    f.capture.releaseSettledBuffers();
  },
);

test("sustained storage pressure keeps new audio frames batched", async () => {
  let resume!: () => void;
  const storage = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const f = fixture(
    jest.fn<
      Promise<boolean>,
      [readonly CheckpointArtifactInput[], AbortSignal]
    >(async () => {
      await storage;
      return true;
    }),
  );
  const releaseOthers = otherMeetingsHoldBelowPressure(8 * 1024 * 1024);
  try {
    f.capture.push("first", Buffer.alloc(5760000), 0);
    f.capture.push("second", Buffer.alloc(2650000), 0);
    for (let frame = 0; frame < 100; frame++)
      f.capture.push("first", pcm(), frame * 20);

    expect(f.capture.pending()).toHaveLength(2);
  } finally {
    resume();
    await f.capture.finish();
    f.capture.releaseSettledBuffers();
    releaseOthers();
  }
  expect(
    f.commit.mock.calls
      .flatMap(([artifacts]) => artifacts)
      .reduce((bytes, artifact) => bytes + artifact.bytes.byteLength, 0),
  ).toBe(5760000 + 2650000 + 100 * 3840);
});

test("longOpenSnippetStillCheckpointsAtThirtySeconds", async () => {
  const f = fixture();
  f.capture.push("user", pcm(), 0);
  await jest.advanceTimersByTimeAsync(30000);
  expect(f.commit).toHaveBeenCalledTimes(1);
  expect(f.commit.mock.calls[0][0][0].coverage).toEqual({
    kind: "known",
    intervals: [{ sourceId: "user", startOffsetMs: 0, durationMs: 20 }],
  });
  expect(f.capture.snapshot().queuedBytes).toBe(0);
  await f.capture.finish();
});

test("a piece is sealed after the lifecycle's checkpoint segment period", async () => {
  const segmentMs = 5_000;
  await jest.isolateModulesAsync(async () => {
    jest.doMock("../../src/services/lifecycleTiming", () => {
      const actual = jest.requireActual<typeof LifecycleTiming>(
        "../../src/services/lifecycleTiming",
      );
      return {
        ...actual,
        LIFECYCLE: { ...actual.LIFECYCLE, checkpointSegmentMs: segmentMs },
      };
    });
    const capture =
      await import("../../src/services/recordingCheckpointCapture");
    const commit = jest.fn(async () => true);
    const recording = capture.createRecordingCheckpointCapture({
      directory,
      startedAt: 0,
      signal: new AbortController().signal,
      commit,
      stopCapture: jest.fn(),
    });
    recording.push("user", pcm(), 0);
    await jest.advanceTimersByTimeAsync(segmentMs - 1);
    expect(commit).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(commit).toHaveBeenCalledTimes(1);
    await recording.finish();
  });
});

test("botAudioUsesSameDurableCoverage", async () => {
  const f = fixture();
  f.capture.push("bot", pcm(), 15);
  f.capture.push("user", pcm(), 15);
  await jest.advanceTimersByTimeAsync(30000);
  const artifacts = f.commit.mock.calls.flatMap(([items]) => items);
  expect(artifacts.map((a) => a.sourceId).sort()).toEqual(["bot", "user"]);
  expect(
    artifacts.every(
      (a) =>
        a.coverage.kind === "known" &&
        a.coverage.intervals[0].startOffsetMs === 15,
    ),
  ).toBe(true);
  await f.capture.finish();
});

test("silenceDoesNotClaimSpeech", async () => {
  const f = fixture();
  await jest.advanceTimersByTimeAsync(60000);
  expect(f.commit).not.toHaveBeenCalled();
  expect(f.stopped).not.toHaveBeenCalled();
  await f.capture.finish();
});

test("sixtySecondsWithoutPreservationStopsCapture", async () => {
  let rejectRequest: (() => void) | undefined;
  const commit = jest.fn(
    (_artifacts: readonly CheckpointArtifactInput[], signal: AbortSignal) =>
      new Promise<boolean>((resolve) => {
        rejectRequest = () => resolve(false);
        signal.addEventListener("abort", () => resolve(false), { once: true });
      }),
  );
  const f = fixture(commit);
  f.capture.push("user", pcm(), 0);
  await jest.advanceTimersByTimeAsync(59999);
  expect(f.stopped).not.toHaveBeenCalled();
  await jest.advanceTimersByTimeAsync(1);
  expect(f.stopped).toHaveBeenCalledTimes(1);
  expect(f.capture.push("user", pcm(), 60000)).toBe(false);
  expect(f.capture.snapshot().queuedBytes).toBe(3840);
  rejectRequest?.();
  f.capture.releaseSettledBuffers();
});

test("uploadFailureDoesNotDeleteLocalTail", async () => {
  const f = fixture(
    jest.fn<
      Promise<boolean>,
      [readonly CheckpointArtifactInput[], AbortSignal]
    >(async () => false),
  );
  f.capture.push("user", pcm(), 0);
  await jest.advanceTimersByTimeAsync(60000);
  expect(readdirSync(directory)).toHaveLength(1);
  expect(f.capture.snapshot().queuedBytes).toBe(3840);
  expect(f.commit).toHaveBeenCalledTimes(3);
  f.capture.releaseSettledBuffers();
});

const heldCommit = () =>
  jest.fn(
    (_artifacts: readonly CheckpointArtifactInput[], signal: AbortSignal) =>
      new Promise<boolean>((resolve) =>
        signal.addEventListener("abort", () => resolve(false), { once: true }),
      ),
  );
const largestChunk = () => Buffer.alloc(5760000);
async function releaseHeld(...captures: Array<ReturnType<typeof fixture>>) {
  for (const f of captures) f.controller.abort();
  await jest.advanceTimersByTimeAsync(0);
  for (const f of captures) f.capture.releaseSettledBuffers();
}
const PCM_BYTES_PER_SECOND = 192000;
const BUSY_MEETING_SECONDS = 43;

/** One speaker's unconfirmed audio, in the largest chunks a capture accepts. */
function holdSpeech(f: ReturnType<typeof fixture>, speaker: string) {
  const chunk = largestChunk();
  const tail = Buffer.alloc(
    BUSY_MEETING_SECONDS * PCM_BYTES_PER_SECOND - chunk.length,
  );
  return f.capture.push(speaker, chunk, 0) && f.capture.push(speaker, tail, 0);
}

test("eight busy meetings with unconfirmed audio all fit the capture budget", async () => {
  // At the old 64 MiB limit the third of these meetings was refused.
  const meetings = Array.from({ length: 8 }, () => fixture(heldCommit()));
  meetings.forEach((f, index) =>
    expect(holdSpeech(f, `speaker${index}`)).toBe(true),
  );
  expect(getCheckpointPcmBudget().reservedBytes).toBe(
    8 * BUSY_MEETING_SECONDS * PCM_BYTES_PER_SECOND * PCM_RESERVED_COPIES,
  );
  for (const f of meetings) expect(f.stopped).not.toHaveBeenCalled();
  const overflow = fixture(heldCommit());
  expect(holdSpeech(overflow, "overflow")).toBe(false);
  expect(overflow.stopped).toHaveBeenCalledWith(
    "storage_preservation",
    expect.objectContaining({ cause: "shared_budget" }),
  );
  await releaseHeld(...meetings, overflow);
  expect(getCheckpointPcmBudget().reservedBytes).toBe(0);
});

test.each([
  {
    cause: "invalid_chunk",
    act: (f: ReturnType<typeof fixture>) =>
      f.capture.push("user", Buffer.alloc(3), 0),
  },
  {
    cause: "source_bound",
    act: (f: ReturnType<typeof fixture>) => {
      f.capture.push("user", largestChunk(), 0);
      f.capture.push("user", largestChunk(), 0);
      f.capture.push("user", pcm(), 0);
    },
  },
  {
    cause: "unconfirmed_age",
    act: async (f: ReturnType<typeof fixture>) => {
      f.capture.push("user", pcm(), 0);
      await jest.advanceTimersByTimeAsync(60000);
    },
  },
  {
    cause: "playback_tap",
    act: (f: ReturnType<typeof fixture>) => f.capture.interrupt(),
  },
])(
  "a capture stopped for $cause reports that cause",
  async ({ cause, act }) => {
    const f = fixture(heldCommit());
    await act(f);
    expect(f.stopped).toHaveBeenCalledTimes(1);
    expect(f.stopped).toHaveBeenCalledWith(
      "storage_preservation",
      expect.objectContaining({
        cause,
        pcmLimitBytes: CAPTURE_PCM_LIMIT_BYTES,
      }),
    );
    await releaseHeld(f);
  },
);

test("a capture refused by the shared budget reports the budget and the refused chunk", async () => {
  const a = fixture(heldCommit());
  a.capture.push("a", largestChunk(), 0);
  const filler =
    (CAPTURE_PCM_LIMIT_BYTES - getCheckpointPcmBudget().reservedBytes) /
    PCM_RESERVED_COPIES;
  expect(reserveCheckpointPcm(filler)).toBe(true);

  expect(a.capture.push("c", largestChunk(), 0)).toBe(false);

  expect(a.stopped).toHaveBeenCalledWith("storage_preservation", {
    cause: "shared_budget",
    pcmReservedBytes: CAPTURE_PCM_LIMIT_BYTES,
    pcmLimitBytes: CAPTURE_PCM_LIMIT_BYTES,
    refusedChunkBytes: 5760000,
  });
  releaseCheckpointPcm(filler);
  await releaseHeld(a);
  expect(getCheckpointPcmBudget().reservedBytes).toBe(0);
});

test("completed text remains publishable after complete PCM capture", async () => {
  const f = fixture();
  f.capture.push("user", pcm());
  expect(await f.capture.finish()).toBe(true);
  const bytes = Buffer.from("completed usable text");
  expect(
    f.capture.queueContent({
      kind: "transcription",
      sourceId: "transcription",
      sequence: 0,
      bytes,
      checksumSha256: "a".repeat(64),
      contentType: "application/json",
      coverage: { kind: "unknown" },
    }),
  ).toBe(true);
  await f.capture.drainContent();
  expect(
    f.commit.mock.calls
      .flatMap(([items]) => items)
      .some((item) => item.kind === "transcription"),
  ).toBe(true);
  expect(f.capture.push("user", pcm())).toBe(false);
  f.controller.abort();
  await f.capture.settled();
  f.capture.releaseSettledBuffers();
});

test("fenced capture rejects late content while preserving original-owner tail authority", async () => {
  const f = fixture();
  f.capture.push("user", pcm());
  f.capture.fence();
  expect(f.controller.signal.aborted).toBe(false);
  expect(
    f.capture.queueContent({
      kind: "transcription",
      sourceId: "transcription",
      sequence: 0,
      bytes: Buffer.from("late"),
      checksumSha256: "a".repeat(64),
      contentType: "application/json",
      coverage: { kind: "unknown" },
    }),
  ).toBe(false);
  expect(await f.capture.finish()).toBe(false);
  expect(f.capture.pending()).toHaveLength(1);
  expect(f.stopped).not.toHaveBeenCalled();
  f.capture.releaseSettledBuffers();
});

test("synchronous context enqueue cannot reenter the active PCM publisher", async () => {
  const commit = jest.fn<
    Promise<boolean>,
    [readonly CheckpointArtifactInput[], AbortSignal]
  >(async () => {
    const sequence = commit.mock.calls.length;
    if (sequence < 4) f.capture.queueContent(contextSnapshot(sequence));
    return false;
  });
  const f = fixture(commit);
  f.capture.push("user", Buffer.alloc(5760000), 0);
  await f.capture.settled();
  const calls = commit.mock.calls.length;
  const kinds = f.capture.pending().map(({ artifact }) => artifact.kind);
  f.capture.fence();
  await f.capture.settled();
  f.capture.releaseSettledBuffers();
  expect(calls).toBe(1);
  expect(kinds).toEqual(["audio", "context"]);
  expect(getCheckpointPcmBudget().reservedBytes).toBe(0);
});

test.each(["size", "age", "pressure"])(
  "sample cursor survives %s rotation, jitter and a real observed gap",
  async (rotation) => {
    const f = fixture();
    const duration =
      rotation === "age" ? 20 : rotation === "pressure" ? 15000 : 30000;
    // Only the second meeting's chunk crosses the pressure line.
    const releaseOthers = otherMeetingsHoldBelowPressure(
      rotation === "pressure" ? largestChunk().length : PRESSURE_PCM_BYTES,
    );
    f.capture.push("user", Buffer.alloc(192 * duration), 0);
    if (rotation === "age") await jest.advanceTimersByTimeAsync(30000);
    if (rotation === "pressure")
      f.capture.push("other", Buffer.alloc(5760000), 0);
    f.capture.push("user", pcm(), duration - 1);
    f.capture.push("user", pcm(), duration - 1);
    f.capture.push("user", pcm(), duration + 1000);
    expect(await f.capture.finish()).toBe(true);
    const artifacts = f.commit.mock.calls
      .flatMap(([items]) => items)
      .filter((a) => a.sourceId === "user");
    const intervals = artifacts.flatMap((a) =>
      a.coverage.kind === "known" ? a.coverage.intervals : [],
    );
    for (let i = 1; i < intervals.length; i++)
      expect(intervals[i].startOffsetMs).toBeGreaterThanOrEqual(
        intervals[i - 1].startOffsetMs + intervals[i - 1].durationMs,
      );
    expect(intervals.reduce((sum, item) => sum + item.durationMs, 0)).toBe(
      duration + 60,
    );
    releaseOthers();
    expect(intervals.at(-1)!.startOffsetMs).toBe(duration + 1000);
    const adjusted = artifacts.find(
      (a) => a.kind === "audio" && a.timing?.maxCursorAdjustmentMs === 21,
    );
    expect(adjusted).toBeDefined();
    f.capture.releaseSettledBuffers();
  },
);

test("backward observed clock is retained honestly without overlapping PCM", async () => {
  const f = fixture();
  f.capture.push("user", pcm(), 0);
  expect(f.capture.push("user", pcm(), -10)).toBe(true);
  expect(await f.capture.finish()).toBe(true);
  const artifact = f.commit.mock.calls.flatMap(([items]) => items)[0];
  expect(artifact.coverage).toEqual({
    kind: "known",
    intervals: [{ sourceId: "user", startOffsetMs: 0, durationMs: 40 }],
  });
  expect(artifact).toMatchObject({
    timing: {
      basis: "sample_cursor_with_observed_gaps",
      observedFirstOffsetMs: 0,
      observedLastOffsetMs: -10,
      maxCursorAdjustmentMs: 30,
    },
  });
  f.capture.releaseSettledBuffers();
});

test("normal 21ms cadence batches storage while preserving every byte interval and speech gap", async () => {
  const f = fixture();
  for (let i = 0; i < 1000; i++) {
    expect(f.capture.push("user:123", Buffer.alloc(3840, i % 251))).toBe(true);
    await jest.advanceTimersByTimeAsync(21);
  }
  await jest.advanceTimersByTimeAsync(5000);
  f.capture.push("user:123", Buffer.alloc(3840, 252));
  expect(await f.capture.finish()).toBe(true);
  const artifacts = f.commit.mock.calls.flatMap(([items]) => items);
  expect(artifacts).toHaveLength(1);
  const artifact = artifacts[0];
  if (artifact.coverage.kind !== "known") throw new Error("coverage missing");
  expect(artifact.coverage.intervals).toHaveLength(1001);
  expect(artifact.coverage.intervals.at(-1)).toMatchObject({
    startOffsetMs: 26000,
    durationMs: 20,
  });
  artifact.coverage.intervals.forEach((interval, i) => {
    expect(interval.durationMs).toBe(20);
    expect(
      Buffer.from(artifact.bytes.subarray(i * 3840, (i + 1) * 3840)),
    ).toEqual(Buffer.alloc(3840, i === 1000 ? 252 : i % 251));
  });
  expect(f.stopped).not.toHaveBeenCalled();
  expect(getCheckpointPcmBudget().reservedBytes).toBe(0);
  f.capture.releaseSettledBuffers();
});

test("accepted PCM returns exact immutable piece offsets before publication", async () => {
  const f = fixture();
  const spans: unknown[] = [];
  try {
    expect(
      f.capture.push("user:speaker", pcm(), 0, (span) => spans.push(span)),
    ).toBe(true);
    expect(
      f.capture.push("user:speaker", pcm(), 20, (span) => spans.push(span)),
    ).toBe(true);
    expect(spans).toEqual([
      { sourceId: "user:speaker", sequence: 0, startByte: 0, endByte: 3840 },
      { sourceId: "user:speaker", sequence: 0, startByte: 3840, endByte: 7680 },
    ]);
    await jest.advanceTimersByTimeAsync(30000);
    expect(
      f.capture.push("user:speaker", pcm(), 30000, (span) => spans.push(span)),
    ).toBe(true);
    expect(spans[2]).toEqual({
      sourceId: "user:speaker",
      sequence: 1,
      startByte: 0,
      endByte: 3840,
    });
    expect(spans[0]).toEqual({
      sourceId: "user:speaker",
      sequence: 0,
      startByte: 0,
      endByte: 3840,
    });
    f.capture.fence();
    expect(
      f.capture.push("user:speaker", pcm(), 30020, (span) => spans.push(span)),
    ).toBe(false);
    expect(spans).toHaveLength(3);
  } finally {
    f.capture.fence();
    await f.capture.settled();
    f.capture.releaseSettledBuffers();
  }
});
