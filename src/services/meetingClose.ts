import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { VoiceConnection } from "@discordjs/voice";
import { startProcessingSnippet, stopRecordingCapture } from "../audio";
import { stopThinkingCueLoop } from "../audio/soundCues";
import { closeOutputFile } from "./audioPersistenceService";
import {
  deleteMeeting,
  getAllMeetings,
  restoreVoiceSessionNickname,
} from "../meetings";
import { getMeetingFinishRepository } from "../repositories/meetingFinishRepository";
import type { MeetingFinishRepository } from "../repositories/meetingFinishRepository";
import type { MeetingData } from "../types/meeting-data";
import type { SessionReservation } from "../types/meetingHistoryTransition";
import {
  MEETING_END_REASONS,
  type MeetingEndReason,
} from "../types/meetingLifecycle";
import { LIFECYCLE } from "./lifecycleTiming";
import {
  completionSnapshot,
  resolveCompletionPolicy,
  stopCompletionClock,
} from "./meetingCompletionPolicyService";
import {
  confirmedLeaseExpiry,
  confirmSessionLease,
  holdsSessionLease,
  latestLeaseCap,
  releaseSessionLease,
  type MeetingLeaseService,
} from "./meetingLease";
import { setCaptureEndHandlers, type CaptureEndHandlers } from "./meetingStart";
import {
  checkpointCompletedTranscription,
  checkpointRecordingContext,
} from "./recordingContentService";
import { getRuntimeInstanceId } from "./runtimeInstanceService";
import { isShuttingDown } from "./shutdownSignal";
import { releaseCaptureProtection } from "./taskProtection";
import { ensureMeetingTempDir } from "./tempFileService";
import { dropVoiceLocally, leaveVoice } from "./voiceSession";
import { isEligible } from "./workerRegistry";

const MS_PER_SECOND = 1000;
/** What a shutdown close still does after its flush: one capture-end write, the lease release, the encoder end. */
const SHUTDOWN_AFTER_FLUSH_MS =
  2 * LIFECYCLE.leaseHeartbeatMs + LIFECYCLE.closeEncoderMs;
const TIMED_OUT = Symbol("timed out");

export type CloseCause = {
  endReason: MeetingEndReason;
  endTriggeredByUserId?: string;
  abnormal?: boolean;
  /** Set by shutdown: the epoch milliseconds by which the whole close must have ended. */
  deadlineMs?: number;
};
/** Resolves true once the normal loader has taken the meeting, which then owns ending its encoder. */
export type LocalFinishStarter = (
  meeting: MeetingData,
  claimOwner: string,
) => Promise<boolean>;
type CaptureDisposition = "complete" | "interrupted";
/** `lost`: another meeting took the server, so no decision is made here. */
type Disposition = CaptureDisposition | "lost";

/**
 * The completion policy snapshot and, when the snapshot settles it without the
 * transcript, the decision, so a retried finish cannot reverse a cancellation.
 * An undecided auto-recording is left to the normal loader's evaluation.
 */
function completionFields(meeting: MeetingData, disposition: Disposition) {
  const snapshot = completionSnapshot(meeting);
  if (!snapshot) return {};
  if (disposition === "lost") return { completionPolicy: snapshot };
  const resolved = resolveCompletionPolicy(
    snapshot,
    disposition === "interrupted",
  );
  const decision = resolved === "unknown" ? "undecided" : resolved;
  return {
    completionPolicy: { ...snapshot, decision },
    ...(decision === "cancel"
      ? { cancellationReason: meeting.cancellationReason }
      : {}),
  };
}

const ABNORMAL_END: CloseCause = {
  endReason: MEETING_END_REASONS.UNKNOWN,
  abnormal: true,
};
const CAP_END: CloseCause = { endReason: MEETING_END_REASONS.TIMEOUT };

export type MeetingCloseDeps = {
  lease: Pick<
    MeetingLeaseService,
    | "confirmSessionLease"
    | "releaseSessionLease"
    | "latestLeaseCap"
    | "holdsSessionLease"
    | "confirmedLeaseExpiry"
  >;
  finish: Pick<MeetingFinishRepository, "recordCaptureEnd">;
  /** Detaches receivers and records the capture state for the disposition. */
  stopCapture(meeting: MeetingData, disposition: CaptureDisposition): void;
  leaveVoice(connection: VoiceConnection): void;
  dropVoiceLocally(connection: VoiceConnection): void;
  restoreNickname(meeting: MeetingData): Promise<unknown>;
  /** Publishes remaining pieces and the final context; false when not all of it landed. */
  flushCapture(meeting: MeetingData): Promise<boolean>;
  /** What the local finish reads from this process: the chat log file and the last snippets. */
  prepareLocalFinish(meeting: MeetingData): Promise<void>;
  /**
   * Stops the checkpoint publisher for good before the server is freed, and on
   * a lost lease also aborts the capture signal so in-flight transcription stops.
   */
  retireCapture(meeting: MeetingData, ownershipLost: boolean): void;
  dropMeeting(meeting: MeetingData): void;
  liveMeetings(): MeetingData[];
  releaseCaptureProtection(): void;
  isEligible(): boolean;
  isShuttingDown(): boolean;
  instanceId(): string;
  localFinishStarter(): LocalFinishStarter;
  /** Ends the meeting's audio encoder, for a close whose meeting no local finish loads. */
  endEncoder(meeting: MeetingData): Promise<unknown>;
  nowMs(): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
};

/**
 * `uncertain`: the confirmation failed after this worker's own lease ran out,
 * so another meeting may hold the server and a voice leave could pull it out.
 */
type Ownership = "held" | "lost" | "uncertain";

export function createMeetingClose(deps: MeetingCloseDeps) {
  const closing = new WeakMap<MeetingData, Promise<void>>();
  const nowSeconds = () => Math.floor(deps.nowMs() / MS_PER_SECOND);

  async function within<T>(
    work: Promise<T>,
    ms: number,
  ): Promise<T | typeof TIMED_OUT> {
    const cancel = new AbortController();
    try {
      return await Promise.race([
        work,
        deps.sleep(ms, cancel.signal).then((): typeof TIMED_OUT => TIMED_OUT),
      ]);
    } finally {
      cancel.abort();
    }
  }

  /** One failed step never stops the steps after it. */
  async function attempt(
    meeting: MeetingData,
    step: string,
    action: () => unknown,
  ) {
    try {
      await action();
    } catch (error) {
      console.warn("Meeting close step failed", {
        meetingId: meeting.meetingId,
        step,
        error,
      });
    }
  }

  /** A confirmation error is unknown, not lost, while this worker's last confirmed lease is still current. */
  async function confirmOwnership(
    reservation: SessionReservation,
  ): Promise<Ownership> {
    try {
      // A capped lease closes normally: nobody else took the server.
      return (await deps.lease.confirmSessionLease(reservation)) === "lost"
        ? "lost"
        : "held";
    } catch (error) {
      console.warn("Meeting close could not confirm its lease", {
        meetingId: reservation.meetingId,
        error,
      });
      const confirmedUntil = deps.lease.confirmedLeaseExpiry(reservation);
      return confirmedUntil !== undefined && confirmedUntil >= nowSeconds()
        ? "held"
        : "uncertain";
    }
  }

  async function stopReceiving(
    meeting: MeetingData,
    cause: CloseCause,
    disposition: CaptureDisposition,
  ) {
    if (meeting.timeoutTimer) clearTimeout(meeting.timeoutTimer);
    meeting.timeoutTimer = undefined;
    meeting.endReason = cause.endReason;
    meeting.endTriggeredByUserId = cause.endTriggeredByUserId;
    meeting.endTime = new Date(deps.nowMs());
    await attempt(meeting, "stop-capture", () =>
      deps.stopCapture(meeting, disposition),
    );
  }

  async function departVoice(meeting: MeetingData, ownership: Ownership) {
    if (ownership !== "held") {
      await attempt(meeting, "drop-voice", () =>
        deps.dropVoiceLocally(meeting.connection),
      );
      return;
    }
    await attempt(meeting, "leave-voice", () =>
      deps.leaveVoice(meeting.connection),
    );
    await attempt(meeting, "restore-nickname", async () => {
      const restored = await within(
        deps.restoreNickname(meeting),
        LIFECYCLE.closeNicknameMs,
      );
      if (restored === TIMED_OUT)
        console.warn("Meeting close nickname restore timed out", {
          meetingId: meeting.meetingId,
        });
    });
  }

  /** Shorter while shutting down, and never past what the shutdown deadline leaves after it. */
  function flushBoundMs(deadlineMs: number | undefined): number {
    if (!deps.isShuttingDown() && deadlineMs === undefined)
      return LIFECYCLE.closeFlushMs;
    if (deadlineMs === undefined) return LIFECYCLE.shutdownFlushMs;
    return Math.max(
      0,
      Math.min(
        LIFECYCLE.shutdownFlushMs,
        deadlineMs - deps.nowMs() - SHUTDOWN_AFTER_FLUSH_MS,
      ),
    );
  }

  /** True only when every remaining piece and the final context landed. */
  async function flush(
    meeting: MeetingData,
    deadlineMs: number | undefined,
  ): Promise<boolean> {
    try {
      const flushed = await within(
        deps.flushCapture(meeting),
        flushBoundMs(deadlineMs),
      );
      if (flushed === true) return true;
      console.warn("Meeting close flush did not complete", {
        meetingId: meeting.meetingId,
        timedOut: flushed === TIMED_OUT,
      });
    } catch (error) {
      console.warn("Meeting close flush failed", {
        meetingId: meeting.meetingId,
        error,
      });
    }
    return false;
  }

  /**
   * Without a local finish the meeting is finished from the checkpoint alone,
   * which lacks what the flush did not save, so the capture did not end complete.
   */
  function unsavedTail(meeting: MeetingData) {
    const state = meeting.recordingCaptureState;
    if (state?.kind !== "complete") return;
    meeting.recordingCaptureState = {
      kind: "interrupted",
      startedAt: state.startedAt,
      endedAt: state.endedAt,
      detectedAt: new Date(deps.nowMs()).toISOString(),
    };
  }

  /** Captured duration as the final save computes it, so the weekly limit counts it now. */
  function captureEndPatch(meeting: MeetingData, disposition: Disposition) {
    const endedAt = meeting.endTime?.getTime() ?? deps.nowMs();
    return {
      capture: meeting.recordingCaptureState,
      endReason: meeting.endReason,
      endTriggeredByUserId: meeting.endTriggeredByUserId,
      duration: Math.floor(
        (endedAt - meeting.startTime.getTime()) / MS_PER_SECOND,
      ),
      ...completionFields(meeting, disposition),
    };
  }

  /**
   * True only when the row is known to be written; an unknown outcome is
   * retried, except under a shutdown deadline, where the finisher adopts a
   * row left live once its grace passes.
   */
  async function recordCaptureEnd(
    meeting: MeetingData,
    reservation: SessionReservation,
    claimOwner: string | undefined,
    disposition: Disposition,
    attempts: number,
  ): Promise<boolean> {
    const patch = captureEndPatch(meeting, disposition);
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const written = await within(
          deps.finish.recordCaptureEnd({
            reservation,
            patch,
            claimOwner,
            now: nowSeconds(),
          }),
          LIFECYCLE.leaseHeartbeatMs,
        );
        if (written === true) return true;
        if (written === false) {
          console.warn("Meeting close found its history row no longer live", {
            meetingId: meeting.meetingId,
          });
          return false;
        }
      } catch (error) {
        console.warn("Meeting close could not write the capture end", {
          meetingId: meeting.meetingId,
          attempt,
          error,
        });
      }
    }
    console.error("Meeting close gave up writing the capture end", {
      meetingId: meeting.meetingId,
    });
    return false;
  }

  async function free(
    meeting: MeetingData,
    reservation: SessionReservation,
    lost: boolean,
  ) {
    await attempt(meeting, "retire-capture", () =>
      deps.retireCapture(meeting, lost),
    );
    if (!lost) {
      try {
        await deps.lease.releaseSessionLease(reservation);
      } catch (error) {
        console.warn("Meeting close could not release its lease", {
          meetingId: meeting.meetingId,
          error,
        });
      }
    }
    deps.dropMeeting(meeting);
    if (
      meeting.sessionMode !== "tts_only" &&
      deps.lease.latestLeaseCap(nowSeconds()) === undefined
    )
      deps.releaseCaptureProtection();
  }

  async function startLocalFinish(meeting: MeetingData, claimOwner: string) {
    try {
      await deps.prepareLocalFinish(meeting);
    } catch (error) {
      console.warn("Local finish preparation failed", {
        meetingId: meeting.meetingId,
        error,
      });
    }
    void Promise.resolve()
      .then(() => deps.localFinishStarter()(meeting, claimOwner))
      .catch((error: unknown) => {
        console.error("Local meeting finish failed to start", {
          meetingId: meeting.meetingId,
          error,
        });
        return false;
      })
      .then((loaded) => (loaded ? undefined : endEncoder(meeting)));
  }

  /** Bounded, so an encoder that never exits cannot hold close or leak an unbounded wait. */
  async function endEncoder(meeting: MeetingData) {
    await attempt(meeting, "end-encoder", async () => {
      const ended = await within(
        deps.endEncoder(meeting),
        LIFECYCLE.closeEncoderMs,
      );
      if (ended === TIMED_OUT)
        console.warn("Meeting close encoder end timed out", {
          meetingId: meeting.meetingId,
        });
    });
  }

  /**
   * A lost lease saves nothing more: saving a checkpoint needs the lease, so
   * unsaved pieces are dropped and the row records an interrupted capture.
   */
  async function run(
    meeting: MeetingData,
    reservation: SessionReservation,
    cause: CloseCause,
  ) {
    let lost = false;
    let claimOwner: string | undefined;
    try {
      const ownership = await confirmOwnership(reservation);
      lost = ownership === "lost";
      const interrupted = lost || cause.abnormal === true;
      const disposition: Disposition = lost
        ? "lost"
        : interrupted
          ? "interrupted"
          : "complete";
      await stopReceiving(
        meeting,
        lost ? ABNORMAL_END : cause,
        interrupted ? "interrupted" : "complete",
      );
      await departVoice(meeting, ownership);
      if (reservation.sessionMode !== "meeting") return;
      const flushed = !lost && (await flush(meeting, cause.deadlineMs));
      const owner =
        !lost && deps.isEligible() && !deps.isShuttingDown()
          ? `${deps.instanceId()}:${randomUUID()}`
          : undefined;
      // The completion decision still follows how the capture was ended.
      if (!lost && !flushed && !owner) unsavedTail(meeting);
      const attempts =
        cause.deadlineMs === undefined ? LIFECYCLE.closeWriteAttempts : 1;
      if (
        await recordCaptureEnd(
          meeting,
          reservation,
          owner,
          disposition,
          attempts,
        )
      )
        claimOwner = owner;
    } finally {
      await free(meeting, reservation, lost);
      // Without a local finish nothing else would end the encoder this capture spawned.
      if (!claimOwner && reservation.sessionMode === "meeting")
        await endEncoder(meeting);
    }
    if (claimOwner) await startLocalFinish(meeting, claimOwner);
  }

  /** A capture whose lease this worker no longer holds, or that a failed start is already disposing, is not this module's to close. */
  function owned(
    meeting: MeetingData,
  ): meeting is MeetingData & { reservation: SessionReservation } {
    return Boolean(
      meeting.reservation &&
      deps.lease.holdsSessionLease(meeting.reservation) &&
      !meeting.finishing,
    );
  }

  /** Same promise for every caller of the same meeting. */
  function closeMeeting(meeting: MeetingData, cause: CloseCause) {
    const existing = closing.get(meeting);
    if (existing) return existing;
    if (!owned(meeting)) {
      console.warn("Meeting close refused a meeting it does not hold", {
        meetingId: meeting.meetingId,
        finishing: meeting.finishing,
      });
      return Promise.resolve();
    }
    // Before the first await, so a trigger arriving while the lease is confirmed sees it.
    meeting.finishing = true;
    const closed = run(meeting, meeting.reservation, cause).catch((error) => {
      console.error("Meeting close failed", {
        meetingId: meeting.meetingId,
        error,
      });
    });
    closing.set(meeting, closed);
    return closed;
  }

  /** Never rejects; returns once every capture closed or the shutdown budget is nearly spent. */
  async function closeAllCaptures(cause: CloseCause): Promise<void> {
    const closes = Promise.allSettled(
      deps
        .liveMeetings()
        .filter((meeting) => closing.has(meeting) || owned(meeting))
        .map((meeting) => closeMeeting(meeting, cause)),
    );
    await within(
      closes,
      LIFECYCLE.shutdownBudgetMs - LIFECYCLE.shutdownReserveMs,
    ).catch(() => undefined);
  }

  /**
   * Before the start has built the meeting there is nothing to close; renewal
   * has stopped, so the meeting's next close confirms the loss and takes the lost path.
   */
  function closeFromLease(cause: CloseCause): CaptureEndHandlers["onLost"] {
    return ({ meeting, reservation }) => {
      if (meeting) void closeMeeting(meeting, cause);
      else
        console.warn("Capture end arrived before the meeting was built", {
          meetingId: reservation.meetingId,
        });
    };
  }

  return {
    closeMeeting,
    closeAllCaptures,
    captureEndHandlers: {
      onLost: closeFromLease(ABNORMAL_END),
      onCapReached: closeFromLease(CAP_END),
    } satisfies CaptureEndHandlers,
  };
}

let localFinishStarter: LocalFinishStarter = async (meeting) => {
  console.warn("No local finish starter is registered", {
    meetingId: meeting.meetingId,
  });
  return false;
};

/** The finisher registers how a closed meeting with this worker's claim is finished. */
export function setLocalFinishStarter(start: LocalFinishStarter): void {
  localFinishStarter = start;
}

export function stopCapture(
  meeting: MeetingData,
  disposition: CaptureDisposition,
) {
  if (meeting.sessionMode === "tts_only") {
    meeting.ttsQueue?.stopAndClear();
    return;
  }
  stopRecordingCapture(meeting, disposition);
  stopThinkingCueLoop(meeting);
  stopCompletionClock(meeting);
}

export async function flushCapture(meeting: MeetingData): Promise<boolean> {
  checkpointRecordingContext(meeting);
  checkpointCompletedTranscription(meeting);
  const finished = meeting.recordingCapture
    ? await meeting.recordingCapture.finish()
    : true;
  // A fenced capture finishes at once; its failure's save appends the pending pieces and the coverage.
  return meeting.recordingPreservationTask
    ? meeting.recordingPreservationTask
    : finished;
}

/** Hands still-open snippets to transcription, so the last seconds before the stop reach the notes. */
export async function prepareLocalFinish(meeting: MeetingData): Promise<void> {
  try {
    await ensureMeetingTempDir(meeting);
  } catch (error) {
    // Each snippet then reports its own failure; skipping them would drop the last seconds silently.
    console.warn("Local finish could not create the meeting temp directory", {
      meetingId: meeting.meetingId,
      error,
    });
  }
  for (const snippet of meeting.audioData.currentSnippets.values())
    startProcessingSnippet(meeting, snippet.userId);
}

/** Publication needs the lease, so after close nothing may publish, retry or report a failure. */
export function retireCapture(meeting: MeetingData, ownershipLost: boolean) {
  meeting.recordingCapture?.retire();
  meeting.recordingCapture = undefined;
  if (ownershipLost)
    meeting.abortOwnership?.(
      new Error("Meeting lease lost to another meeting"),
    );
}

/** The capture is over here: readers of `finished` and `isFinished` see it ended. */
export function dropMeeting(meeting: MeetingData) {
  meeting.finished = true;
  meeting.setFinished();
  deleteMeeting(meeting);
}

let processClose: ReturnType<typeof createMeetingClose> | undefined;
function close() {
  processClose ??= createMeetingClose({
    lease: {
      confirmSessionLease,
      releaseSessionLease,
      latestLeaseCap,
      holdsSessionLease,
      confirmedLeaseExpiry,
    },
    finish: getMeetingFinishRepository(),
    stopCapture,
    leaveVoice,
    dropVoiceLocally,
    restoreNickname: (meeting) => restoreVoiceSessionNickname(meeting),
    flushCapture,
    prepareLocalFinish,
    retireCapture,
    dropMeeting,
    liveMeetings: getAllMeetings,
    releaseCaptureProtection,
    isEligible,
    isShuttingDown,
    instanceId: getRuntimeInstanceId,
    localFinishStarter: () => localFinishStarter,
    endEncoder: closeOutputFile,
    nowMs: Date.now,
    sleep: (ms, signal) =>
      sleep(ms, undefined, { signal, ref: false }).catch(() => undefined),
  });
  return processClose;
}

/**
 * Ends a meeting's capture and always frees the server: confirm the lease,
 * leave voice, flush, write `processing` with this worker's finish claim,
 * then release the lease and drop the meeting. Same promise for every caller.
 */
export function closeMeeting(
  meeting: MeetingData,
  cause: CloseCause,
): Promise<void> {
  return close().closeMeeting(meeting, cause);
}

/** Closes every live capture in this process for shutdown. Never rejects. */
export function closeAllCaptures(cause: CloseCause): Promise<void> {
  return close().closeAllCaptures(cause);
}

setCaptureEndHandlers({
  onLost: (event) => close().captureEndHandlers.onLost(event),
  onCapReached: (event) => close().captureEndHandlers.onCapReached(event),
});
