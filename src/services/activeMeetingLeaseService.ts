import { areMeetingNoticesSettled } from "./meetingProcessingLifetime";
import { isDeepStrictEqual } from "node:util";
import type { RecordingCheckpoint } from "../types/recordingCheckpoint";
import {
  getActiveMeetingLease,
  requestActiveMeetingEnd,
  releaseActiveMeetingLease,
  renewActiveMeetingLease,
  getDeploymentControlRepository,
  transitionMeetingHistory,
} from "../db";
import {
  MEETING_END_REASONS,
  MEETING_STATUS,
  resolveMeetingStatus,
} from "../types/meetingLifecycle";
import type { ActiveMeetingLease } from "../types/db";
import type { MeetingData } from "../types/meeting-data";
import { getRuntimeInstanceId } from "./runtimeInstanceService";
import { randomUUID } from "node:crypto";
import type { MeetingHistory } from "../types/db";
import type {
  AdmissionContext,
  SessionAdmissionResult,
  SessionReservation,
  SessionReservationInput,
} from "../types/deploymentControl";
import {
  beginRuntimeWork,
  getRuntimeAdmissionContext,
} from "./runtimeLifecycleService";
import {
  prepareOwnedVoiceSession,
  settleOwnedVoiceSession,
} from "./guildVoiceOperationService";

const ACTIVE_MEETING_LEASE_SECONDS = 30;
const ACTIVE_MEETING_HEARTBEAT_MS = 10_000;
const ACTIVE_MEETING_TTL_GRACE_SECONDS = 120;

export type AcquireMeetingLeaseInput = {
  assertStartAllowed?: () => Promise<void>;
  startSignal?: AbortSignal;
  guildId: string;
  meetingId: string;
  voiceChannelId: string;
  voiceChannelName?: string;
  textChannelId: string;
  isAutoRecording: boolean;
  startReason?: ActiveMeetingLease["startReason"];
  startTriggeredByUserId?: string;
  autoRecordRule?: ActiveMeetingLease["autoRecordRule"];
  admissionContext?: AdmissionContext;
  reservedAt: number;
  timingReceipt?: SessionReservation["timingReceipt"];
  suppression?: { channelId: string; expectedVersion?: number };
} & (
  | { sessionMode: "meeting"; history: MeetingHistory }
  | { sessionMode: "tts_only"; history?: never }
);
type OwnedReservation = {
  releasing?: boolean;
  reservation: SessionReservation;
  controller: AbortController;
  timer?: ReturnType<typeof setInterval>;
  meeting?: MeetingData;
  renewal?: Promise<void>;
  release?: Promise<boolean>;
  initializationUnresolved?: boolean;
  initializationCleanup?: Promise<boolean>;
};
const reservations = new Map<string, OwnedReservation>();
const processedRemoteEndRequests = new WeakMap<MeetingData, string>();
const pendingReservations = new Map<string, Promise<SessionAdmissionResult>>();
const uncertainAdmissions = new Map<
  string,
  {
    guildId: string;
    meetingId: string;
    voiceOperationAttemptId: string;
    workHandle: SessionReservation["workHandle"];
  }
>();
const reservationKey = (guildId: string, meetingId: string) =>
  `${guildId}:${meetingId}`;

type MeetingLeaseSnapshotUpdate = {
  status: ActiveMeetingLease["status"];
  endReason?: ActiveMeetingLease["endReason"];
  endTriggeredByUserId?: ActiveMeetingLease["endTriggeredByUserId"];
  cancellationReason?: ActiveMeetingLease["cancellationReason"];
  endedAt?: ActiveMeetingLease["endedAt"];
};

function buildMeetingLeaseSnapshot(
  meeting: MeetingData,
): MeetingLeaseSnapshotUpdate {
  const status = resolveMeetingStatus({
    cancelled: meeting.cancelled,
    finished: meeting.finished,
    finishing: meeting.finishing,
  });

  const snapshot: MeetingLeaseSnapshotUpdate = {
    status,
    endReason: meeting.endReason,
    endTriggeredByUserId: meeting.endTriggeredByUserId,
    cancellationReason: meeting.cancellationReason,
  };

  if (meeting.endTime) {
    snapshot.endedAt = meeting.endTime.toISOString();
  } else if (
    status === MEETING_STATUS.CANCELLED ||
    status === MEETING_STATUS.COMPLETE
  ) {
    snapshot.endedAt = new Date().toISOString();
  }

  return snapshot;
}

function buildLeaseTimestamps(nowMs: number): {
  createdAt: string;
  updatedAt: string;
  leaseExpiresAt: number;
  expiresAt: number;
  nowEpochSeconds: number;
} {
  const createdAt = new Date(nowMs).toISOString();
  const nowEpochSeconds = Math.floor(nowMs / 1000);
  const leaseExpiresAt = nowEpochSeconds + ACTIVE_MEETING_LEASE_SECONDS;
  const expiresAt = leaseExpiresAt + ACTIVE_MEETING_TTL_GRACE_SECONDS;
  return {
    createdAt,
    updatedAt: createdAt,
    leaseExpiresAt,
    expiresAt,
    nowEpochSeconds,
  };
}

export function getCurrentMeetingLeaseOwnerInstanceId(): string {
  return getRuntimeInstanceId();
}

export function isLeaseActive(
  lease: ActiveMeetingLease,
  nowEpochSeconds = Math.floor(Date.now() / 1000),
): boolean {
  return lease.leaseExpiresAt >= nowEpochSeconds;
}

export async function getActiveMeetingLeaseForGuild(
  guildId: string,
): Promise<ActiveMeetingLease | undefined> {
  const lease = await getActiveMeetingLease(guildId);
  return lease?.sessionMode && lease.sessionMode !== "meeting"
    ? undefined
    : lease;
}

export function tryAcquireMeetingLease(
  input: AcquireMeetingLeaseInput,
): Promise<SessionAdmissionResult> {
  const key = reservationKey(input.guildId, input.meetingId);
  const pending = pendingReservations.get(key);
  if (pending) return pending;
  let workHandle;
  try {
    workHandle = beginRuntimeWork("pending_admission");
  } catch {
    return Promise.resolve({ kind: "blocked", reason: "not_serving" });
  }
  const acquisition = acquireReservation(input, workHandle);
  pendingReservations.set(key, acquisition);
  void acquisition.then((result) => {
    if (result.kind === "blocked" && result.reason !== "unavailable")
      pendingReservations.delete(key);
  });
  return acquisition;
}

async function acquireReservation(
  input: AcquireMeetingLeaseInput,
  workHandle: SessionReservation["workHandle"],
): Promise<SessionAdmissionResult> {
  const {
    guildId,
    meetingId,
    voiceChannelId,
    voiceChannelName,
    textChannelId,
    isAutoRecording,
    startReason,
    startTriggeredByUserId,
    autoRecordRule,
    sessionMode,
  } = input;
  let context: AdmissionContext;
  try {
    context = input.admissionContext ?? (await getRuntimeAdmissionContext());
  } catch {
    workHandle.settle();
    return { kind: "blocked", reason: "not_serving" };
  }
  const nowMs = Date.now();
  const { createdAt, updatedAt, leaseExpiresAt, expiresAt, nowEpochSeconds } =
    buildLeaseTimestamps(nowMs);
  const voiceOperationAttemptId = randomUUID();
  const leaseRecord = {
    guildId,
    meetingId,
    ownerInstanceId: context.instanceId,
    executionVersion: 1,
    sessionMode,
    voiceOperationAttemptId,
    voiceChannelId,
    voiceChannelName,
    textChannelId,
    isAutoRecording,
    status: MEETING_STATUS.STARTING,
    leaseExpiresAt,
    createdAt,
    updatedAt,
    expiresAt,
    startReason,
    startTriggeredByUserId,
    autoRecordRule,
  };
  const history = input.history
    ? {
        ...input.history,
        ownerInstanceId: context.instanceId,
        executionVersion: 1,
        status: MEETING_STATUS.STARTING,
      }
    : undefined;
  const request = {
    context: { ...context, now: nowEpochSeconds },
    lease: leaseRecord,
    voice: {
      pk: `VOICE#${guildId}`,
      sk: "STATE" as const,
      recordType: "voice" as const,
      protocolVersion: 1 as const,
      guildId,
      meetingId,
      ownerInstanceId: context.instanceId,
      attemptId: voiceOperationAttemptId,
      executionVersion: 1,
      sessionMode,
      state: "joining" as const,
      updatedAt: nowEpochSeconds,
    },
    history,
    requestToken: voiceOperationAttemptId,
    suppression: input.suppression,
  };
  let result;
  let attempted = false;
  try {
    if (await observeReservationSuppression(request)) {
      workHandle.settle();
      return { kind: "blocked", reason: "suppressed" };
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      await input.assertStartAllowed?.();
      input.startSignal?.throwIfAborted();
      attempted = true;
      result = await getDeploymentControlRepository().reserveSession(request);
      if (result.kind === "admitted" || result.reason !== "unavailable") break;
    }
  } catch {
    result = {
      kind: "blocked" as const,
      reason: attempted ? ("unavailable" as const) : ("not_serving" as const),
    };
  }
  if (!result) throw new Error("Reservation retry loop produced no result");
  if (result.kind === "blocked") {
    if (result.reason === "unavailable")
      uncertainAdmissions.set(reservationKey(guildId, meetingId), {
        guildId,
        meetingId,
        voiceOperationAttemptId,
        workHandle,
      });
    else workHandle.settle();
    return result;
  }
  const shared = {
    guildId,
    meetingId,
    ownerInstanceId: context.instanceId,
    executionVersion: 1,
    voiceOperationAttemptId,
    reservedAt: input.reservedAt,
    timingReceipt: input.timingReceipt,
    workHandle,
  };
  const reservation: SessionReservation = history
    ? {
        ...shared,
        sessionMode: "meeting",
        historyKey: {
          guildId,
          channelId_timestamp: history.channelId_timestamp,
        },
      }
    : { ...shared, sessionMode: "tts_only" };
  const owned: OwnedReservation = {
    reservation,
    controller: new AbortController(),
  };
  reservations.set(reservationKey(guildId, meetingId), owned);
  prepareOwnedVoiceSession(reservation);
  owned.timer = setInterval(() => {
    void renewReservation(owned);
  }, ACTIVE_MEETING_HEARTBEAT_MS);
  owned.timer.unref?.();
  await renewReservation(owned);
  return { kind: "admitted", reservation };
}

async function observeReservationSuppression(
  request: SessionReservationInput,
): Promise<boolean> {
  if (!request.suppression) return false;
  const row = await getDeploymentControlRepository().getRecord(
    `SUPPRESS#${request.lease.guildId}`,
    `CHANNEL#${request.suppression.channelId}`,
  );
  if (row?.recordType !== "suppression") return false;
  if (row.suppressed) return true;
  request.suppression = {
    ...request.suppression,
    expectedVersion: request.suppression.expectedVersion ?? row.version,
  };
  return false;
}
function renewReservation(owned: OwnedReservation): Promise<void> {
  if (owned.renewal) return owned.renewal;
  if (owned.controller.signal.aborted || owned.releasing)
    return Promise.resolve();
  let resolve!: () => void;
  const renewal = new Promise<void>((done) => {
    resolve = done;
  });
  owned.renewal = renewal;
  void performReservationRenewal(owned).finally(() => {
    owned.renewal = undefined;
    resolve();
  });
  return renewal;
}
async function readRecordingControlLease(
  reservation: SessionReservation,
): Promise<ActiveMeetingLease | undefined> {
  try {
    return await getActiveMeetingLease(
      reservation.guildId,
      AbortSignal.timeout(5000),
    );
  } catch (error) {
    // A failed stop-request read does not invalidate the acknowledged lease renewal.
    console.warn("Recording stop-request read failed after lease renewal", {
      meetingId: reservation.meetingId,
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return undefined;
  }
}
async function performReservationRenewal(
  owned: OwnedReservation,
): Promise<void> {
  const { reservation, meeting } = owned;
  try {
    const { updatedAt, leaseExpiresAt, expiresAt } = buildLeaseTimestamps(
      Date.now(),
    );
    const renewed = await renewActiveMeetingLease(
      reservation.guildId,
      reservation.meetingId,
      reservation.ownerInstanceId,
      leaseExpiresAt,
      updatedAt,
      expiresAt,
      meeting && !owned.initializationUnresolved
        ? buildMeetingLeaseSnapshot(meeting)
        : { status: MEETING_STATUS.STARTING },
      reservation,
    );
    if (!renewed) throw new Error("Reservation ownership lost");
    if (meeting) {
      const lease = await readRecordingControlLease(reservation);
      if (lease) processRemoteEndRequest(lease, meeting);
    }
  } catch (error) {
    console.warn("Recording reservation renewal could not confirm ownership", {
      meetingId: reservation.meetingId,
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    owned.controller.abort();
    if (owned.timer) clearInterval(owned.timer);
    if (meeting && !meeting.finishing && !meeting.finished)
      dispatchEndMeeting(meeting);
  }
}
export function getReservationSignal(
  reservation: SessionReservation,
): AbortSignal {
  const owned = reservations.get(
    reservationKey(reservation.guildId, reservation.meetingId),
  );
  if (!owned || owned.reservation !== reservation)
    throw new Error("Reservation is not locally owned");
  return owned.controller.signal;
}
export function attachMeetingReservation(
  meeting: MeetingData,
  reservation: SessionReservation,
): void {
  const owned = reservations.get(
    reservationKey(reservation.guildId, reservation.meetingId),
  );
  if (!owned || owned.controller.signal.aborted)
    throw new Error("Reservation initialization was closed");
  owned.meeting = meeting;
  meeting.ownershipSignal = owned.controller.signal;
  reservation.workHandle.transition(
    reservation.sessionMode === "meeting" ? "recording" : "voice_operation",
  );
}
export function isReservationControlEligible(
  reservation: SessionReservation,
): boolean {
  const owned = reservations.get(
    reservationKey(reservation.guildId, reservation.meetingId),
  );
  return Boolean(
    owned &&
    owned.reservation === reservation &&
    !owned.releasing &&
    !owned.controller.signal.aborted,
  );
}
function reservationReleaseBlocked(
  owned: OwnedReservation | undefined,
): boolean {
  if (owned?.initializationUnresolved) return true;
  if (!owned?.meeting) return false;
  const meeting = owned.meeting;
  return Boolean(
    !areMeetingNoticesSettled(meeting, owned.reservation) ||
    meeting.finalizationFenced ||
    meeting.ownershipSignal?.aborted ||
    meeting.finalization?.controller.signal.aborted ||
    (meeting.finalization && meeting.finalization.disposition !== "durable"),
  );
}
export async function releaseSessionReservation(
  reservation: SessionReservation,
): Promise<boolean> {
  const key = reservationKey(reservation.guildId, reservation.meetingId);
  const owned = reservations.get(key);
  if (reservationReleaseBlocked(owned)) return false;
  const outcome = await settleOwnedVoiceSession(reservation);
  if (outcome !== "settled") {
    reservation.workHandle.transition("voice_operation");
    return false;
  }
  if (reservationReleaseBlocked(owned)) return false;
  if (owned) owned.releasing = true;
  const deletion = Promise.resolve().then(() =>
    releaseActiveMeetingLease(
      reservation.guildId,
      reservation.meetingId,
      reservation.ownerInstanceId,
      reservation,
    ),
  );
  if (owned) owned.release = deletion;
  const released = await deletion;
  if (!released || reservationReleaseBlocked(owned)) return false;
  if (owned?.timer) clearInterval(owned.timer);
  reservation.workHandle.settle();
  reservations.delete(key);
  pendingReservations.delete(key);
  return true;
}
export type PreservedRecordingReleaseProof = {
  checkpoint: RecordingCheckpoint;
  status: "complete" | "failed" | "interrupted";
  localWork: Promise<void>;
  signal: AbortSignal;
  deadline: number;
};
function matchesPreservedHistory(
  row: Awaited<
    ReturnType<
      ReturnType<typeof getDeploymentControlRepository>["getMeetingHistory"]
    >
  >,
  reservation: Extract<SessionReservation, { sessionMode: "meeting" }>,
  proof: PreservedRecordingReleaseProof,
): boolean {
  return !(
    !row ||
    (row.recovery?.stage === "delivery" &&
      row.recovery.disposition !== "done") ||
    row.meetingId !== reservation.meetingId ||
    row.ownerInstanceId !== reservation.ownerInstanceId ||
    row.executionVersion !== reservation.executionVersion ||
    row.status !== proof.status ||
    !isDeepStrictEqual(
      JSON.parse(JSON.stringify(row.checkpoint ?? null)),
      JSON.parse(JSON.stringify(proof.checkpoint)),
    ) ||
    (proof.status !== "complete" &&
      (!row.recovery ||
        row.recovery.executionVersion !== reservation.executionVersion ||
        !["pending", "needs_reconciliation"].includes(
          row.recovery.disposition,
        )))
  );
}
/** Only the exact original attempt, verified terminal checkpoint and actual local/voice settlement permit this reconciliation. */
export async function reconcilePreservedRecordingReservation(
  reservation: Extract<SessionReservation, { sessionMode: "meeting" }>,
  proof: PreservedRecordingReleaseProof,
): Promise<boolean> {
  const key = reservationKey(reservation.guildId, reservation.meetingId);
  const owned = reservations.get(key);
  if (!owned || owned.reservation !== reservation) return false;
  await proof.localWork;
  if (
    owned.initializationUnresolved &&
    (await owned.initializationCleanup?.catch(() => false)) !== true
  )
    return false;
  proof.signal.throwIfAborted();
  const row = await getDeploymentControlRepository().getMeetingHistory(
    reservation.historyKey,
    proof.signal,
  );
  if (!matchesPreservedHistory(row, reservation, proof)) return false;
  return reconcileSettledReservation(owned, proof);
}
export async function reconcilePreservedTtsReservation(
  reservation: Extract<SessionReservation, { sessionMode: "tts_only" }>,
  proof: Pick<
    PreservedRecordingReleaseProof,
    "localWork" | "signal" | "deadline"
  > & {
    ancillarySettled: boolean;
  },
): Promise<boolean> {
  const owned = reservations.get(
    reservationKey(reservation.guildId, reservation.meetingId),
  );
  if (!owned || owned.reservation !== reservation || !proof.ancillarySettled)
    return false;
  await proof.localWork;
  if (
    owned.initializationUnresolved &&
    (await owned.initializationCleanup?.catch(() => false)) !== true
  )
    return false;
  proof.signal.throwIfAborted();
  return reconcileSettledReservation(owned, proof);
}
async function reconcileSettledReservation(
  owned: OwnedReservation,
  proof: Pick<PreservedRecordingReleaseProof, "signal" | "deadline">,
): Promise<boolean> {
  const { reservation } = owned;
  const key = reservationKey(reservation.guildId, reservation.meetingId);
  if (
    (await settleOwnedVoiceSession(reservation, {
      deadline: proof.deadline,
      signal: proof.signal,
    })) !== "settled"
  )
    return false;
  owned.releasing = true;
  if (owned.timer) clearInterval(owned.timer);
  await Promise.allSettled([owned.renewal, owned.release]);
  proof.signal.throwIfAborted();
  let lease = await getActiveMeetingLease(reservation.guildId, proof.signal);
  if (lease) {
    if (!samePreservedLease(lease, reservation)) return false;
    try {
      await releaseActiveMeetingLease(
        reservation.guildId,
        reservation.meetingId,
        reservation.ownerInstanceId,
        reservation,
        proof.signal,
      );
    } catch {
      proof.signal.throwIfAborted();
    }
    lease = await getActiveMeetingLease(reservation.guildId, proof.signal);
  }
  proof.signal.throwIfAborted();
  if (lease || Date.now() >= proof.deadline) return false;
  reservation.workHandle.settle();
  reservations.delete(key);
  pendingReservations.delete(key);
  return true;
}
function samePreservedLease(
  lease: ActiveMeetingLease,
  reservation: SessionReservation,
) {
  return (
    lease.meetingId === reservation.meetingId &&
    lease.ownerInstanceId === reservation.ownerInstanceId &&
    lease.executionVersion === reservation.executionVersion &&
    lease.voiceOperationAttemptId === reservation.voiceOperationAttemptId &&
    lease.sessionMode === reservation.sessionMode
  );
}

export async function unwindSessionInitialization(
  reservation: SessionReservation,
  cleanup?: Promise<boolean>,
): Promise<void> {
  const owned = reservations.get(
    reservationKey(reservation.guildId, reservation.meetingId),
  );
  if (!owned || owned.reservation !== reservation) return;
  owned.initializationCleanup =
    cleanup ?? owned.initializationCleanup ?? Promise.resolve(true);
  owned.initializationUnresolved = true;
  reservation.workHandle.transition("finalization");
  // Close external voice independently; an encoder or storage wait must not hold it open.
  const voice = settleOwnedVoiceSession(reservation).catch(
    () => "uncertain" as const,
  );
  const [historySettled, cleanupSettled] = await Promise.all([
    reconcileFailedInitialization(reservation),
    owned.initializationCleanup.catch(() => false),
  ]);
  await voice;
  if (!historySettled || !cleanupSettled) return;
  owned.initializationUnresolved = false;
  await releaseSessionReservation(reservation);
}

async function failInitializationHistory(
  reservation: Extract<SessionReservation, { sessionMode: "meeting" }>,
  expectedStatus: "starting" | "in_progress",
): Promise<boolean> {
  try {
    return (
      (await transitionMeetingHistory({
        key: reservation.historyKey,
        expectedMeetingId: reservation.meetingId,
        expectedOwnerInstanceId: reservation.ownerInstanceId,
        expectedExecutionVersion: reservation.executionVersion,
        expectedStatus,
        patch: {
          status: MEETING_STATUS.FAILED,
          updatedAt: new Date().toISOString(),
        },
      })) === "applied"
    );
  } catch {
    return false;
  }
}

async function reconcileFailedInitialization(
  reservation: SessionReservation,
): Promise<boolean> {
  if (reservation.sessionMode === "tts_only") return true;
  if (await failInitializationHistory(reservation, "starting")) return true;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const row = await getDeploymentControlRepository().getMeetingHistory(
        reservation.historyKey,
      );
      if (
        !row ||
        row.guildId !== reservation.guildId ||
        row.meetingId !== reservation.meetingId ||
        row.ownerInstanceId !== reservation.ownerInstanceId ||
        row.executionVersion !== reservation.executionVersion
      )
        return false;
      if (row.status === MEETING_STATUS.FAILED) return true;
      if (
        attempt > 0 ||
        (row.status !== MEETING_STATUS.STARTING &&
          row.status !== MEETING_STATUS.IN_PROGRESS)
      )
        return false;
      if (await failInitializationHistory(reservation, row.status)) return true;
    }
  } catch {
    return false;
  }
  return false;
}
/** H4/R3 compose these owned sessions with processing and delivery before installing the runtime safety handler. */
export function getOwnedSessionReservations(): ReadonlyArray<{
  reservation: SessionReservation;
  meeting?: MeetingData;
  initializationUnresolved?: boolean;
  initializationCleanup?: Promise<boolean>;
  renewal?: Promise<void>;
}> {
  return [...reservations.values()].map(
    ({
      reservation,
      meeting,
      initializationUnresolved,
      initializationCleanup,
      renewal,
    }) => ({
      reservation,
      meeting,
      initializationUnresolved,
      initializationCleanup,
      renewal,
    }),
  );
}
export async function stopReservationRenewals(): Promise<void> {
  const owned = [...reservations.values()];
  for (const entry of owned) clearInterval(entry.timer);
  await Promise.allSettled(
    owned.flatMap((entry) => [entry.renewal, entry.release]),
  );
}
export function getUncertainSessionAdmissions() {
  return [...uncertainAdmissions.values()];
}
export function fenceSessionReservations(): void {
  for (const owned of reservations.values()) owned.controller.abort();
}

export async function releaseMeetingLeaseForMeeting(
  meeting: MeetingData,
): Promise<boolean> {
  if (meeting.reservation)
    return releaseSessionReservation(meeting.reservation);
  stopMeetingLeaseHeartbeat(meeting);
  if (!meeting.leaseOwnerInstanceId) {
    return true;
  }
  return releaseActiveMeetingLease(
    meeting.guildId,
    meeting.meetingId,
    meeting.leaseOwnerInstanceId,
  );
}

export async function releaseMeetingLeaseByIdentifiers(
  guildId: string,
  meetingId: string,
  ownerInstanceId: string,
): Promise<boolean> {
  return releaseActiveMeetingLease(guildId, meetingId, ownerInstanceId);
}

export async function requestMeetingEndViaLease(
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

async function renewMeetingLeaseForMeeting(
  meeting: MeetingData,
): Promise<boolean> {
  if (!meeting.leaseOwnerInstanceId) {
    return false;
  }
  const nowMs = Date.now();
  const { updatedAt, leaseExpiresAt, expiresAt } = buildLeaseTimestamps(nowMs);
  return renewActiveMeetingLease(
    meeting.guildId,
    meeting.meetingId,
    meeting.leaseOwnerInstanceId,
    leaseExpiresAt,
    updatedAt,
    expiresAt,
    buildMeetingLeaseSnapshot(meeting),
  );
}

export function stopMeetingLeaseHeartbeat(meeting: MeetingData) {
  if (!meeting.leaseHeartbeatTimer) {
    return;
  }
  clearInterval(meeting.leaseHeartbeatTimer);
  meeting.leaseHeartbeatTimer = undefined;
}

function hasLeaseOwnership(
  lease: ActiveMeetingLease | undefined,
  meeting: MeetingData,
): lease is ActiveMeetingLease {
  return Boolean(
    lease &&
    lease.meetingId === meeting.meetingId &&
    lease.ownerInstanceId === meeting.leaseOwnerInstanceId,
  );
}

function shouldIgnoreLeaseOwnershipLoss(meeting: MeetingData): boolean {
  return meeting.finishing || meeting.finished || !meeting.onEndMeeting;
}

async function endMeetingFromLeaseOwnershipLoss(
  meeting: MeetingData,
): Promise<void> {
  const onEndMeeting = meeting.onEndMeeting;
  if (shouldIgnoreLeaseOwnershipLoss(meeting) || !onEndMeeting) {
    stopMeetingLeaseHeartbeat(meeting);
    return;
  }
  console.warn("Meeting lease ownership record changed, ending meeting", {
    guildId: meeting.guildId,
    meetingId: meeting.meetingId,
  });
  stopMeetingLeaseHeartbeat(meeting);
  meeting.endReason = MEETING_END_REASONS.UNKNOWN;
  await onEndMeeting(meeting);
}

function dispatchEndMeeting(meeting: MeetingData): void {
  // The finalizer owns its promise. A provider wait must never hold the renewal tick.
  void Promise.resolve()
    .then(async () => {
      if (meeting.isAutoRecording) {
        const { persistExplicitMeetingStop } =
          await import("../commands/endMeeting");
        await persistExplicitMeetingStop(meeting, meeting.endReason);
      }
      if (!meeting.finishing) await meeting.onEndMeeting?.(meeting);
    })
    .catch((error) => {
      console.error("Owned meeting finalization failed", {
        meetingId: meeting.meetingId,
        error,
      });
    });
}

function processRemoteEndRequest(
  lease: ActiveMeetingLease,
  meeting: MeetingData,
): boolean {
  const onEndMeeting = meeting.onEndMeeting;
  if (
    !lease.endRequestedAt ||
    !lease.endRequestedByUserId ||
    processedRemoteEndRequests.get(meeting) === lease.endRequestedAt ||
    meeting.finished ||
    !onEndMeeting
  ) {
    return false;
  }
  console.log("Processing remote end request for active meeting", {
    guildId: meeting.guildId,
    meetingId: meeting.meetingId,
    requestedBy: lease.endRequestedByUserId,
  });
  meeting.endReason = lease.endReason ?? MEETING_END_REASONS.WEB_UI;
  processedRemoteEndRequests.set(meeting, lease.endRequestedAt);
  meeting.endTriggeredByUserId = lease.endRequestedByUserId;
  dispatchEndMeeting(meeting);
  return true;
}

async function processLeaseRenewalOwnershipLoss(
  meeting: MeetingData,
): Promise<void> {
  const onEndMeeting = meeting.onEndMeeting;
  console.warn("Meeting lease renewal lost ownership, ending meeting", {
    guildId: meeting.guildId,
    meetingId: meeting.meetingId,
  });
  stopMeetingLeaseHeartbeat(meeting);
  if (shouldIgnoreLeaseOwnershipLoss(meeting) || !onEndMeeting) {
    return;
  }
  meeting.endReason = MEETING_END_REASONS.UNKNOWN;
  await onEndMeeting(meeting);
}

export function startMeetingLeaseHeartbeat(meeting: MeetingData) {
  stopMeetingLeaseHeartbeat(meeting);
  if (!meeting.leaseOwnerInstanceId) {
    return;
  }

  const tick = async () => {
    if (meeting.finished) {
      stopMeetingLeaseHeartbeat(meeting);
      return;
    }

    try {
      const lease = await getActiveMeetingLeaseForGuild(meeting.guildId);
      if (!hasLeaseOwnership(lease, meeting)) {
        await endMeetingFromLeaseOwnershipLoss(meeting);
        return;
      }

      processRemoteEndRequest(lease, meeting);

      const renewed = await renewMeetingLeaseForMeeting(meeting);
      if (renewed) {
        return;
      }
      await processLeaseRenewalOwnershipLoss(meeting);
    } catch (error) {
      console.error("Meeting lease renewal failed", {
        guildId: meeting.guildId,
        meetingId: meeting.meetingId,
        error,
      });
    }
  };

  let tickInProgress = false;

  const runTick = async () => {
    if (meeting.finished) {
      stopMeetingLeaseHeartbeat(meeting);
      return;
    }
    if (tickInProgress) {
      return;
    }
    tickInProgress = true;
    try {
      await tick();
    } finally {
      tickInProgress = false;
    }
  };

  meeting.leaseHeartbeatTimer = setInterval(() => {
    void runTick();
  }, ACTIVE_MEETING_HEARTBEAT_MS);
  meeting.leaseHeartbeatTimer.unref?.();
}
