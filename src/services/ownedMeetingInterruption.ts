import type { MeetingHistory } from "../types/db";
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
} from "./guildVoiceOperationService";
import {
  reconcilePreservedRecordingReservation,
  reconcilePreservedTtsReservation,
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
    processing,
    closeOutputFile(meeting),
    waitForCaptureStreamSettlement(meeting),
    meeting.recordingCapture?.settled(),
    work.voice,
    reservation ? waitOwnedVoiceEffects(reservation) : undefined,
    work.children,
  ]).then(() => {});
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
  const original = stopped.get(meeting)?.original;
  if (!original) return { kind: "unresolved" };
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
    (await work.voice) !== "settled" ||
    !(await work.children)
  )
    return false;
  if (
    !areMeetingNoticesSettled(meeting, work.reservation) ||
    meeting.recordingLimitNotice?.deliveryUnknown ||
    meeting.recordingPreservationNotification?.outcome === "unknown"
  )
    return false;
  budget.signal.throwIfAborted();
  if (!(await restoreVoiceSessionNickname(meeting, budget.signal)))
    return false;
  budget.signal.throwIfAborted();
  const proof = {
    localWork: work.local,
    deadline: budget.deadline,
    signal: budget.signal,
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
  meeting.recordingCapture?.releaseSettledBuffers();
  meeting.finished = true;
  meeting.setFinished();
  if (getMeeting(meeting.guildId) === meeting) deleteMeeting(meeting.guildId);
  return true;
}
const service = createMeetingInterruptionService({ stop, preserve, release });
export const interruptOwnedMeeting = service.interrupt;
export const getMeetingInterruptionCheckpoints = service.checkpoints;
