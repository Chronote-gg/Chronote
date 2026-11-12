import type { VoiceConnection } from "@discordjs/voice";
import { v4 as uuidv4 } from "uuid";
import { MAXIMUM_MEETING_DURATION } from "../constants";
import {
  buildMeetingSession,
  disposeFailedInitialization,
  sessionCapturesAudio,
  sessionLeaseInput,
  type MeetingInitialization,
  type MeetingInitOptions,
} from "../meetings";
import { getMeetingHistoryTransitionRepository } from "../repositories/meetingHistoryTransitions";
import type { LeaseSnapshot } from "../repositories/meetingLeaseRepository";
import type { MeetingHistoryTransitionRepository } from "../repositories/meetingHistoryTransitions";
import type { ActiveMeetingLease, MeetingHistory } from "../types/db";
import type { MeetingData } from "../types/meeting-data";
import type { SessionReservation } from "../types/meetingHistoryTransition";
import {
  MEETING_END_REASONS,
  MEETING_STATUS,
  resolveMeetingStatus,
  type MeetingStatus,
} from "../types/meetingLifecycle";
import { dismissalCancellationReason } from "../utils/meetingLifecycle";
import { LIFECYCLE } from "./lifecycleTiming";
import {
  acquireSessionLease,
  latestLeaseCap,
  releaseSessionLease,
  startLeaseRenewal,
  type AcquireSessionLeaseInput,
  type MeetingLeaseService,
} from "./meetingLease";
import { writeMeetingUserIndexForMeetingService } from "./meetingUserIndexService";
import { operationSignal } from "./shutdownSignal";
import {
  releaseCaptureProtection,
  requestCaptureProtection,
} from "./taskProtection";
import { dropVoiceLocally, joinVoice, leaveVoice } from "./voiceSession";

const MS_PER_SECOND = 1000;
/** A failed start may already have written `in_progress`, so both are tried. */
const FAILABLE_STATUSES: readonly MeetingStatus[] = [
  MEETING_STATUS.STARTING,
  MEETING_STATUS.IN_PROGRESS,
];

export type CaptureEndEvent = {
  reservation: SessionReservation;
  /** Absent while the start is still building the meeting. */
  meeting?: MeetingData;
};
export type CaptureEndHandlers = {
  onLost(event: CaptureEndEvent): void;
  onCapReached(event: CaptureEndEvent): void;
};

export type MeetingStartDeps = {
  lease: Pick<
    MeetingLeaseService,
    | "acquireSessionLease"
    | "startLeaseRenewal"
    | "releaseSessionLease"
    | "latestLeaseCap"
  >;
  history: Pick<MeetingHistoryTransitionRepository, "transitionMeetingHistory">;
  requestCaptureProtection(): Promise<void>;
  releaseCaptureProtection(): void;
  joinVoice: typeof joinVoice;
  leaveVoice(connection: VoiceConnection): void;
  /** Without a voice state update, so a start that lost its lease cannot pull the new owner out. */
  dropVoiceLocally(connection: VoiceConnection): void;
  buildMeetingSession: typeof buildMeetingSession;
  disposeFailedSession(initialization: MeetingInitialization): Promise<boolean>;
  /** Defaults to `LIFECYCLE.startDeadlineMs` from now. */
  startDeadline(): AbortSignal;
  /** Read when the lease reports a loss or the cap, so later registration applies. */
  captureEndHandlers(): CaptureEndHandlers;
  /** Ends a live meeting the way a remote stop request always has. */
  endMeeting(meeting: MeetingData): void;
  /** Writes the My Meetings pointer, so a meeting that later fails is still listed. */
  indexMeeting(history: MeetingHistory): Promise<void>;
  nowMs(): number;
};

function leaseSnapshot(meeting: MeetingData | undefined): LeaseSnapshot {
  if (!meeting) return { status: MEETING_STATUS.STARTING };
  const status = resolveMeetingStatus(meeting);
  return {
    status,
    endReason: meeting.endReason,
    endTriggeredByUserId: meeting.endTriggeredByUserId,
    cancellationReason: meeting.cancellationReason,
    endedAt: meeting.endTime?.toISOString(),
  };
}

function admissionBlocked(reason: string): Error {
  // Logged here, as the old start does, so the voice-admission-blocked alarm counts it.
  const message = `Voice session admission blocked: ${reason}`;
  console.warn(message);
  return new Error(message);
}

function callerSignals(options: MeetingInitOptions): AbortSignal[] {
  return options.startSignal ? [options.startSignal] : [];
}

/** As close does: once the lease is gone a held piece could only time out into a failure notice. */
function retireStartedCapture(started: MeetingData | undefined) {
  if (started) {
    started.recordingCapture?.retire();
    started.recordingCapture = undefined;
  }
}

export function createMeetingStart(deps: MeetingStartDeps) {
  /** Only while status is starting or in_progress, so a later writer is never overwritten. */
  async function markFailed(reservation: SessionReservation): Promise<void> {
    if (reservation.sessionMode !== "meeting") return;
    for (const expectedStatus of FAILABLE_STATUSES) {
      try {
        const outcome = await deps.history.transitionMeetingHistory({
          key: reservation.historyKey,
          expectedMeetingId: reservation.meetingId,
          expectedOwnerInstanceId: reservation.ownerInstanceId,
          expectedExecutionVersion: reservation.executionVersion,
          expectedStatus,
          patch: {
            status: MEETING_STATUS.FAILED,
            updatedAt: new Date(deps.nowMs()).toISOString(),
          },
          // The start signal may be the reason for failing, so the write gets its own bound.
          signal: AbortSignal.timeout(LIFECYCLE.leaseHeartbeatMs),
        });
        if (outcome === "applied") return;
      } catch (error) {
        console.warn("Failed start could not write its failed status", {
          meetingId: reservation.meetingId,
          expectedStatus,
          error,
        });
      }
    }
    console.warn("Failed start left its history row unchanged", {
      meetingId: reservation.meetingId,
    });
  }

  async function release(reservation: SessionReservation, recording: boolean) {
    try {
      await deps.lease.releaseSessionLease(reservation);
    } catch (error) {
      console.warn("Failed start could not release its lease", {
        meetingId: reservation.meetingId,
        error,
      });
    }
    const otherLeaseLive =
      deps.lease.latestLeaseCap(Math.floor(deps.nowMs() / MS_PER_SECOND)) !==
      undefined;
    if (recording && !otherLeaseLive) deps.releaseCaptureProtection();
  }

  /** Written in the background, so a failed index write never fails the start. */
  function indexStartedMeeting(
    leaseInput: AcquireSessionLeaseInput,
    meeting: MeetingData,
    meetingId: string,
  ) {
    if (leaseInput.sessionMode === "meeting") {
      const history: MeetingHistory = {
        ...leaseInput.history,
        participants: [...meeting.participants.values()],
      };
      void deps.indexMeeting(history).catch((error: unknown) =>
        console.warn("Meeting start could not write the user index", {
          meetingId,
          error,
        }),
      );
    }
  }

  async function startMeetingSession(
    options: MeetingInitOptions,
  ): Promise<MeetingData> {
    const meetingId = options.meetingId ?? uuidv4();
    const recording = options.sessionMode !== "tts_only";
    // The deadline covers a start until it receives audio; shutdown and the caller's signal always apply.
    const deadline = deps.startDeadline();
    const untilReceiving = new AbortController();
    let receiving = false;
    deadline.addEventListener(
      "abort",
      () => {
        if (!receiving) untilReceiving.abort(deadline.reason);
      },
      { once: true },
    );
    const signal = operationSignal(
      untilReceiving.signal,
      ...callerSignals(options),
    );

    const leaseInput = sessionLeaseInput({ ...options, meetingId });
    const admission = await deps.lease.acquireSessionLease({
      ...leaseInput,
      signal,
    });
    if (admission.kind === "blocked") throw admissionBlocked(admission.reason);
    const { reservation } = admission;
    const ownership = new AbortController();

    let meeting: MeetingData | undefined;
    let pendingEndRequest: ActiveMeetingLease | undefined;
    const endRequested = (lease: ActiveMeetingLease) => {
      if (!lease.endRequestedByUserId) return;
      if (!meeting) {
        pendingEndRequest = lease;
        return;
      }
      if (meeting.finished || !meeting.onEndMeeting) return;
      console.log("Processing remote end request for active meeting", {
        guildId: meeting.guildId,
        meetingId: meeting.meetingId,
        requestedBy: lease.endRequestedByUserId,
      });
      meeting.endReason = lease.endReason ?? MEETING_END_REASONS.WEB_UI;
      meeting.endTriggeredByUserId = lease.endRequestedByUserId;
      // A Stop recording pressed during the start cancels it as the live dismissal handler does.
      if (
        meeting.endReason === MEETING_END_REASONS.DISMISSED &&
        meeting.isAutoRecording
      ) {
        meeting.cancelled = true;
        meeting.cancellationReason = dismissalCancellationReason(
          lease.endRequestedByUserId,
        );
      }
      deps.endMeeting(meeting);
    };
    const event = (): CaptureEndEvent => ({ reservation, meeting });

    const initialization: MeetingInitialization = { cleanup: [] };
    let connection: VoiceConnection | undefined;
    try {
      deps.lease.startLeaseRenewal(reservation, {
        maxDurationMs: options.maxMeetingDurationMs ?? MAXIMUM_MEETING_DURATION,
        snapshot: () => leaseSnapshot(meeting),
        onEndRequested: endRequested,
        onLost: () => {
          // Stops piece writes at once; only a lost lease aborts it, never a normal close.
          ownership.abort(new Error("Meeting lease lost to another meeting"));
          deps.captureEndHandlers().onLost(event());
        },
        onCapReached: () => deps.captureEndHandlers().onCapReached(event()),
      });
      if (recording) await deps.requestCaptureProtection();
      // A join sent after the deadline would only be followed by an immediate leave.
      signal.throwIfAborted();
      // The server's one voice state belongs to the meeting that took the lease.
      ownership.signal.throwIfAborted();
      connection = await deps.joinVoice({
        voiceChannel: options.voiceChannel,
        guild: options.guild,
        captureAudio: sessionCapturesAudio(options),
        signal,
      });
      meeting = await deps.buildMeetingSession(
        { ...options, meetingId },
        reservation,
        connection,
        signal,
        {
          initialization,
          ownershipSignal: ownership.signal,
          onReceiving: () => {
            receiving = true;
          },
        },
      );
      meeting.abortOwnership = (reason) => ownership.abort(reason);
      if (reservation.sessionMode === "meeting") {
        const outcome = await deps.history.transitionMeetingHistory({
          key: reservation.historyKey,
          expectedMeetingId: reservation.meetingId,
          expectedOwnerInstanceId: reservation.ownerInstanceId,
          expectedExecutionVersion: reservation.executionVersion,
          expectedStatus: MEETING_STATUS.STARTING,
          patch: {
            status: MEETING_STATUS.IN_PROGRESS,
            updatedAt: new Date(deps.nowMs()).toISOString(),
          },
          signal,
        });
        if (outcome !== "applied")
          throw new Error("Meeting start lost its history row");
      }
    } catch (error) {
      // Leave first: disposing can take seconds, and the bot should not linger in voice meanwhile.
      if (connection)
        (ownership.signal.aborted ? deps.dropVoiceLocally : deps.leaveVoice)(
          connection,
        );
      const settled = await deps
        .disposeFailedSession(initialization)
        .catch(() => false);
      if (!settled)
        console.warn("Failed start left meeting resources unsettled", {
          meetingId,
        });
      await markFailed(reservation);
      retireStartedCapture(meeting ?? initialization.meeting);
      await release(reservation, recording);
      throw error;
    }
    indexStartedMeeting(leaseInput, meeting, meetingId);
    if (pendingEndRequest) endRequested(pendingEndRequest);
    return meeting;
  }

  return { startMeetingSession };
}

const logOnly: CaptureEndHandlers = {
  onLost: ({ reservation }) =>
    console.warn("Capture lease lost before a close handler was registered", {
      meetingId: reservation.meetingId,
    }),
  onCapReached: ({ reservation }) =>
    console.warn(
      "Capture lease cap reached before a close handler was registered",
      {
        meetingId: reservation.meetingId,
      },
    ),
};
let captureEndHandlers: CaptureEndHandlers = logOnly;

/** Wires lease loss and the lease cap to closing the capture. Called once at start-up. */
export function setCaptureEndHandlers(handlers: CaptureEndHandlers): void {
  captureEndHandlers = handlers;
}

/** Runs outside the renewal tick, so the end flow never holds it. */
function dispatchEndMeeting(meeting: MeetingData): void {
  void Promise.resolve()
    .then(async () => {
      if (!meeting.finishing) await meeting.onEndMeeting?.(meeting);
    })
    .catch((error) => {
      console.error("Remote meeting stop failed", {
        meetingId: meeting.meetingId,
        error,
      });
    });
}

let processStart: ReturnType<typeof createMeetingStart> | undefined;
function start() {
  processStart ??= createMeetingStart({
    lease: {
      acquireSessionLease,
      startLeaseRenewal,
      releaseSessionLease,
      latestLeaseCap,
    },
    history: getMeetingHistoryTransitionRepository(),
    requestCaptureProtection,
    releaseCaptureProtection,
    joinVoice,
    leaveVoice,
    dropVoiceLocally,
    buildMeetingSession,
    disposeFailedSession: disposeFailedInitialization,
    startDeadline: () => AbortSignal.timeout(LIFECYCLE.startDeadlineMs),
    captureEndHandlers: () => captureEndHandlers,
    endMeeting: dispatchEndMeeting,
    indexMeeting: writeMeetingUserIndexForMeetingService,
    nowMs: Date.now,
  });
  return processStart;
}

/**
 * Takes the server's lease, joins voice and builds the live meeting. A blocked
 * admission throws without touching voice; any later failure leaves voice,
 * marks the row failed, releases the lease and rethrows.
 */
export function startMeetingSession(
  options: MeetingInitOptions,
): Promise<MeetingData> {
  return start().startMeetingSession(options);
}
