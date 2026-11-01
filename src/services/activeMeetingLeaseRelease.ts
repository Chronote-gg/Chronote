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
  owned.release = Promise.resolve().then(() =>
    releaseActiveMeetingLease(
      reservation.guildId,
      reservation.meetingId,
      reservation.ownerInstanceId,
      reservation,
      proof.signal,
    ),
  );
  try {
    await owned.release;
  } catch {
    proof.signal.throwIfAborted();
  } finally {
    // Actual completion after the budget is new progress, even on rejection.
    if (proof.signal.aborted) proof.onReleaseSettled?.();
  }
}
