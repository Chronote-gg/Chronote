import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { meetingLeaseEvents, type MeetingLeaseEvent } from "../metrics";
import {
  getMeetingLeaseRepository,
  type LeaseOwnership,
  type LeaseSnapshot,
  type MeetingLeaseRepository,
  type StartSessionResult,
  type SuppressionCheck,
} from "../repositories/meetingLeaseRepository";
import { classifyDeploymentTransactionError } from "../repositories/deploymentControlErrors";
import type { ActiveMeetingLease, MeetingHistory } from "../types/db";
import type {
  SessionAdmissionResult,
  SessionReservation,
} from "../types/meetingHistoryTransition";
import { MEETING_END_REASONS, MEETING_STATUS } from "../types/meetingLifecycle";
import { getActiveMeetingLease, requestActiveMeetingEnd } from "../db";
import { leaseCapEpochSeconds, LIFECYCLE } from "./lifecycleTiming";
import { getRuntimeInstanceId } from "./runtimeInstanceService";

const MS_PER_SECOND = 1000;
/** A second refusal in one tick leaves the outcome unknown until the next tick. */
const RETAKE_ATTEMPTS_PER_TICK = 2;

export type AcquireSessionLeaseInput = {
  guildId: string;
  meetingId: string;
  voiceChannelId: string;
  voiceChannelName?: string;
  textChannelId: string;
  isAutoRecording: boolean;
  startReason?: ActiveMeetingLease["startReason"];
  startTriggeredByUserId?: string;
  autoRecordRule?: ActiveMeetingLease["autoRecordRule"];
  reservedAt: number;
  timingReceipt?: SessionReservation["timingReceipt"];
  suppression?: { channelId: string; expectedVersion?: number };
  signal?: AbortSignal;
} & (
  | { sessionMode: "meeting"; history: MeetingHistory }
  | { sessionMode: "tts_only"; history?: never }
);

/** Whether the lease is still unexpired at `nowEpochSeconds`. */
export function isLeaseActive(
  lease: Pick<ActiveMeetingLease, "leaseExpiresAt">,
  nowEpochSeconds = Math.floor(Date.now() / MS_PER_SECOND),
): boolean {
  return lease.leaseExpiresAt >= nowEpochSeconds;
}

/** The server's recording lease; a voice-only session's lease is not a recording. */
export async function getActiveMeetingLeaseForGuild(
  guildId: string,
  signal?: AbortSignal,
): Promise<ActiveMeetingLease | undefined> {
  const lease = await getActiveMeetingLease(guildId, signal);
  return lease?.sessionMode && lease.sessionMode !== "meeting"
    ? undefined
    : lease;
}

/** Records a stop request on the lease; the recording worker picks it up on its next renewal. */
export function requestMeetingEndViaLease(
  guildId: string,
  meetingId: string,
  requestedByUserId: string,
  endReason: ActiveMeetingLease["endReason"] = MEETING_END_REASONS.WEB_UI,
): Promise<boolean> {
  return requestActiveMeetingEnd(
    guildId,
    meetingId,
    requestedByUserId,
    new Date().toISOString(),
    endReason,
  );
}
export type LeaseRenewalHooks = {
  maxDurationMs: number;
  snapshot(): LeaseSnapshot;
  onEndRequested(lease: ActiveMeetingLease): void;
  onLost(): void;
  onCapReached(): void;
};
export type MeetingLeaseDeps = {
  repository: MeetingLeaseRepository;
  instanceId(): string;
  nowMs(): number;
  /** Runs `run` once after `delayMs` and returns a function that cancels it. */
  schedule(run: () => Promise<void>, delayMs: number): () => void;
  /** Bounds one repository call. Defaults to `LIFECYCLE.leaseHeartbeatMs`. */
  requestSignal?(): AbortSignal;
  delay?(ms: number): Promise<void>;
};

type HeldLease = {
  reservation: SessionReservation;
  /** The record written at start, which a retake writes again. */
  lease: ActiveMeetingLease;
  confirmedUntil: number;
  state: "held" | "capped" | "lost";
  renewal?: { hooks: LeaseRenewalHooks; cap: number; cancel?: () => void };
  lastEndRequestAt?: string;
  queue: Promise<unknown>;
};
/**
 * `capped`: the lease is past its cap and no other meeting holds the server,
 * so a close still owns voice and leaves it normally.
 */
export type ConfirmOutcome = "held" | "lost" | "capped";
/** `lost` is the transition to lost; `already_lost` means another operation saw it first. */
type RenewOutcome = "held" | "lost" | "already_lost" | "past_cap";
type StartRequest = Parameters<MeetingLeaseRepository["startSession"]>[0];

const epochSeconds = (ms: number) => Math.floor(ms / MS_PER_SECOND);
const count = (event: MeetingLeaseEvent) => meetingLeaseEvents.inc({ event });

function ownershipOf(reservation: SessionReservation): LeaseOwnership {
  const {
    guildId,
    meetingId,
    ownerInstanceId,
    executionVersion,
    voiceOperationAttemptId,
    sessionMode,
  } = reservation;
  return {
    guildId,
    meetingId,
    ownerInstanceId,
    executionVersion,
    voiceOperationAttemptId,
    sessionMode,
  };
}

function initialHistory(
  history: MeetingHistory,
  ownerInstanceId: string,
): MeetingHistory {
  return {
    ...history,
    ownerInstanceId,
    executionVersion: 1,
    lifecycleVersion: 2,
    canonicalWriter: {
      kind: "recording",
      ownerInstanceId,
      executionVersion: 1,
    },
    status: MEETING_STATUS.STARTING,
  };
}

/** A retake keeps a remote stop request on the item, as a renewal leaves it in place. */
function carriedEndRequest(
  current: ActiveMeetingLease,
  snapshot: LeaseSnapshot,
) {
  return {
    endRequestedAt: current.endRequestedAt,
    endRequestedByUserId: current.endRequestedByUserId,
    endReason: snapshot.endReason ?? current.endReason,
  };
}

export function createMeetingLeaseService(deps: MeetingLeaseDeps) {
  const requestSignal =
    deps.requestSignal ??
    (() => AbortSignal.timeout(LIFECYCLE.leaseHeartbeatMs));
  const delay = deps.delay ?? ((ms: number) => sleep(ms));
  const held = new Map<string, HeldLease>();
  const heldFor = (reservation: SessionReservation) => {
    const entry = held.get(reservation.voiceOperationAttemptId);
    if (!entry) throw new Error("Session lease is not held by this process");
    return entry;
  };

  /** One lease write at a time per session, so a tick and a close never race each other. */
  function serialized<T>(entry: HeldLease, operation: () => Promise<T>) {
    const run = entry.queue.then(operation);
    entry.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * The SDK honours the signal for network waits; the race also settles an
   * operation that ignores it, so a hung call can never stall a session's queue.
   */
  function bounded<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    callerSignal?: AbortSignal,
  ): Promise<T> {
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, requestSignal()])
      : requestSignal();
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      if (signal.aborted) return abort();
      signal.addEventListener("abort", abort, { once: true });
      operation(signal)
        .then(resolve, reject)
        .finally(() => signal.removeEventListener("abort", abort));
    });
  }

  /**
   * Concurrent starts can cancel each other for conflict; the same token keeps a
   * retry idempotent. Any error leaves the commit unknown, so the lease is read
   * back once: this attempt's lease means it was admitted.
   */
  async function startSession(
    request: StartRequest,
    callerSignal?: AbortSignal,
  ): Promise<StartSessionResult> {
    let failure: unknown;
    for (let attempt = 1; attempt <= LIFECYCLE.closeWriteAttempts; attempt++) {
      try {
        return await bounded(
          (signal) => deps.repository.startSession({ ...request, signal }),
          callerSignal,
        );
      } catch (error) {
        failure = error;
        if (
          classifyDeploymentTransactionError(error) !== "conflict" ||
          attempt === LIFECYCLE.closeWriteAttempts ||
          callerSignal?.aborted
        )
          break;
        await delay(LIFECYCLE.startConflictRetryMs);
        if (callerSignal?.aborted) break;
      }
    }
    const thrown = callerSignal?.aborted ? callerSignal.reason : failure;
    const outcome = await readBackStart(request).catch(() => undefined);
    if (outcome) return outcome;
    throw thrown;
  }

  /** Uses a fresh bound, because a commit may have landed after the caller gave up. */
  async function readBackStart(
    request: StartRequest,
  ): Promise<StartSessionResult | undefined> {
    const current = await bounded((signal) =>
      deps.repository.read(request.lease.guildId, signal),
    );
    if (!current || current.leaseExpiresAt < epochSeconds(deps.nowMs()))
      return undefined;
    if (current.meetingId !== request.lease.meetingId) return "active_session";
    return current.voiceOperationAttemptId ===
      request.lease.voiceOperationAttemptId
      ? "admitted"
      : undefined;
  }

  async function resolveSuppression(
    input: AcquireSessionLeaseInput,
  ): Promise<SuppressionCheck | "suppressed" | undefined> {
    const { suppression } = input;
    if (!suppression || suppression.expectedVersion !== undefined)
      return suppression;
    const state = await bounded(
      (signal) =>
        deps.repository.readSuppression(
          input.guildId,
          suppression.channelId,
          signal,
        ),
      input.signal,
    );
    if (state?.suppressed) return "suppressed";
    return { ...suppression, expectedVersion: state?.version };
  }

  async function acquireSessionLease(
    input: AcquireSessionLeaseInput,
  ): Promise<SessionAdmissionResult> {
    const suppression = await resolveSuppression(input);
    if (suppression === "suppressed")
      return { kind: "blocked", reason: "suppressed" };
    const nowMs = deps.nowMs();
    const now = epochSeconds(nowMs);
    const ownerInstanceId = deps.instanceId();
    const voiceOperationAttemptId = randomUUID();
    const createdAt = new Date(nowMs).toISOString();
    const leaseExpiresAt = now + LIFECYCLE.leaseSeconds;
    const lease: ActiveMeetingLease = {
      guildId: input.guildId,
      meetingId: input.meetingId,
      ownerInstanceId,
      executionVersion: 1,
      sessionMode: input.sessionMode,
      voiceOperationAttemptId,
      voiceChannelId: input.voiceChannelId,
      voiceChannelName: input.voiceChannelName,
      textChannelId: input.textChannelId,
      isAutoRecording: input.isAutoRecording,
      status: MEETING_STATUS.STARTING,
      leaseExpiresAt,
      createdAt,
      updatedAt: createdAt,
      expiresAt: leaseExpiresAt + LIFECYCLE.leaseTtlGraceSeconds,
      startReason: input.startReason,
      startTriggeredByUserId: input.startTriggeredByUserId,
      autoRecordRule: input.autoRecordRule,
    };
    const history =
      input.sessionMode === "meeting"
        ? initialHistory(input.history, ownerInstanceId)
        : undefined;
    const outcome = await startSession(
      { lease, history, suppression, now },
      input.signal,
    );
    if (outcome !== "admitted") return { kind: "blocked", reason: outcome };
    const shared = {
      guildId: input.guildId,
      meetingId: input.meetingId,
      ownerInstanceId,
      executionVersion: 1,
      voiceOperationAttemptId,
      reservedAt: input.reservedAt,
      timingReceipt: input.timingReceipt,
    };
    const reservation: SessionReservation =
      input.sessionMode === "meeting"
        ? {
            ...shared,
            sessionMode: "meeting",
            historyKey: {
              guildId: input.guildId,
              channelId_timestamp: input.history.channelId_timestamp,
            },
          }
        : { ...shared, sessionMode: "tts_only" };
    held.set(voiceOperationAttemptId, {
      reservation,
      lease,
      confirmedUntil: leaseExpiresAt,
      state: "held",
      queue: Promise.resolve(),
    });
    return { kind: "admitted", reservation };
  }

  async function renew(entry: HeldLease): Promise<RenewOutcome> {
    if (entry.state === "lost") return "already_lost";
    if (!entry.renewal)
      throw new Error("Session lease renewal has not started");
    const { hooks, cap } = entry.renewal;
    const nowMs = deps.nowMs();
    const now = epochSeconds(nowMs);
    const leaseExpiresAt = Math.min(now + LIFECYCLE.leaseSeconds, cap);
    if (leaseExpiresAt < now) return "past_cap";
    const next = {
      leaseExpiresAt,
      expiresAt: leaseExpiresAt + LIFECYCLE.leaseTtlGraceSeconds,
      updatedAt: new Date(nowMs).toISOString(),
      snapshot: hooks.snapshot(),
    };
    const ownership = ownershipOf(entry.reservation);
    if (
      await bounded((signal) =>
        deps.repository.renew(ownership, next, now, signal),
      )
    ) {
      entry.confirmedUntil = leaseExpiresAt;
      return "held";
    }
    const { snapshot, ...timing } = next;
    for (let attempt = 1; ; attempt++) {
      const current = await bounded((signal) =>
        deps.repository.read(ownership.guildId, signal),
      );
      const ours =
        current?.meetingId === ownership.meetingId &&
        current.ownerInstanceId === ownership.ownerInstanceId;
      if (current && current.leaseExpiresAt >= now && !ours)
        return markLost(entry, "Meeting lease names another meeting");
      // Past the grace the finisher may already have adopted the recording.
      // Measured when the read returns, since the renewal and the read each take time.
      const lapsedAt = ours
        ? Math.max(current.leaseExpiresAt, entry.confirmedUntil)
        : entry.confirmedUntil;
      if (
        epochSeconds(deps.nowMs()) - lapsedAt >=
        LIFECYCLE.abandonedGraceSeconds
      )
        return markLost(entry, "Meeting lease lapsed past the adoption grace");
      const carried =
        current?.meetingId === ownership.meetingId
          ? carriedEndRequest(current, snapshot)
          : {};
      const retaken = await bounded((signal) =>
        deps.repository.retake(
          { ...entry.lease, ...snapshot, ...carried, ...timing },
          now,
          signal,
        ),
      );
      if (retaken) break;
      if (attempt >= RETAKE_ATTEMPTS_PER_TICK)
        throw new Error("Meeting lease retake kept failing its condition");
    }
    entry.confirmedUntil = leaseExpiresAt;
    count("retaken");
    console.warn("Meeting lease retaken after a failed renewal", {
      meetingId: ownership.meetingId,
    });
    return "held";
  }

  /** Runs inside the serialized operation, so a racing tick and confirm count it once. */
  function markLost(entry: HeldLease, reason: string): "lost" | "already_lost" {
    if (entry.state === "lost") return "already_lost";
    entry.state = "lost";
    count("lost");
    console.warn(`${reason}, renewal stopped`, {
      meetingId: entry.reservation.meetingId,
    });
    return "lost";
  }

  /** A lease past its cap may have expired, so whether the server is still ours needs a read. */
  async function takenByAnother(reservation: SessionReservation) {
    const current = await bounded((signal) =>
      deps.repository.read(reservation.guildId, signal),
    );
    const ours =
      current?.meetingId === reservation.meetingId &&
      current.ownerInstanceId === reservation.ownerInstanceId;
    return Boolean(
      current && !ours && current.leaseExpiresAt >= epochSeconds(deps.nowMs()),
    );
  }

  async function passEndRequest(entry: HeldLease, hooks: LeaseRenewalHooks) {
    let lease: ActiveMeetingLease | undefined;
    try {
      lease = await bounded((signal) =>
        deps.repository.read(entry.reservation.guildId, signal),
      );
    } catch (error) {
      // The renewal already succeeded; a missed stop request is picked up next tick.
      console.warn("Meeting lease stop-request read failed", {
        meetingId: entry.reservation.meetingId,
        error,
      });
      return;
    }
    if (
      lease?.meetingId !== entry.reservation.meetingId ||
      !lease.endRequestedAt ||
      lease.endRequestedAt === entry.lastEndRequestAt
    )
      return;
    entry.lastEndRequestAt = lease.endRequestedAt;
    hooks.onEndRequested(lease);
  }

  async function tick(entry: HeldLease) {
    const renewal = entry.renewal;
    const stillHeld = () =>
      held.get(entry.reservation.voiceOperationAttemptId) === entry;
    if (entry.state !== "held" || !renewal) return;
    try {
      const outcome = await serialized(entry, () => renew(entry));
      if (!stillHeld() || outcome === "already_lost") return;
      if (outcome === "lost") renewal.hooks.onLost();
      else if (outcome === "past_cap" || entry.confirmedUntil >= renewal.cap) {
        entry.state = "capped";
        count("cap");
        renewal.hooks.onCapReached();
      } else await passEndRequest(entry, renewal.hooks);
    } catch (error) {
      count("renew_error");
      console.warn("Meeting lease renewal failed, retrying next heartbeat", {
        meetingId: entry.reservation.meetingId,
        error,
      });
    }
    if (entry.state === "held" && stillHeld())
      renewal.cancel = deps.schedule(
        () => tick(entry),
        LIFECYCLE.leaseHeartbeatMs,
      );
  }

  return {
    acquireSessionLease,
    startLeaseRenewal(
      reservation: SessionReservation,
      hooks: LeaseRenewalHooks,
    ): void {
      const entry = heldFor(reservation);
      if (entry.renewal)
        throw new Error("Session lease renewal already started");
      entry.renewal = {
        hooks,
        cap: leaseCapEpochSeconds(reservation.reservedAt, hooks.maxDurationMs),
      };
      entry.renewal.cancel = deps.schedule(
        () => tick(entry),
        LIFECYCLE.leaseHeartbeatMs,
      );
    },
    async confirmSessionLease(
      reservation: SessionReservation,
    ): Promise<ConfirmOutcome> {
      const entry = heldFor(reservation);
      if (entry.state === "lost") return "lost";
      return serialized(entry, async () => {
        const outcome = await renew(entry);
        if (outcome === "held") return "held";
        if (outcome !== "past_cap") return "lost";
        if (!(await takenByAnother(reservation))) return "capped";
        markLost(entry, "Meeting lease names another meeting");
        return "lost";
      });
    },
    async releaseSessionLease(reservation: SessionReservation): Promise<void> {
      const entry = held.get(reservation.voiceOperationAttemptId);
      held.delete(reservation.voiceOperationAttemptId);
      entry?.renewal?.cancel?.();
      const release = () =>
        bounded((signal) =>
          deps.repository.release(ownershipOf(reservation), signal),
        );
      await (entry ? serialized(entry, release) : release());
    },
    holdsSessionLease(reservation: SessionReservation): boolean {
      return held.has(reservation.voiceOperationAttemptId);
    },
    confirmedLeaseExpiry(reservation: SessionReservation): number | undefined {
      return held.get(reservation.voiceOperationAttemptId)?.confirmedUntil;
    },
    latestLeaseCap(now: number): number | undefined {
      let latest: number | undefined;
      for (const entry of held.values()) {
        // Only recording sessions hold protection; a voice-only lease never asked for it.
        if (
          !entry.renewal ||
          entry.reservation.sessionMode !== "meeting" ||
          entry.state === "lost" ||
          entry.confirmedUntil < now
        )
          continue;
        latest = Math.max(latest ?? entry.renewal.cap, entry.renewal.cap);
      }
      return latest;
    },
  };
}
export type MeetingLeaseService = ReturnType<typeof createMeetingLeaseService>;

let processService: MeetingLeaseService | undefined;
function service(): MeetingLeaseService {
  processService ??= createMeetingLeaseService({
    repository: getMeetingLeaseRepository(),
    instanceId: getRuntimeInstanceId,
    nowMs: Date.now,
    schedule(run, delayMs) {
      const timer = setTimeout(() => void run(), delayMs);
      timer.unref();
      return () => clearTimeout(timer);
    },
  });
  return processService;
}

export function acquireSessionLease(
  input: AcquireSessionLeaseInput,
): Promise<SessionAdmissionResult> {
  return service().acquireSessionLease(input);
}
export function startLeaseRenewal(
  reservation: SessionReservation,
  hooks: LeaseRenewalHooks,
): void {
  service().startLeaseRenewal(reservation, hooks);
}
/** Conditional renewal; a failed condition reads and retakes, and an error throws. */
export function confirmSessionLease(
  reservation: SessionReservation,
): Promise<ConfirmOutcome> {
  return service().confirmSessionLease(reservation);
}
/** Stops renewal and deletes the lease; a failed condition is not an error. */
export function releaseSessionLease(
  reservation: SessionReservation,
): Promise<void> {
  return service().releaseSessionLease(reservation);
}
/** Whether this process admitted the reservation and has not released it. */
export function holdsSessionLease(reservation: SessionReservation): boolean {
  return service().holdsSessionLease(reservation);
}
/** Epoch seconds the lease was last confirmed until, while it is held. */
export function confirmedLeaseExpiry(
  reservation: SessionReservation,
): number | undefined {
  return service().confirmedLeaseExpiry(reservation);
}
/** Largest cap, in epoch seconds, over renewed recording reservations whose confirmed lease is unexpired at `now`. */
export function latestLeaseCap(now: number): number | undefined {
  return service().latestLeaseCap(now);
}
