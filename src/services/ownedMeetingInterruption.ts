import type { MeetingHistory } from "../types/db";
import type { ActiveMeetingLease } from "../types/db";
import { isDeepStrictEqual } from "node:util";
import type { RecoveryClaim } from "../types/meetingRecovery";
import { matchesRecoveredRecording } from "./recoveredRecordingProof";
import type { RecordingCaptureState } from "../types/recordingCheckpoint";
import type { MeetingData } from "../types/meeting-data";
import type { SessionReservation } from "../types/deploymentControl";
import type { RecordingCheckpoint } from "../types/recordingCheckpoint";
import { getActiveMeetingLease, getDeploymentControlRepository } from "../db";
import { closeOutputFile, waitForCaptureStreamSettlement } from "../audio";
import { fenceMeetingFinalization } from "../commands/endMeeting";
import {
  deleteMeeting,
  getMeeting,
  getPendingMeetingInitializations,
  restoreVoiceSessionNickname,
} from "../meetings";
import { fenceAndSettleSessionWork } from "./runtimeWorkAdmissionService";
import {
  stopMeetingProcessing,
  areMeetingNoticesSettled,
} from "./meetingProcessingLifetime";
import {
  settleOwnedVoiceSession,
  waitOwnedVoiceEffects,
  whenOwnedVoiceSettled,
} from "./guildVoiceOperationService";
import {
  reconcilePreservedRecordingReservation,
  reconcilePreservedTtsReservation,
  reconcileRecoveredRecordingReservation,
  getOwnedSessionReservations,
} from "./activeMeetingLeaseService";
import { createRecordingCheckpointService } from "./recordingCheckpointService";
import {
  createMeetingInterruptionService,
  type InterruptionReason,
} from "./meetingInterruptionService";
import type { PreservationBudget } from "./preservationBudget";

type RecordingReservation = Extract<
  SessionReservation,
  { sessionMode: "meeting" }
>;
type Stopped = {
  reservation?: SessionReservation;
  original?: SessionReservation;
  ancillarySettled: boolean;
  local: Promise<void>;
  voice: Promise<"settled" | "uncertain">;
  children: Promise<boolean>;
  recovered?: MeetingHistory;
  preserved?: Extract<Disposition, { kind: "preserved" }>;
  reconcile?: (budget: PreservationBudget) => Promise<boolean>;
};
type Disposition =
  | { kind: "unresolved" }
  | { kind: "preserved"; sessionMode: "tts_only" }
  | {
      sessionMode: "meeting";
      kind: "preserved";
      checkpoint: RecordingCheckpoint;
      status: "failed" | "interrupted" | "complete";
    };
const stopped = new WeakMap<MeetingData, Stopped>();
function stop(meeting: MeetingData, budget: PreservationBudget): Promise<void> {
  const reservation = meeting.reservation;
  const work: Stopped = {
    reservation,
    original: reservation
      ? reservation.sessionMode === "meeting"
        ? { ...reservation, historyKey: { ...reservation.historyKey } }
        : { ...reservation }
      : undefined,
    ancillarySettled:
      !meeting.finalization || meeting.finalization.disposition === "durable",
    local: Promise.resolve(),
    voice: Promise.resolve("uncertain"),
    children: Promise.resolve(false),
  };
  stopped.set(meeting, work);
  fenceMeetingFinalization(meeting);
  const processing = stopMeetingProcessing(meeting);
  work.children = reservation
    ? fenceAndSettleSessionWork(work.original!)
    : Promise.resolve(false);
  work.voice = reservation
    ? settleOwnedVoiceSession(reservation, {
        deadline: budget.deadline,
        signal: budget.signal,
      })
    : Promise.resolve("uncertain");
  work.local = Promise.allSettled([
    getPendingMeetingInitializations().find(
      (entry) =>
        entry.id === `${work.original?.guildId}:${work.original?.meetingId}`,
    )?.promise,
    processing,
    closeOutputFile(meeting),
    waitForCaptureStreamSettlement(meeting),
    meeting.recordingCapture?.settled(),
    work.voice,
    reservation ? waitOwnedVoiceEffects(reservation) : undefined,
    work.children,
  ]).then(() => {});
  const checkpoint = service
    .checkpoints()
    .find((entry) => entry.meeting === meeting);
  if (reservation)
    void whenOwnedVoiceSettled(reservation)
      .then(async () => {
        await checkpoint?.actual;
        await reconcileStoppedMeeting(meeting);
      })
      .catch(() => {});
  if (checkpoint)
    void checkpoint.actual.then((outcome) => {
      if (outcome.kind === "unresolved")
        void reconcileStoppedMeeting(meeting).catch(() => {});
    });
  return work.local;
}
async function assertOriginalLease(
  original: RecordingReservation,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const lease = await getActiveMeetingLease(original.guildId, signal);
  signal.throwIfAborted();
  if (
    !lease ||
    lease.meetingId !== original.meetingId ||
    lease.ownerInstanceId !== original.ownerInstanceId ||
    lease.executionVersion !== original.executionVersion ||
    lease.voiceOperationAttemptId !== original.voiceOperationAttemptId ||
    lease.sessionMode !== "meeting" ||
    lease.leaseExpiresAt < Math.floor(Date.now() / 1000)
  )
    throw new Error("Original recording lease cannot authorize preservation");
}
async function verifiedCaptureState(
  meeting: MeetingData,
  original: RecordingReservation,
  row: MeetingHistory,
  signal: AbortSignal,
): Promise<RecordingCaptureState> {
  const service = createRecordingCheckpointService();
  let captureState = meeting.recordingCaptureState ?? {
    kind: "unknown" as const,
  };
  if (row.checkpoint) {
    const capture = row.checkpoint.capture;
    if (
      capture.meetingId !== original.meetingId ||
      capture.guildId !== original.guildId ||
      capture.channelId_timestamp !== original.historyKey.channelId_timestamp ||
      capture.ownerInstanceId !== original.ownerInstanceId ||
      capture.executionVersion !== original.executionVersion
    )
      throw new Error("Original checkpoint could not be verified");
    const verified = await service.read(row.checkpoint, signal);
    if (verified.missing.length)
      throw new Error("Original checkpoint could not be verified");
    meeting.recordingCheckpoint = row.checkpoint;
    if (verified.manifest.captureState.kind === "complete")
      captureState = verified.manifest.captureState;
  }
  if (row.capture?.kind === "complete") captureState = row.capture;
  return captureState;
}
function matchesOriginalHistory(
  row: MeetingHistory | undefined,
  original: RecordingReservation,
): row is MeetingHistory {
  return Boolean(
    row &&
    row.meetingId === original.meetingId &&
    row.ownerInstanceId === original.ownerInstanceId &&
    row.executionVersion === original.executionVersion,
  );
}
function preservationInput(
  meeting: MeetingData,
  original: RecordingReservation,
  row: MeetingHistory,
  captureState: RecordingCaptureState,
  budget: PreservationBudget,
) {
  return {
    capture: {
      ...original.historyKey,
      meetingId: original.meetingId,
      channelId: meeting.voiceChannel.id,
      ownerInstanceId: original.ownerInstanceId,
      executionVersion: original.executionVersion,
      reservedAt: new Date(original.reservedAt).toISOString(),
      captureStartedAt: meeting.captureStartedAt?.toISOString() ?? null,
      requested: {
        transcribeMeeting: meeting.transcribeMeeting,
        generateNotes: meeting.generateNotes,
      },
    },
    captureState,
    previous: row.checkpoint,
    artifacts:
      meeting.recordingCapture?.pending().map(({ artifact }) => artifact) ?? [],
    recovery:
      row.recovery?.stage === "delivery"
        ? row.recovery
        : {
            disposition: "pending" as const,
            attempt: 0,
            executionVersion: original.executionVersion,
            stage: "verification" as const,
            retry: { maxAttempts: 3, nextAttemptAt: null },
          },
    preservation: {
      ownership: original,
      signal: budget.signal,
      deadlineEpochMs: budget.deadline,
      assertOwnership: (signal: AbortSignal) =>
        assertOriginalLease(original, signal),
    },
  };
}
function terminalPreservationStatus(
  status: MeetingHistory["status"],
  reason: InterruptionReason,
) {
  if (status === "failed" || status === "interrupted") return status;
  return reason === "shutdown" ? "interrupted" : "failed";
}
async function preserve(
  meeting: MeetingData,
  budget: PreservationBudget,
  reason: InterruptionReason,
): Promise<Disposition> {
  const work = stopped.get(meeting);
  if (!work?.original) return { kind: "unresolved" };
  const original = work.original;
  if (original.sessionMode === "tts_only")
    return stopped.get(meeting)!.ancillarySettled
      ? { kind: "preserved", sessionMode: "tts_only" }
      : { kind: "unresolved" };
  const row = await getDeploymentControlRepository().getMeetingHistory(
    original.historyKey,
    budget.signal,
  );
  budget.signal.throwIfAborted();
  if (!matchesOriginalHistory(row, original)) return { kind: "unresolved" };
  const service = createRecordingCheckpointService();
  const captureState = await verifiedCaptureState(
    meeting,
    original,
    row,
    budget.signal,
  );
  // Recheck current history/artifacts, then reuse acknowledged preservation without another write.
  if (work.preserved) return work.preserved;
  if (row.status === "complete")
    return row.checkpoint
      ? {
          kind: "preserved",
          sessionMode: "meeting",
          checkpoint: row.checkpoint,
          status: "complete",
        }
      : { kind: "unresolved" };
  if (
    !row.status ||
    ![
      "starting",
      "in_progress",
      "processing",
      "failed",
      "interrupted",
    ].includes(row.status)
  )
    return { kind: "unresolved" };
  const status = terminalPreservationStatus(row.status, reason);
  const input = preservationInput(meeting, original, row, captureState, budget);
  const result =
    row.status === "failed" || row.status === "interrupted"
      ? await service.preserveTerminalRecordingCheckpoint({
          ...input,
          expectedStatus: row.status,
        })
      : await service.preserveInitialTerminalRecordingCheckpoint({
          ...input,
          expectedStatus: row.status as
            "starting" | "in_progress" | "processing",
          status,
        });
  if (result.kind !== "committed") return { kind: "unresolved" };
  meeting.recordingCheckpoint = result.checkpoint;
  return {
    kind: "preserved",
    sessionMode: "meeting",
    checkpoint: result.checkpoint,
    status,
  };
}
async function release(
  meeting: MeetingData,
  disposition: Disposition,
  budget: PreservationBudget,
): Promise<boolean> {
  const work = stopped.get(meeting);
  if (
    disposition.kind !== "preserved" ||
    !work?.reservation ||
    !originalStillLocal(meeting, work) ||
    (await settleOwnedVoiceSession(work.reservation, {
      deadline: budget.deadline,
      signal: budget.signal,
    })) !== "settled" ||
    !(await localEffectsKnown(meeting, work))
  )
    return false;
  work.preserved ??= structuredClone(disposition);
  budget.signal.throwIfAborted();
  if (!(await restoreVoiceSessionNickname(meeting, budget.signal)))
    return false;
  budget.signal.throwIfAborted();
  const proof = {
    localWork: work.local,
    deadline: budget.deadline,
    signal: budget.signal,
    onReleaseSettled: () => {
      void reconcileStoppedMeeting(meeting).catch(() => {});
    },
  };
  const released =
    work.reservation.sessionMode === "tts_only" &&
    disposition.sessionMode === "tts_only"
      ? await reconcilePreservedTtsReservation(work.reservation, {
          ...proof,
          ancillarySettled: work.ancillarySettled,
        })
      : work.reservation.sessionMode === "meeting" &&
          disposition.sessionMode === "meeting"
        ? await reconcilePreservedRecordingReservation(work.reservation, {
            ...proof,
            checkpoint: disposition.checkpoint,
            status: disposition.status,
          })
        : false;
  if (!released) return false;
  finishOriginalMeeting(meeting);
  return true;
}
function finishOriginalMeeting(meeting: MeetingData) {
  meeting.recordingCapture?.releaseSettledBuffers();
  meeting.finished = true;
  meeting.setFinished();
  if (getMeeting(meeting.guildId) === meeting) deleteMeeting(meeting.guildId);
}
const service = createMeetingInterruptionService({ stop, preserve, release });
export const interruptOwnedMeeting = service.interrupt;
export const getMeetingInterruptionCheckpoints = service.checkpoints;

async function localEffectsKnown(meeting: MeetingData, work: Stopped) {
  return Boolean(
    work.reservation &&
    (await work.children) &&
    areMeetingNoticesSettled(meeting, work.reservation) &&
    !meeting.recordingLimitNotice?.deliveryUnknown &&
    meeting.recordingPreservationNotification?.outcome !== "unknown",
  );
}
function recoveredLocal(claim: RecoveryClaim) {
  const meeting = retainedMeetingFor(claim);
  const work = meeting && stopped.get(meeting);
  if (
    !meeting ||
    !work ||
    work.reservation?.sessionMode !== "meeting" ||
    work.original?.sessionMode !== "meeting" ||
    meeting.reservation !== work.reservation ||
    !isDeepStrictEqual(work.reservation, work.original) ||
    !retainsOriginal(meeting, work.reservation) ||
    claim.lease.meetingId !== work.original.meetingId ||
    claim.lease.ownerInstanceId !== work.original.ownerInstanceId ||
    claim.lease.executionVersion !== claim.history.executionVersion ||
    !matchesRecoveredRecording(work.original, claim.history)
  )
    return;
  return { meeting, work, reservation: work.reservation };
}
function retainedMeetingFor(claim: RecoveryClaim) {
  return getOwnedSessionReservations().find(
    ({ reservation }) =>
      reservation.guildId === claim.history.guildId &&
      reservation.meetingId === claim.history.meetingId,
  )?.meeting;
}
function retainsOriginal(
  meeting: MeetingData,
  reservation: SessionReservation,
) {
  const current = getMeeting(meeting.guildId);
  return (
    (!current || current === meeting) &&
    getOwnedSessionReservations().some(
      (entry) => entry.meeting === meeting && entry.reservation === reservation,
    )
  );
}
function sameRecoveryAuthority(
  lease: ActiveMeetingLease | undefined,
  claim: RecoveryClaim,
) {
  return (
    lease?.sessionMode === "recovery" &&
    lease.guildId === claim.lease.guildId &&
    lease.meetingId === claim.lease.meetingId &&
    lease.ownerInstanceId === claim.lease.ownerInstanceId &&
    lease.executionVersion === claim.lease.executionVersion &&
    lease.recoveryAttemptId === claim.lease.recoveryAttemptId
  );
}
/** Nickname mutation runs only while the recovery worker retains and renews its exact lease. */
export async function prepareRecoveredMeeting(
  claim: RecoveryClaim,
  signal: AbortSignal,
  effect: <T>(run: () => Promise<T>) => Promise<T>,
): Promise<void> {
  const local = recoveredLocal(claim);
  if (!local) return;
  const { meeting, work, reservation } = local;
  await service.reconcile(meeting, Date.now() + 30000, async (budget) => {
    const cleanupSignal = AbortSignal.any([signal, budget.signal]);
    cleanupSignal.throwIfAborted();
    if (!(await localEffectsKnown(meeting, work))) return false;
    const reader = createRecordingCheckpointService();
    const [verified, transcript] = await Promise.all([
      reader.read(claim.history.checkpoint!, cleanupSignal),
      claim.history.recoveryTranscript
        ? reader.readVerifiedObject(
            claim.history.recoveryTranscript.object,
            cleanupSignal,
          )
        : undefined,
    ]);
    if (
      verified.missing.length ||
      (claim.history.recoveryTranscript && !transcript)
    )
      return false;
    const repository = getDeploymentControlRepository();
    const [history, lease] = await Promise.all([
      repository.getMeetingHistory(reservation.historyKey, cleanupSignal),
      repository.getRecoveryLease(claim.history.guildId),
    ]);
    cleanupSignal.throwIfAborted();
    if (
      !isDeepStrictEqual(history, claim.history) ||
      !sameRecoveryAuthority(lease, claim) ||
      !retainsOriginal(meeting, reservation) ||
      claim.lease.leaseExpiresAt <= Math.floor(Date.now() / 1000)
    )
      return false;
    if (meeting.botNicknameChanged) {
      await effect(async () => {
        cleanupSignal.throwIfAborted();
        if (!(await restoreVoiceSessionNickname(meeting, cleanupSignal)))
          throw new Error("Recovery nickname cleanup unresolved");
      });
    }
    // Preparation alone never finishes the original reservation.
    return false;
  });
}
/** Read-only post-release proof, followed by exact original in-process cleanup. */
export async function reconcileRecoveredMeeting(
  claim: RecoveryClaim,
): Promise<void> {
  const local = recoveredLocal(claim);
  if (!local) return;
  const { meeting, work } = local;
  if (work.recovered && !isDeepStrictEqual(work.recovered, claim.history))
    return;
  work.recovered ??= structuredClone(claim.history);
  await reconcileStoppedMeeting(meeting);
}

function originalStillLocal(meeting: MeetingData, work: Stopped) {
  const current = getMeeting(meeting.guildId);
  return (
    meeting.reservation === work.reservation &&
    isDeepStrictEqual(work.reservation, work.original) &&
    (!current || current === meeting)
  );
}
async function reconcileStoppedMeeting(meeting: MeetingData): Promise<void> {
  const work = stopped.get(meeting);
  const checkpoint = service
    .checkpoints()
    .find((entry) => entry.meeting === meeting);
  if (!work?.reservation || !checkpoint) return;
  const reservation = work.reservation;
  work.reconcile ??= async (budget) => {
    if (!originalStillLocal(meeting, work)) return false;
    if (!work.recovered)
      return release(
        meeting,
        await preserve(meeting, budget, checkpoint.reason),
        budget,
      );
    if (
      reservation.sessionMode !== "meeting" ||
      !retainsOriginal(meeting, reservation) ||
      meeting.botNicknameChanged ||
      !(await localEffectsKnown(meeting, work)) ||
      (await settleOwnedVoiceSession(reservation, {
        deadline: budget.deadline,
        signal: budget.signal,
      })) !== "settled"
    )
      return false;
    const released = await reconcileRecoveredRecordingReservation(reservation, {
      history: work.recovered,
      localWork: work.local,
      signal: budget.signal,
      deadline: budget.deadline,
    });
    if (!released) return false;
    finishOriginalMeeting(meeting);
    return true;
  };
  const outcome = await service.reconcile(
    meeting,
    Date.now() + 30000,
    work.reconcile,
  );
  console.info("Owned meeting reconciliation", {
    phase: "late_cleanup",
    outcome: outcome.kind,
  });
}
