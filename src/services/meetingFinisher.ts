import { closeFailedInitializationOutput } from "./audioPersistenceService";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { Client } from "discord.js";
import { getMeetingFinishRepository } from "../repositories/meetingFinishRepository";
import type {
  FinishClaim,
  FinisherRow,
  MeetingFinishRepository,
} from "../repositories/meetingFinishRepository";
import { getMeetingLeaseRepository } from "../repositories/meetingLeaseRepository";
import {
  MEETING_ABANDONED_LOG,
  MEETING_FINISHER_SCAN_LOG,
  MEETING_STUCK_LOG,
} from "../metrics";
import type { ActiveMeetingLease, MeetingHistory } from "../types/db";
import type { MeetingData } from "../types/meeting-data";
import type { HistoryKey } from "../types/meetingHistoryTransition";
import type {
  CaptureCoverage,
  CheckpointSegment,
  RecordingCheckpoint,
} from "../types/recordingCheckpoint";
import {
  MEETING_END_REASONS,
  MEETING_STATUS,
  type MeetingStatus,
} from "../types/meetingLifecycle";
import { getAllMeetings } from "../meetings";
import { getDiscordClient } from "./discordClientAccessor";
import { LIFECYCLE } from "./lifecycleTiming";
import { withMeetingEndTrace } from "../observability/meetingTrace";
import { finishMeeting } from "./meetingFinish";
import {
  loadNormalFinishInput,
  loadRecoveryFinishInput,
  type FinishInput,
} from "./meetingFinishInput";
import {
  createRecordingCheckpointService,
  manifestCaptureCoverage,
} from "./recordingCheckpointService";
import { getRuntimeInstanceId } from "./runtimeInstanceService";
import { isEligible } from "./workerRegistry";

export type FinisherAction = "skip" | "adopt" | "claim" | "abandon";
type DerivedCaptureEnd = Pick<
  MeetingHistory,
  "capture" | "endReason" | "duration"
>;
/** The coverage a checkpoint's manifest claims and its audio pieces' timing. */
export type ManifestTiming = {
  coverage: CaptureCoverage;
  captureStartedAt: string | null;
  audio: readonly Pick<CheckpointSegment, "coverage" | "timing">[];
};
/** Reads a checkpoint's manifest timing, without downloading pieces. */
export type CoverageReader = (
  checkpoint: RecordingCheckpoint,
  signal: AbortSignal,
) => Promise<ManifestTiming>;
/**
 * Where an adopted capture ends. `confirmedAt` is the end the manifest
 * proves. `estimatedAt` sets the duration only, so the meeting still counts
 * toward the weekly limit while its exact end time stays unknown.
 */
export type AdoptedCaptureEnd = { confirmedAt?: string; estimatedAt?: string };

const MS_PER_SECOND = 1000;
const LIVE_STATUSES: readonly MeetingStatus[] = [
  MEETING_STATUS.STARTING,
  MEETING_STATUS.IN_PROGRESS,
];
const OPEN_STATUSES: readonly MeetingStatus[] = [
  ...LIVE_STATUSES,
  MEETING_STATUS.PROCESSING,
];

const epochSeconds = (iso: string) =>
  Math.floor(Date.parse(iso) / MS_PER_SECOND);
const isoAt = (seconds: number) =>
  new Date(seconds * MS_PER_SECOND).toISOString();
const isOpen = (status: MeetingStatus | undefined) =>
  status !== undefined && OPEN_STATUSES.includes(status);
const isLive = (status: MeetingStatus | undefined) =>
  status !== undefined && LIVE_STATUSES.includes(status);
const ageOf = (row: FinisherRow, now: number) =>
  now - epochSeconds(row.timestamp);
const rowId = (key: HistoryKey) => `${key.guildId}#${key.channelId_timestamp}`;
const logContext = (row: Pick<FinisherRow, "guildId" | "meetingId">) => ({
  guildId: row.guildId,
  meetingId: row.meetingId,
});

const claimHeld = (row: FinisherRow, now: number) =>
  row.finish?.owner !== undefined &&
  (row.finish.expiresAt ?? Number.POSITIVE_INFINITY) >= now;

/**
 * A capture still recording, or a retry not yet due. A live row whose lease
 * lapsed within the grace counts as recording: a healthy worker renews every
 * few seconds and retakes a lapsed lease, while a silent meeting writes
 * neither the row nor a new piece.
 */
function waiting(
  row: FinisherRow,
  lease: ActiveMeetingLease | undefined,
  now: number,
) {
  const nextAttemptAt = row.finish?.nextAttemptAt;
  const recording =
    lease?.meetingId === row.meetingId &&
    (lease.leaseExpiresAt >= now ||
      (isLive(row.status) &&
        now - lease.leaseExpiresAt < LIFECYCLE.abandonedGraceSeconds));
  return recording || (nextAttemptAt !== undefined && nextAttemptAt > now);
}

/**
 * What the finisher does with one scanned row. A held claim is never cut off,
 * even past 24 hours, because an attempt is itself capped. Only a non-terminal
 * row is abandoned; a terminal row's delivery gives up through the pipeline's
 * own rule. `adopt` is a candidate: the adopt step also checks the checkpoint
 * for activity inside the grace before it writes anything.
 */
export function classifyFinisherRow(
  row: FinisherRow,
  lease: ActiveMeetingLease | undefined,
  now: number,
): FinisherAction {
  if (claimHeld(row, now)) return "skip";
  if (isOpen(row.status) && ageOf(row, now) > LIFECYCLE.abandonSeconds)
    return "abandon";
  if (waiting(row, lease, now)) return "skip";
  if (isLive(row.status))
    return now - epochSeconds(row.updatedAt ?? row.timestamp) >
      LIFECYCLE.abandonedGraceSeconds
      ? "adopt"
      : "skip";
  return row.status === MEETING_STATUS.PROCESSING || row.finish
    ? "claim"
    : "skip";
}

// Past 24 hours too: a held claim is never abandoned, so only this line reports it.
const isStuck = (row: FinisherRow, now: number) =>
  isOpen(row.status) && ageOf(row, now) > LIFECYCLE.stuckAlarmSeconds;

/**
 * Settles with `work`, or rejects once `ms` passes or `signal` aborts even if
 * `work` ignores its signal, so one hung call can hold neither the scan nor stop.
 */
async function within<T>(
  ms: number,
  signal: AbortSignal,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  signal.throwIfAborted();
  const deadline = new AbortController();
  const timer = setTimeout(
    () => deadline.abort(new Error(`Finisher call exceeded ${ms} ms`)),
    ms,
  );
  timer.unref();
  const bounded = AbortSignal.any([signal, deadline.signal]);
  let onAbort: () => void = () => undefined;
  const expired = new Promise<never>((_, reject) => {
    onAbort = () => reject(bounded.reason);
    bounded.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([work(bounded), expired]);
  } finally {
    clearTimeout(timer);
    // A composite with a listener stays reachable while the loop signal can abort.
    bounded.removeEventListener("abort", onAbort);
  }
}

/** When the piece's last chunk arrived, else the end of its last known sample interval. */
function pieceLastOffsetMs(piece: ManifestTiming["audio"][number]) {
  if (piece.timing) return piece.timing.observedLastOffsetMs;
  if (piece.coverage.kind !== "known" || !piece.coverage.intervals.length)
    return undefined;
  return Math.max(
    ...piece.coverage.intervals.map(
      (interval) => interval.startOffsetMs + interval.durationMs,
    ),
  );
}

/**
 * The exact end when the manifest proves one. Otherwise, because jittered
 * audio leaves coverage unknown, an estimate from the latest saved piece,
 * kept between the capture start and both the row's last write (every
 * checkpoint commit stamps it) and now. No saved audio gives no end.
 */
export function captureEndFromManifest(
  manifest: ManifestTiming,
  updatedAt: string,
  nowMs: number,
): AdoptedCaptureEnd {
  if (manifest.coverage.kind === "verified")
    return { confirmedAt: manifest.coverage.lastConfirmedCaptureAt };
  if (!manifest.captureStartedAt) return {};
  const offsets = manifest.audio.flatMap(
    (piece) => pieceLastOffsetMs(piece) ?? [],
  );
  if (!offsets.length) return {};
  const startMs = Date.parse(manifest.captureStartedAt);
  const latestMs = Math.min(
    startMs + Math.max(...offsets),
    Date.parse(updatedAt),
    nowMs,
  );
  return { estimatedAt: new Date(Math.max(startMs, latestMs)).toISOString() };
}

/**
 * Where an abandoned capture ends, from its checkpoint manifest. Empty with
 * no checkpoint or an unreadable manifest: the meeting is then adopted with
 * no end time and the pipeline's own attempts account for the failure.
 */
export async function readAdoptedCaptureEnd(
  history: MeetingHistory,
  readCoverage: CoverageReader,
  signal: AbortSignal,
  nowMs: number,
): Promise<AdoptedCaptureEnd> {
  if (!history.checkpoint) return {};
  try {
    return captureEndFromManifest(
      await readCoverage(history.checkpoint, signal),
      history.updatedAt ?? history.timestamp,
      nowMs,
    );
  } catch (error) {
    signal.throwIfAborted();
    console.warn("Checkpoint manifest was not readable for adoption", {
      ...logContext(history),
      error,
    });
    return {};
  }
}

/** Reads the manifest alone: deciding an end time never downloads audio pieces. */
export function manifestCoverageReader(
  checkpoints: Pick<
    ReturnType<typeof createRecordingCheckpointService>,
    "readMetadata"
  > = createRecordingCheckpointService(),
): CoverageReader {
  return async (checkpoint, signal) => {
    const manifest = await checkpoints.readMetadata(checkpoint, signal);
    return {
      coverage: manifestCaptureCoverage(manifest),
      captureStartedAt: manifest.capture.captureStartedAt,
      audio: manifest.artifacts.filter((artifact) => artifact.kind === "audio"),
    };
  };
}

const captureEndAt = (end: AdoptedCaptureEnd) =>
  end.confirmedAt ?? end.estimatedAt;

/** The row's last write or the capture end its checkpoint shows, whichever is later. */
function lastActivity(history: MeetingHistory, end: AdoptedCaptureEnd) {
  const updated = epochSeconds(history.updatedAt ?? history.timestamp);
  const captured = captureEndAt(end);
  return captured ? Math.max(updated, epochSeconds(captured)) : updated;
}

/**
 * The end of a capture whose worker died: interrupted at its confirmed end,
 * which an estimate never replaces, with the duration to either one, else zero.
 */
export function abandonedCaptureEnd(
  history: MeetingHistory,
  end: AdoptedCaptureEnd,
  now: number,
): DerivedCaptureEnd {
  const captured = captureEndAt(end);
  return {
    capture: {
      kind: "interrupted",
      startedAt:
        history.capture?.kind === "capturing"
          ? history.capture.startedAt
          : null,
      detectedAt: isoAt(now),
      endedAt: end.confirmedAt ?? null,
    },
    endReason: MEETING_END_REASONS.UNKNOWN,
    duration: captured
      ? Math.max(0, epochSeconds(captured) - epochSeconds(history.timestamp))
      : 0,
  };
}

export type MeetingFinisherDeps = {
  repository: Pick<
    MeetingFinishRepository,
    "scan" | "claim" | "adopt" | "abandon" | "read" | "releaseUnclaimed"
  >;
  readLease(
    guildId: string,
    signal: AbortSignal,
  ): Promise<ActiveMeetingLease | undefined>;
  finish: typeof finishMeeting;
  loadNormal(meeting: MeetingData, signal: AbortSignal): Promise<FinishInput>;
  loadRecovery(
    history: MeetingHistory,
    signal: AbortSignal,
  ): Promise<FinishInput>;
  readCoverage: CoverageReader;
  /** True while this process is still capturing the meeting, whatever its lease says. */
  isCapturing(meetingId: string): boolean;
  /** Bounded and idempotent: a local finish leaves no encoder behind whatever its outcome. */
  endEncoder(meeting: MeetingData): Promise<unknown>;
  isEligible(): boolean;
  instanceId(): string;
  nowMs(): number;
  sleep(ms: number): Promise<void>;
  /** Runs `tick` every `ms` and returns a function that stops it. */
  every(tick: () => void, ms: number): () => void;
};

/** A finish this process runs, from taking the claim to the attempt's end. */
type Running = {
  meetingId: string;
  controller: AbortController;
  claim?: FinishClaim;
  done: Promise<void>;
};

export function createMeetingFinisherLoop(deps: MeetingFinisherDeps) {
  // Keyed by meeting row: a row is not claimed again by this process while
  // its attempt runs, even after its claim lapsed because renewals kept
  // failing. An attempt abandoned after its abort frees the row; a later claim
  // carries a new owner, which fences the abandoned work's writes.
  const running = new Map<string, Running>();
  let scanning: Promise<void> | undefined;
  let stopTimer: (() => void) | undefined;
  let loopController: AbortController | undefined;
  let stopping = false;
  let lastScanLogMs: number | undefined;
  const nowSeconds = () => Math.floor(deps.nowMs() / MS_PER_SECOND);
  const newOwner = () => `${deps.instanceId()}:${randomUUID()}`;

  /** Starts `work` for a row unless this process already works on it. */
  function track(
    id: string,
    meetingId: string,
    work: (slot: Running) => Promise<void>,
  ): Running | undefined {
    if (running.has(id)) return undefined;
    const slot: Running = {
      meetingId,
      controller: new AbortController(),
      done: Promise.resolve(),
    };
    running.set(id, slot);
    slot.done = work(slot)
      .catch((error: unknown) =>
        console.warn("Meeting finish failed", { row: id, error }),
      )
      .finally(() => {
        if (running.get(id) === slot) running.delete(id);
      });
    return slot;
  }

  async function release(claim: FinishClaim) {
    try {
      await deps.repository.releaseUnclaimed(claim);
    } catch (error) {
      console.warn("Meeting finish claim was not released", {
        ...logContext(claim.history),
        error,
      });
    }
  }

  /** Runs one attempt, or hands the claim straight back once shutdown began. */
  async function attempt(
    slot: Running,
    claim: FinishClaim,
    load: (signal: AbortSignal) => Promise<FinishInput>,
  ) {
    slot.claim = claim;
    if (stopping || slot.controller.signal.aborted) {
      await release(claim);
      return;
    }
    await deps.finish(claim, load, { signal: slot.controller.signal });
  }

  async function adopt(row: FinisherRow, signal: AbortSignal) {
    const history = await deps.repository.read(row);
    signal.throwIfAborted();
    if (!history) return undefined;
    const end = await readAdoptedCaptureEnd(
      history,
      deps.readCoverage,
      signal,
      deps.nowMs(),
    );
    // A read that outlived the slot's bound must not adopt a row nothing will finish.
    signal.throwIfAborted();
    const now = nowSeconds();
    if (now - lastActivity(history, end) <= LIFECYCLE.abandonedGraceSeconds)
      return undefined;
    return deps.repository.adopt(
      row,
      newOwner(),
      abandonedCaptureEnd(history, end, now),
      now,
    );
  }

  /**
   * Takes the row's claim, bounded: no attempt cap covers this work yet, and
   * the storage clients set no deadline, so a stalled call would hold the
   * slot for good. At the bound the slot is freed even if the call never
   * settles; a claim it still writes lapses like any unrenewed claim.
   * Shutdown does not cut the wait short, as before: a claim that lands after
   * shutdown began is handed back by `attempt`.
   */
  async function claimWithin(
    row: FinisherRow,
    action: "adopt" | "claim",
    signal: AbortSignal,
  ): Promise<FinishClaim | undefined> {
    let deadline: AbortSignal | undefined;
    try {
      return await within(
        LIFECYCLE.adoptionMs,
        new AbortController().signal,
        (bound) => {
          deadline = bound;
          return action === "adopt"
            ? adopt(row, AbortSignal.any([bound, signal]))
            : deps.repository.claim(row, newOwner(), nowSeconds());
        },
      );
    } catch (error) {
      if (!deadline?.aborted) throw error;
      console.warn("Meeting finish took no claim within its bound", {
        ...logContext(row),
        action,
      });
      return undefined;
    }
  }

  /** Whether an attempt for the row started. */
  function take(row: FinisherRow, action: "adopt" | "claim"): boolean {
    if (stopping || running.size >= LIFECYCLE.maxConcurrentFinishes)
      return false;
    const slot = track(rowId(row), row.meetingId, async (slot) => {
      const claim = await claimWithin(row, action, slot.controller.signal);
      if (claim)
        await attempt(slot, claim, (signal) =>
          deps.loadRecovery(claim.history, signal),
        );
    });
    return slot !== undefined;
  }

  /** Whether the row was taken for an attempt. */
  async function consider(row: FinisherRow, signal: AbortSignal) {
    const now = nowSeconds();
    if (isStuck(row, now)) console.error(MEETING_STUCK_LOG, logContext(row));
    if (running.has(rowId(row)) || deps.isCapturing(row.meetingId))
      return false;
    const lease = isOpen(row.status)
      ? await within(LIFECYCLE.finisherLeaseReadMs, signal, (bounded) =>
          deps.readLease(row.guildId, bounded),
        )
      : undefined;
    signal.throwIfAborted();
    const action = classifyFinisherRow(row, lease, now);
    if (action === "skip") return false;
    if (action === "abandon") {
      if (await deps.repository.abandon(row, now))
        console.error(MEETING_ABANDONED_LOG, logContext(row));
      return false;
    }
    return take(row, action);
  }

  async function scanRows(signal: AbortSignal) {
    const counts = { seen: 0, taken: 0, failed: 0 };
    for await (const row of deps.repository.scan(signal)) {
      // A pass abandoned at its deadline may wake later; it must not take another row.
      signal.throwIfAborted();
      counts.seen += 1;
      try {
        if (await consider(row, signal)) counts.taken += 1;
      } catch (error) {
        signal.throwIfAborted();
        counts.failed += 1;
        console.warn("Meeting finisher could not handle a row", {
          ...logContext(row),
          error,
        });
      }
    }
    signal.throwIfAborted();
    // Every row failing (a lease table permission or key regression) is a failed scan.
    if (counts.seen > 0 && counts.failed === counts.seen)
      throw new Error(`Every one of ${counts.seen} scanned rows failed`);
    return counts;
  }

  /** The dead-man line: only a pass that read the table through logs it. */
  function logScanCompleted(counts: {
    seen: number;
    taken: number;
    failed: number;
  }) {
    const nowMs = deps.nowMs();
    if (
      lastScanLogMs !== undefined &&
      nowMs - lastScanLogMs < LIFECYCLE.finisherScanLogMs
    )
      return;
    lastScanLogMs = nowMs;
    console.log(MEETING_FINISHER_SCAN_LOG, counts);
  }

  /** One pass over open meetings. Returns at once when a pass is running, shutdown began, or this worker is not eligible. */
  function runFinisherScan(signal: AbortSignal): Promise<void> {
    if (scanning || stopping || !deps.isEligible()) return Promise.resolve();
    // Only the scanning is bounded: an attempt it started keeps its own claim and cap.
    const pass = within(LIFECYCLE.finisherScanTimeoutMs, signal, scanRows)
      .then(logScanCompleted)
      .catch((error: unknown) => {
        if (!signal.aborted)
          console.error("Meeting finisher scan failed", { error });
      })
      .finally(() => {
        scanning = undefined;
      });
    scanning = pass;
    return pass;
  }

  function startMeetingFinisher() {
    if (stopTimer) return;
    const controller = new AbortController();
    loopController = controller;
    stopTimer = deps.every(
      () => void runFinisherScan(controller.signal),
      LIFECYCLE.finisherScanMs,
    );
  }

  /**
   * Stops the timer and aborts the pass in progress, returning once it settles;
   * a step already running may finish but takes nothing. Running attempts are
   * left to `releaseLocalFinishClaims`.
   */
  async function stopMeetingFinisher() {
    stopTimer?.();
    stopTimer = undefined;
    loopController?.abort();
    loopController = undefined;
    await scanning;
  }

  /**
   * The closing worker's finish, from what it holds in memory, under the
   * claim close wrote as `claimOwner`. Never rejects; resolves true once the
   * normal loader took the meeting, which then owns ending its encoder.
   */
  function runLocalFinish(
    meeting: MeetingData,
    claimOwner: string,
  ): Promise<boolean> {
    const reservation = meeting.reservation;
    if (reservation?.sessionMode !== "meeting") return Promise.resolve(false);
    const key = reservation.historyKey;
    let loaded = false;
    async function localAttempt(local: Running) {
      const history = await deps.repository.read(key);
      if (history?.finish?.owner !== claimOwner) {
        console.warn("Local meeting finish no longer holds its claim", {
          meetingId: meeting.meetingId,
        });
        return;
      }
      // Groups the local finish's steps under one "meeting-end" trace, as the old end path did.
      await withMeetingEndTrace(meeting, () =>
        attempt(
          local,
          { key, meetingId: history.meetingId, owner: claimOwner, history },
          (signal) => {
            loaded = true;
            return deps.loadNormal(meeting, signal);
          },
        ),
      );
    }
    const slot = track(rowId(key), meeting.meetingId, async (local) => {
      try {
        await localAttempt(local);
      } finally {
        // Ending it twice is harmless; the loader may already have ended it.
        await deps.endEncoder(meeting);
      }
    });
    if (slot) return slot.done.then(() => loaded);
    console.warn("Local meeting finish found the meeting already finishing", {
      meetingId: meeting.meetingId,
    });
    return Promise.resolve(false);
  }

  /**
   * Shutdown. Aborts every attempt, waits a bounded time for them to stop,
   * then hands each claim back for another worker to take at once, keeping
   * the attempt count. A claim still being taken is handed back when it lands.
   */
  async function releaseLocalFinishClaims() {
    stopping = true;
    const slots = [...running.values()];
    for (const slot of slots) slot.controller.abort();
    await Promise.race([
      Promise.all(slots.map((slot) => slot.done)),
      deps.sleep(LIFECYCLE.finishAbortWaitMs),
    ]);
    await Promise.all(
      slots.map((slot) => (slot.claim ? release(slot.claim) : undefined)),
    );
  }

  return {
    runFinisherScan,
    startMeetingFinisher,
    stopMeetingFinisher,
    runLocalFinish,
    releaseLocalFinishClaims,
    activeFinishCount: () => running.size,
    isFinishing: (meetingId: string) =>
      [...running.values()].some((slot) => slot.meetingId === meetingId),
  };
}

function discordClient(): Client {
  const client = getDiscordClient();
  if (!client) throw new Error("The Discord client is not available");
  return client;
}

function defaultDeps(): MeetingFinisherDeps {
  const leases = getMeetingLeaseRepository();
  return {
    repository: getMeetingFinishRepository(),
    readLease: (guildId, signal) => leases.read(guildId, signal),
    finish: finishMeeting,
    loadNormal: (meeting, signal) =>
      loadNormalFinishInput(meeting, discordClient(), signal),
    loadRecovery: (history, signal) => loadRecoveryFinishInput(history, signal),
    readCoverage: manifestCoverageReader(),
    isCapturing: (meetingId) =>
      getAllMeetings().some((meeting) => meeting.meetingId === meetingId),
    // The same bounded close a failed start uses; it is a no-op for an encoder already ended.
    endEncoder: closeFailedInitializationOutput,
    isEligible,
    instanceId: getRuntimeInstanceId,
    nowMs: Date.now,
    sleep: (ms) => sleep(ms, undefined, { ref: false }),
    every(tick, ms) {
      const timer = setInterval(tick, ms);
      timer.unref();
      return () => clearInterval(timer);
    },
  };
}

let processLoop: ReturnType<typeof createMeetingFinisherLoop> | undefined;
const loop = () => (processLoop ??= createMeetingFinisherLoop(defaultDeps()));

export function runFinisherScan(signal: AbortSignal): Promise<void> {
  return loop().runFinisherScan(signal);
}

/** Scans every `finisherScanMs`; each tick returns at once unless this worker is eligible. */
export function startMeetingFinisher(): void {
  loop().startMeetingFinisher();
}

export function stopMeetingFinisher(): Promise<void> {
  return loop().stopMeetingFinisher();
}

/** Matches `LocalFinishStarter`: close has written the claim under `claimOwner`. */
export function runLocalFinish(
  meeting: MeetingData,
  claimOwner: string,
): Promise<boolean> {
  return loop().runLocalFinish(meeting, claimOwner);
}

export function releaseLocalFinishClaims(): Promise<void> {
  return loop().releaseLocalFinishClaims();
}

export function activeFinishCount(): number {
  return loop().activeFinishCount();
}

/** Whether a finish attempt for this meeting is running in this process, so its local files stay. */
export function isFinishingLocally(meetingId: string): boolean {
  return loop().isFinishing(meetingId);
}
