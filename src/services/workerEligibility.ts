import type {
  RegistryView,
  WorkerRecord,
} from "../repositories/workerRegistryRepository";
import { LIFECYCLE } from "./lifecycleTiming";

export type EligibilityReason =
  | "eligible"
  | "not_ready"
  | "shutting_down"
  | "newer_release"
  | "legacy_standby";

export type EligibilityDecision = {
  eligible: boolean;
  reason: EligibilityReason;
  writeCutover: boolean;
};

function refused(reason: EligibilityReason): EligibilityDecision {
  return { eligible: false, reason, writeCutover: false };
}

/** Undefined heartbeats before cutover mean the old state is unknown, which keeps standby rather than risking two protocols taking meetings. */
function legacyStillServing(
  legacyHeartbeats: number[] | undefined,
  now: number,
): boolean {
  if (!legacyHeartbeats) return true;
  const staleBefore = now - LIFECYCLE.legacyHeartbeatStaleSeconds;
  return legacyHeartbeats.some((heartbeatAt) => heartbeatAt > staleBefore);
}

/** A record whose heartbeat is older than this is a worker that may be gone. */
export function isFreshRecord(
  worker: Pick<WorkerRecord, "heartbeatAt">,
  now: number,
): boolean {
  return worker.heartbeatAt > now - LIFECYCLE.registryFreshSeconds;
}

function newerReleaseServing(
  self: Pick<WorkerRecord, "instanceId" | "release">,
  workers: WorkerRecord[],
  now: number,
): boolean {
  return workers.some(
    (worker) =>
      worker.instanceId !== self.instanceId &&
      worker.ready &&
      isFreshRecord(worker, now) &&
      worker.release > self.release,
  );
}

export function resolveEligibility(input: {
  self: Pick<WorkerRecord, "instanceId" | "release" | "ready">;
  shuttingDown: boolean;
  view: RegistryView;
  legacyHeartbeats: number[] | undefined;
  now: number;
}): EligibilityDecision {
  if (input.shuttingDown) return refused("shutting_down");
  if (!input.self.ready) return refused("not_ready");
  if (
    !input.view.cutover &&
    legacyStillServing(input.legacyHeartbeats, input.now)
  )
    return refused("legacy_standby");
  const writeCutover = !input.view.cutover;
  if (newerReleaseServing(input.self, input.view.workers, input.now))
    return { eligible: false, reason: "newer_release", writeCutover };
  return { eligible: true, reason: "eligible", writeCutover };
}
