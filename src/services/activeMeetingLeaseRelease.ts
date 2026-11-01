import { releaseActiveMeetingLease } from "../db";
import type { SessionReservation } from "../types/deploymentControl";
import type { ReservationReleaseProof } from "./recordingReservationReleaseProof";

/** Retains the submitted delete until it actually settles, independently of the caller's budget. */
export async function releaseOriginalLease(
  owned: { reservation: SessionReservation; release?: Promise<boolean> },
  proof: Pick<ReservationReleaseProof, "signal" | "onReleaseSettled">,
): Promise<void> {
  const { reservation } = owned;
  proof.signal.throwIfAborted();
  let submitted = false;
  owned.release = Promise.resolve().then(() => {
    proof.signal.throwIfAborted();
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
    // Actual completion after the budget is new progress, even on rejection.
    if (submitted && proof.signal.aborted) proof.onReleaseSettled?.();
  }
}
