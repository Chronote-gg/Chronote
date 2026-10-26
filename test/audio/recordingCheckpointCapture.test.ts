/** @jest-environment node */
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createRecordingCheckpointCapture,
  getCheckpointPcmBudget,
} from "../../src/services/recordingCheckpointCapture";
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

test("process budget includes queued bytes and scratch across meetings", async () => {
  const held = jest.fn(
    (_a: readonly CheckpointArtifactInput[], signal: AbortSignal) =>
      new Promise<boolean>((resolve) =>
        signal.addEventListener("abort", () => resolve(false), { once: true }),
      ),
  );
  const a = fixture(held);
  const b = fixture(held);
  const large = Buffer.alloc(5760000);
  expect(a.capture.push("a", large, 0)).toBe(true);
  expect(b.capture.push("b", large, 0)).toBe(true);
  expect(a.capture.push("c", large, 0)).toBe(false);
  expect(getCheckpointPcmBudget().reservedBytes).toBeLessThanOrEqual(
    64 * 1024 * 1024,
  );
  a.controller.abort();
  b.controller.abort();
  await jest.advanceTimersByTimeAsync(0);
  a.capture.releaseSettledBuffers();
  b.capture.releaseSettledBuffers();
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
    if (sequence < 4)
      f.capture.queueContent({
        kind: "context",
        sourceId: "context",
        sequence,
        bytes: Buffer.from("{}"),
        checksumSha256: "a".repeat(64),
        contentType: "application/json",
        coverage: { kind: "unknown" },
      });
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
