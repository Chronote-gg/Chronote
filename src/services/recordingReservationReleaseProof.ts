import type { ActiveMeetingLease } from "../types/db";
import { isDeepStrictEqual } from "node:util";
import type { RecordingCheckpoint } from "../types/recordingCheckpoint";
import type { SessionReservation } from "../types/deploymentControl";
import type { getDeploymentControlRepository } from "../db";
export type PreservedRecordingReleaseProof = {
  checkpoint: RecordingCheckpoint;
  status: "complete" | "failed" | "interrupted";
  localWork: Promise<void>;
  signal: AbortSignal;
  deadline: number;
};
export function matchesPreservedHistory(
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
export function samePreservedLease(
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
