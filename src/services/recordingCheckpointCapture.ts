import type { PcmSpan } from "../types/transcriptCorrespondence";
import { createHash } from "node:crypto";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type {
  CheckpointArtifactInput,
  RecordingCoverage,
} from "../types/recordingCheckpoint";

const RATE = 48000 * 2 * 2;
const SEGMENT_MS = 30_000;
const UNSAVED_MS = 60_000;
const LIMIT = 64 * 1024 * 1024;
const PRESSURE = LIMIT / 2;
// Owned PCM, concatenation, response collector and flattened response scratch.
const COPIES = 4;
let reservedBytes = 0;
export const getCheckpointPcmBudget = () => ({
  reservedBytes,
  limitBytes: LIMIT,
});
export function reserveCheckpointPcm(bytes: number): boolean {
  if (bytes < 0 || reservedBytes + bytes * COPIES > LIMIT) return false;
  reservedBytes += bytes * COPIES;
  return true;
}
export function releaseCheckpointPcm(bytes: number): void {
  reservedBytes -= bytes * COPIES;
}

type Piece = {
  sourceId: string;
  sequence: number;
  intervals: Extract<RecordingCoverage, { kind: "known" }>["intervals"];
  receivedAt: number;
  bytes: number;
  chunks: Buffer[];
  observedFirstOffsetMs: number;
  observedLastOffsetMs: number;
  maxCursorAdjustmentMs: number;
};
type Closed = {
  artifact: CheckpointArtifactInput;
  receivedAt: number;
  file: string;
  attempts: number;
};
type Input = {
  directory: string;
  startedAt: number;
  signal: AbortSignal;
  commit(
    artifacts: readonly CheckpointArtifactInput[],
    signal: AbortSignal,
  ): Promise<boolean>;
  stopCapture(reason: "storage_preservation" | "ownership_lost"): void;
};

/** One bounded publisher per recording. Failed PCM remains owned until explicit settled handoff. */
export function createRecordingCheckpointCapture(input: Input) {
  const open = new Map<string, Piece>();
  const sequences = new Map<string, number>();
  const sampleEnds = new Map<string, number>();
  const closed: Closed[] = [];
  let queuedBytes = 0;
  let stopped = false;
  let intakeStopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let worker: Promise<void> | undefined;
  let completion: Promise<boolean> | undefined;
  let retryAt = Infinity;
  const controller = new AbortController();
  const signal = AbortSignal.any([input.signal, controller.signal]);

  function close(sourceId: string) {
    const piece = open.get(sourceId);
    if (!piece) return;
    open.delete(sourceId);
    const bytes = Buffer.concat(piece.chunks, piece.bytes);
    piece.chunks = [];
    const file = path.join(
      input.directory,
      `${encodeURIComponent(sourceId)}-${piece.sequence}.pcm`,
    );
    const artifact: CheckpointArtifactInput = {
      kind: "audio",
      sourceId,
      sequence: piece.sequence,
      format: { encoding: "pcm_s16le", sampleRate: 48000, channels: 2 },
      contentType: "application/octet-stream",
      timing: {
        basis: "sample_cursor_with_observed_gaps",
        observedFirstOffsetMs: piece.observedFirstOffsetMs,
        observedLastOffsetMs: piece.observedLastOffsetMs,
        maxCursorAdjustmentMs: piece.maxCursorAdjustmentMs,
      },
      bytes,
      checksumSha256: createHash("sha256").update(bytes).digest("hex"),
      coverage: {
        kind: "known",
        intervals: piece.intervals,
      },
    };
    closed.push({ artifact, receivedAt: piece.receivedAt, file, attempts: 0 });
    try {
      writeFileSync(file, bytes, { flag: "wx" });
    } catch {
      interrupt();
    }
  }
  function closeAll() {
    for (const id of open.keys()) close(id);
  }
  function oldest() {
    return Math.min(
      ...Array.from(open.values(), (item) => item.receivedAt),
      ...closed.map((item) => item.receivedAt),
    );
  }
  function interrupt(
    reason: "storage_preservation" | "ownership_lost" = "storage_preservation",
  ) {
    if (fence()) input.stopCapture(reason);
  }
  function fence() {
    if (stopped) return false;
    stopped = true;
    if (timer) clearTimeout(timer);
    controller.abort(new Error("Recording publication fenced"));
    closeAll();
    return true;
  }
  function arm() {
    if (timer) clearTimeout(timer);
    if (stopped) return;
    const next = Math.min(
      oldest() + UNSAVED_MS,
      retryAt,
      ...Array.from(open.values(), (item) => item.receivedAt + SEGMENT_MS),
    );
    if (!Number.isFinite(next)) return;
    timer = setTimeout(tick, Math.max(0, next - Date.now()));
  }
  function tick() {
    if (Date.now() >= oldest() + UNSAVED_MS) {
      interrupt();
      return;
    }
    for (const item of open.values()) {
      if (Date.now() >= item.receivedAt + SEGMENT_MS) close(item.sourceId);
    }
    if (Date.now() >= retryAt) retryAt = Infinity;
    startWorker();
    arm();
  }
  async function publish() {
    while (closed.length && !signal.aborted) {
      const next = closed[0];
      if (next.attempts >= 3) return;
      next.attempts++;
      let confirmed = false;
      try {
        confirmed = await input.commit([next.artifact], signal);
      } catch {
        /* Retain exact bytes and identity. */
      }
      if (!confirmed || signal.aborted) {
        retryAt = next.attempts < 3 ? Date.now() + 1000 : Infinity;
        return;
      }
      closed.shift();
      if (next.artifact.kind === "audio")
        queuedBytes -= next.artifact.bytes.byteLength;
      if (next.artifact.kind === "audio")
        releaseCheckpointPcm(next.artifact.bytes.byteLength);
      try {
        unlinkSync(next.file);
      } catch {
        /* A confirmed leftover file is safe to retain. */
      }
    }
  }
  function startWorker() {
    if (
      !closed.length ||
      worker ||
      completion ||
      signal.aborted ||
      (Date.now() < retryAt && retryAt !== Infinity)
    )
      return;
    worker = Promise.resolve()
      .then(publish)
      .finally(() => {
        worker = undefined;
        arm();
      });
  }
  function push(
    sourceId: string,
    chunk: Buffer,
    at = Date.now(),
    onAccepted?: (span: PcmSpan) => void,
  ): boolean {
    if (stopped || intakeStopped || signal.aborted) return false;
    const sourceBytes =
      (open.get(sourceId)?.bytes ?? 0) +
      closed
        .filter((item) => item.artifact.sourceId === sourceId)
        .reduce((total, item) => total + item.artifact.bytes.byteLength, 0);
    if (chunk.length === 0) return true;
    if (
      chunk.length % 4 ||
      chunk.length > RATE * 30 ||
      !Number.isFinite(at) ||
      sourceBytes + chunk.length > RATE * 60 ||
      Date.now() >= oldest() + UNSAVED_MS ||
      !reserveCheckpointPcm(chunk.length)
    ) {
      interrupt();
      return false;
    }
    const sampleAt = Math.max(at, sampleEnds.get(sourceId) ?? input.startedAt);
    let piece = open.get(sourceId);
    if (piece && piece.bytes + chunk.length > RATE * 30) {
      close(sourceId);
      piece = undefined;
      if (stopped) {
        releaseCheckpointPcm(chunk.length);
        return false;
      }
    }
    if (!piece) {
      const sequence = sequences.get(sourceId) ?? 0;
      sequences.set(sourceId, sequence + 1);
      piece = {
        sourceId,
        sequence,
        intervals: [],
        observedFirstOffsetMs: at - input.startedAt,
        observedLastOffsetMs: at - input.startedAt,
        maxCursorAdjustmentMs: 0,
        receivedAt: Date.now(),
        bytes: 0,
        chunks: [],
      };
      open.set(sourceId, piece);
    }
    piece.observedLastOffsetMs = at - input.startedAt;
    piece.maxCursorAdjustmentMs = Math.max(
      piece.maxCursorAdjustmentMs,
      sampleAt - at,
    );
    const startByte = piece.bytes;
    piece.chunks.push(Buffer.from(chunk));
    piece.bytes += chunk.length;
    const durationMs = (chunk.length * 1000) / RATE;
    const last = piece.intervals.at(-1);
    const startOffsetMs = sampleAt - input.startedAt;
    if (last && last.startOffsetMs + last.durationMs === startOffsetMs)
      last.durationMs += durationMs;
    else piece.intervals.push({ sourceId, startOffsetMs, durationMs });
    sampleEnds.set(sourceId, sampleAt + durationMs);
    queuedBytes += chunk.length;
    if (piece.bytes >= RATE * 30 || reservedBytes >= PRESSURE) closeAll();
    startWorker();
    arm();
    if (stopped) return false;
    onAccepted?.({
      sourceId,
      sequence: piece.sequence,
      startByte,
      endByte: piece.bytes,
    });
    return true;
  }
  async function finish(): Promise<boolean> {
    intakeStopped = true;
    closeAll();
    startWorker();
    await worker;
    if (closed.length || signal.aborted) return false;
    completion = input.commit([], signal);
    try {
      return await completion;
    } finally {
      completion = undefined;
      startWorker();
    }
  }
  function releaseSettledBuffers() {
    if (worker || completion || !(stopped || intakeStopped))
      throw new Error("Capture/request ownership has not settled");
    stopped = true;
    if (timer) clearTimeout(timer);
    input.signal.removeEventListener("abort", ownershipLost);
    releaseCheckpointPcm(queuedBytes);
    queuedBytes = 0;
    closed.length = 0;
    open.clear();
  }
  mkdirSync(input.directory, { recursive: true });
  const ownershipLost = () => interrupt("ownership_lost");
  input.signal.addEventListener("abort", ownershipLost, { once: true });
  if (input.signal.aborted) ownershipLost();
  function queueContent(artifact: CheckpointArtifactInput) {
    if (signal.aborted || stopped || artifact.kind === "audio") return false;
    const file = path.join(
      input.directory,
      `${artifact.kind}-${artifact.sequence}.json`,
    );
    try {
      writeFileSync(file, artifact.bytes, { flag: "wx" });
    } catch {
      interrupt();
      return false;
    }
    // Completed-text snapshots are cumulative; retain only the newest unstarted snapshot in memory.
    const previous = closed.findIndex(
      (item, index) =>
        item.artifact.kind === artifact.kind && (!worker || index > 0),
    );
    if (previous >= 0) closed.splice(previous, 1);
    closed.push({ artifact, receivedAt: Date.now(), file, attempts: 0 });
    startWorker();
    arm();
    return true;
  }
  async function drainContent(): Promise<boolean> {
    await completion;
    startWorker();
    await worker;
    return !closed.length && !signal.aborted;
  }
  return {
    publicationSignal: signal,
    push,
    queueContent,
    finish,
    drainContent,
    interrupt,
    fence,
    releaseSettledBuffers,
    pending: () =>
      closed.map((item) => ({ artifact: item.artifact, file: item.file })),
    settled: async () => {
      while (completion || worker) {
        await completion;
        await worker;
      }
    },
    snapshot: () => ({
      stopped: stopped || intakeStopped,
      queuedBytes,
      oldestUnconfirmedAgeMs: Number.isFinite(oldest())
        ? Date.now() - oldest()
        : 0,
    }),
  };
}
export type RecordingCheckpointCapture = ReturnType<
  typeof createRecordingCheckpointCapture
>;
