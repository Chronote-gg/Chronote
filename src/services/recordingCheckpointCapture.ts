import type { PcmSpan } from "../types/transcriptCorrespondence";
import { createHash } from "node:crypto";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type {
  CheckpointArtifactInput,
  RecordingCoverage,
} from "../types/recordingCheckpoint";
import { LIFECYCLE } from "./lifecycleTiming";

const RATE = 48000 * 2 * 2;
const UNSAVED_MS = 60_000;
const MIB = 1024 * 1024;
// Owned PCM, concatenation, response collector and flattened response scratch.
export const PCM_RESERVED_COPIES = 4;

/** An in-process PCM allowance; every byte is counted PCM_RESERVED_COPIES times. */
export function createPcmBudget(limitBytes: number) {
  let reservedBytes = 0;
  return {
    reserve(bytes: number): boolean {
      const charged = bytes * PCM_RESERVED_COPIES;
      if (bytes < 0 || reservedBytes + charged > limitBytes) return false;
      reservedBytes += charged;
      return true;
    },
    release(bytes: number): void {
      reservedBytes -= bytes * PCM_RESERVED_COPIES;
    },
    snapshot: () => ({ reservedBytes, limitBytes }),
  };
}

// Live capture and TTS playback share this. 256 MiB counted is 64 MiB of PCM,
// about 349 speaker-seconds at 192,000 bytes a second, across the worker. The
// task has 2048 MB and peaked near 790 MB; even if all four counted copies were
// resident at once, 790 + 256 MiB stays near 1.06 GB, about half the task.
export const CAPTURE_PCM_LIMIT_BYTES = 256 * MIB;
const PRESSURE = CAPTURE_PCM_LIMIT_BYTES / 2;
export const capturePcmBudget = createPcmBudget(CAPTURE_PCM_LIMIT_BYTES);
export const getCheckpointPcmBudget = capturePcmBudget.snapshot;
export const reserveCheckpointPcm = capturePcmBudget.reserve;
export const releaseCheckpointPcm = capturePcmBudget.release;
function crossedPressureThreshold(previousReservedBytes: number): boolean {
  return (
    previousReservedBytes < PRESSURE &&
    getCheckpointPcmBudget().reservedBytes >= PRESSURE
  );
}

/** Which guard stopped the capture, so the interruption log can tell the stops apart. */
export type CaptureStopCause =
  | "local_write_failed"
  | "invalid_chunk"
  | "source_bound"
  | "unconfirmed_age"
  | "shared_budget"
  | "playback_tap";
export type CaptureStopDiagnosis = {
  cause: CaptureStopCause;
  pcmReservedBytes: number;
  pcmLimitBytes: number;
  refusedChunkBytes?: number;
};

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
  supersededFiles?: string[];
};
type Input = {
  directory: string;
  startedAt: number;
  signal: AbortSignal;
  commit(
    artifacts: readonly CheckpointArtifactInput[],
    signal: AbortSignal,
  ): Promise<boolean>;
  stopCapture(
    reason: "storage_preservation" | "ownership_lost",
    diagnosis?: CaptureStopDiagnosis,
  ): void;
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

  function writeArtifact(file: string, artifact: CheckpointArtifactInput) {
    try {
      writeFileSync(file, artifact.bytes, { flag: "wx" });
      return true;
    } catch {
      interrupt("local_write_failed");
      return false;
    }
  }

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
    writeArtifact(file, artifact);
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
  function interrupt(cause: CaptureStopCause, refusedChunkBytes?: number) {
    if (fence())
      input.stopCapture("storage_preservation", {
        cause,
        pcmReservedBytes: getCheckpointPcmBudget().reservedBytes,
        pcmLimitBytes: CAPTURE_PCM_LIMIT_BYTES,
        ...(refusedChunkBytes === undefined ? {} : { refusedChunkBytes }),
      });
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
      ...Array.from(
        open.values(),
        (item) => item.receivedAt + LIFECYCLE.checkpointSegmentMs,
      ),
    );
    if (!Number.isFinite(next)) return;
    timer = setTimeout(tick, Math.max(0, next - Date.now()));
  }
  function tick() {
    if (Date.now() >= oldest() + UNSAVED_MS) {
      interrupt("unconfirmed_age");
      return;
    }
    for (const item of open.values()) {
      if (Date.now() >= item.receivedAt + LIFECYCLE.checkpointSegmentMs)
        close(item.sourceId);
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
      [next.file, ...(next.supersededFiles ?? [])].forEach((file) => {
        try {
          unlinkSync(file);
        } catch {
          /* A confirmed leftover file is safe to retain. */
        }
      });
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
  /** Reserves the chunk's share of the shared budget when nothing refuses it. */
  function refusalCause(
    sourceBytes: number,
    chunk: Buffer,
    at: number,
  ): CaptureStopCause | undefined {
    if (chunk.length % 4 || chunk.length > RATE * 30 || !Number.isFinite(at))
      return "invalid_chunk";
    if (sourceBytes + chunk.length > RATE * 60) return "source_bound";
    if (Date.now() >= oldest() + UNSAVED_MS) return "unconfirmed_age";
    if (!reserveCheckpointPcm(chunk.length)) return "shared_budget";
    return undefined;
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
    const previousReservedBytes = getCheckpointPcmBudget().reservedBytes;
    const refused = refusalCause(sourceBytes, chunk, at);
    if (refused) {
      interrupt(refused, chunk.length);
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
    // Flush on crossing the threshold, not on every frame while uploads remain queued.
    if (
      piece.bytes >= RATE * 30 ||
      crossedPressureThreshold(previousReservedBytes)
    )
      closeAll();
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
    if (!(await drainContent())) return false;
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
  /**
   * The meeting has closed and freed the server: publication needs the lease,
   * so nothing more is published, retried or reported as lost from here on.
   */
  function retire() {
    stopped = true;
    intakeStopped = true;
    if (timer) clearTimeout(timer);
    timer = undefined;
    controller.abort(new Error("Recording capture retired"));
    input.signal.removeEventListener("abort", ownershipLost);
    releaseCheckpointPcm(queuedBytes);
    queuedBytes = 0;
    closed.length = 0;
    open.clear();
  }
  mkdirSync(input.directory, { recursive: true });
  const ownershipLost = () => {
    if (fence()) input.stopCapture("ownership_lost");
  };
  input.signal.addEventListener("abort", ownershipLost, { once: true });
  if (input.signal.aborted) ownershipLost();
  function queueContent(artifact: CheckpointArtifactInput) {
    if (signal.aborted || stopped || artifact.kind === "audio") return false;
    const file = path.join(
      input.directory,
      `${artifact.kind}-${artifact.sequence}.json`,
    );
    if (!writeArtifact(file, artifact)) return false;
    // Completed-text snapshots are cumulative; retain only the newest unstarted snapshot in memory.
    const previous = closed.findIndex(
      (item, index) =>
        item.artifact.kind === artifact.kind && (!worker || index > 0),
    );
    const superseded =
      previous >= 0 ? closed.splice(previous, 1)[0] : undefined;
    closed.push({
      artifact,
      receivedAt: Date.now(),
      file,
      attempts: 0,
      ...(superseded
        ? {
            // Keep earlier snapshots until their cumulative replacement is durable.
            supersededFiles: [
              superseded.file,
              ...(superseded.supersededFiles ?? []),
            ],
          }
        : {}),
    });
    startWorker();
    arm();
    return true;
  }
  async function drainContent(): Promise<boolean> {
    await completion;
    while (closed.length && !signal.aborted) {
      startWorker();
      await worker;
      if (!closed.length || signal.aborted) break;
      if (closed[0].attempts >= 3) return false;
      // Stopping must await the publisher's existing retry, not report it as loss.
      await delay(Math.max(0, retryAt - Date.now()), undefined, {
        signal,
      }).catch(() => {});
    }
    return !closed.length && !signal.aborted;
  }
  return {
    publicationSignal: signal,
    push,
    queueContent,
    finish,
    drainContent,
    /** The bot playback tap's stop: its own bound or the shared budget refused audio. */
    interrupt: () => interrupt("playback_tap"),
    fence,
    retire,
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
