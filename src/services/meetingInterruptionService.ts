import type { MeetingData } from "../types/meeting-data";
import {
  createPreservationBudget,
  type PreservationBudget,
} from "./preservationBudget";
export type InterruptionReason =
  "shutdown" | "processing_failure" | "capture_failure";
export type InterruptionOptions = {
  reason: InterruptionReason;
  deadline: number;
};
export type InterruptionOutcome = { kind: "settled" } | { kind: "unresolved" };
type Disposition = { kind: "preserved" | "unresolved" };
type Dependencies<D extends Disposition> = {
  stop(meeting: MeetingData, budget: PreservationBudget): Promise<void>;
  preserve(
    meeting: MeetingData,
    budget: PreservationBudget,
    reason: InterruptionReason,
  ): Promise<D>;
  release(
    meeting: MeetingData,
    disposition: D,
    budget: PreservationBudget,
  ): Promise<boolean>;
};
/** Per-session owner. Deadline expiry returns uncertainty without detaching the actual work. */
export function createMeetingInterruptionService<D extends Disposition>(
  dependencies: Dependencies<D>,
) {
  const active = new Set<MeetingData>();
  const owned = new WeakMap<
    MeetingData,
    {
      budget: PreservationBudget;
      actual: Promise<InterruptionOutcome>;
      result: Promise<InterruptionOutcome>;
      localSettled: boolean;
      reconciled?: boolean;
      reconciliation?: Promise<InterruptionOutcome>;
      reason: InterruptionReason;
      originalAttempt?: {
        guildId: string;
        meetingId: string;
        ownerInstanceId: string;
        executionVersion: number;
        voiceOperationAttemptId: string;
      };
    }
  >();
  function interrupt(
    meeting: MeetingData,
    options: InterruptionOptions,
  ): Promise<InterruptionOutcome> {
    const existing = owned.get(meeting);
    if (existing) {
      existing.budget.shorten(options.deadline);
      return existing.result;
    }
    const budget = createPreservationBudget(options.deadline);
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const local = new Promise<void>((done, failed) => {
      resolve = done;
      reject = failed;
    });
    const actual = (async (): Promise<InterruptionOutcome> => {
      try {
        await local;
        // These are independent owners, and can be installed by a synchronous capture failure callback.
        await Promise.allSettled([
          meeting.recordingContentTask,
          meeting.recordingPreservationTask,
          meeting.recordingPreservationNotification?.promise,
          meeting.finalization?.promise,
        ]);
        owned.get(meeting)!.localSettled = true;
        budget.signal.throwIfAborted();
        const disposition = await dependencies.preserve(
          meeting,
          budget,
          options.reason,
        );
        budget.signal.throwIfAborted();
        if (disposition.kind !== "preserved") return { kind: "unresolved" };
        return (await dependencies.release(meeting, disposition, budget))
          ? { kind: "settled" }
          : { kind: "unresolved" };
      } catch {
        return { kind: "unresolved" };
      }
    })();
    const result = budget
      .wait(actual)
      .then((outcome): InterruptionOutcome =>
        outcome.kind === "settled" ? outcome.value : { kind: "unresolved" },
      );
    const reservation = meeting.reservation;
    const originalAttempt = reservation
      ? {
          guildId: reservation.guildId,
          meetingId: reservation.meetingId,
          ownerInstanceId: reservation.ownerInstanceId,
          executionVersion: reservation.executionVersion,
          voiceOperationAttemptId: reservation.voiceOperationAttemptId,
        }
      : undefined;
    owned.set(meeting, {
      budget,
      actual,
      result,
      localSettled: false,
      reason: options.reason,
      originalAttempt,
    });
    active.add(meeting);
    void actual.then((outcome) => {
      budget.dispose();
      if (outcome.kind === "settled") active.delete(meeting);
    });
    try {
      void dependencies.stop(meeting, budget).then(resolve, reject);
    } catch (error) {
      reject(error);
    }
    return result;
  }
  function reconcile(
    meeting: MeetingData,
    deadline: number,
    run: (budget: PreservationBudget) => Promise<boolean>,
  ): Promise<InterruptionOutcome> {
    const entry = owned.get(meeting);
    if (!entry) return Promise.resolve({ kind: "unresolved" });
    if (entry.reconciled || !active.has(meeting))
      return Promise.resolve({ kind: "settled" });
    if (entry.reconciliation) return entry.reconciliation;
    const budget = createPreservationBudget(deadline);
    const actual = (async (): Promise<InterruptionOutcome> => {
      try {
        if ((await budget.wait(entry.actual)).kind !== "settled")
          return { kind: "unresolved" };
        budget.signal.throwIfAborted();
        if (!entry.localSettled || !(await run(budget)))
          return { kind: "unresolved" };
        budget.signal.throwIfAborted();
        entry.reconciled = true;
        active.delete(meeting);
        return { kind: "settled" };
      } catch {
        return { kind: "unresolved" };
      }
    })();
    // Once run starts, retain its actual lifetime, including any submitted cleanup effect.
    const result = actual;
    entry.reconciliation = result;
    void actual.then(() => {
      budget.dispose();
      entry.reconciliation = undefined;
    });
    return result;
  }
  return {
    interrupt,
    reconcile,
    checkpoints: () =>
      [...active].map((meeting) => {
        const entry = owned.get(meeting)!;
        return {
          meeting,
          actual: entry.actual,
          result: entry.result,
          localSettled: entry.localSettled,
          deadline: entry.budget.deadline,
          signal: entry.budget.signal,
          reason: entry.reason,
          originalAttempt: entry.originalAttempt,
          lastAcknowledgedCheckpoint: meeting.recordingCheckpoint,
        };
      }),
  };
}
