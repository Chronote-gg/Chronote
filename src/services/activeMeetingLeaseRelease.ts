import { releaseActiveMeetingLease } from "../db";
import type { SessionReservation } from "../types/deploymentControl";
import type { ReservationReleaseProof } from "./recordingReservationReleaseProof";

/** Retains the submitted delete until it actually settles, independently of the caller's budget. */
export async function releaseOriginalLease(
  owned: { reservation: SessionReservation; release?: Promise<boolean> },
  proof: Pick<
    ReservationReleaseProof,
    "signal" | "deadline" | "onReleaseSettled"
  >,
): Promise<void> {
  const { reservation } = owned;
  proof.signal.throwIfAborted();
  let submitted = false;
  owned.release = Promise.resolve().then(() => {
    proof.signal.throwIfAborted();
    if (Date.now() >= proof.deadline)
      throw new Error("Lease release deadline expired before dispatch");
    submitted = true;
    // Once sent, caller expiry must not cancel observation of the actual result.
    return releaseActiveMeetingLease(
      reservation.guildId,
      reservation.meetingId,
      reservation.ownerInstanceId,
      reservation,
    );
  });
  try {
    await owned.release;
  } catch {
    if (!submitted) owned.release = undefined;
    proof.signal.throwIfAborted();
  } finally {
    // Completion is progress even if the following verification outlives the budget.
    if (submitted) proof.onReleaseSettled?.();
  }
}
