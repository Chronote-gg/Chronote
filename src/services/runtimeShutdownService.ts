import { stopMeetingUpdateDeliveryWorker } from "./meetingUpdateDeliveryWorkerService";
import { stopRenewalRecoveryWorker } from "./renewalRecoveryWorkerService";
import { stopMeetingRecoveryWorker } from "./meetingRecoveryWorkerService";
import { getAllMeetings, stopMeetingInitializations } from "../meetings";
import {
  getOwnedSessionReservations,
  stopReservationRenewals,
} from "./activeMeetingLeaseService";
import {
  interruptOwnedMeeting,
  getMeetingInterruptionCheckpoints,
} from "./ownedMeetingInterruption";
import {
  fenceRuntimeWorkAdmissions,
  getRuntimeWorkAdmissionCheckpoints,
  releaseAcknowledgedRuntimeWork,
} from "./runtimeWorkAdmissionService";
import {
  closeRuntimeAdmission,
  getRuntimeWorkCounts,
  shutdownRuntimeLifecycle,
} from "./runtimeLifecycleService";
import { stopMeetingControlCommandWorker } from "./meetingControlWorkerService";
import { stopPersonalMediaUploadWorker } from "./personalMediaUploadWorkerService";
import { shutdownAnalytics } from "./analyticsService";
import { shutdownSpeechDetector } from "./speechDetectionService";
import { shutdownLangfuseClient } from "./langfuseClient";
import { shutdownLangfuseTracing } from "../observability/langfuseInstrumentation";
import {
  createProcessShutdownOwner,
  type ProcessShutdownOwner,
} from "./processShutdownService";
import type { PreservationBudget } from "./preservationBudget";

async function settleClaims(): Promise<void> {
  const claims = getRuntimeWorkAdmissionCheckpoints();
  await Promise.allSettled(claims.map((claim) => claim.ownedPromise));
  for (const claim of claims) {
    let effects =
      getRuntimeWorkAdmissionCheckpoints().find(({ id }) => id === claim.id)
        ?.effects ?? [];
    while (effects.length) {
      await Promise.allSettled(effects);
      effects =
        getRuntimeWorkAdmissionCheckpoints().find(({ id }) => id === claim.id)
          ?.effects ?? [];
    }
    releaseAcknowledgedRuntimeWork(claim.id);
  }
}
function interruptSessions(budget: PreservationBudget) {
  const sessions = new Set(getAllMeetings());
  for (const { meeting } of getOwnedSessionReservations())
    if (meeting) sessions.add(meeting);
  for (const meeting of sessions)
    void interruptOwnedMeeting(meeting, {
      reason: "shutdown",
      deadline: budget.deadline,
    });
  return Promise.allSettled(
    getMeetingInterruptionCheckpoints().map(({ actual }) => actual),
  );
}
async function flushTelemetry() {
  const results = await Promise.allSettled([
    shutdownAnalytics(),
    shutdownSpeechDetector(),
    shutdownLangfuseClient(),
    shutdownLangfuseTracing(),
  ]);
  if (results.some((result) => result.status === "rejected"))
    throw new Error("Runtime telemetry shutdown remains unresolved");
}
let owner: ProcessShutdownOwner | undefined;
export function createRuntimeShutdown(resources: {
  stopBotAdmission(): void;
  closeServer(): Promise<void>;
  destroyBot(): Promise<void>;
}): ProcessShutdownOwner {
  if (owner) throw new Error("Runtime shutdown owner is already installed");
  owner = createProcessShutdownOwner({
    closeAdmission() {
      closeRuntimeAdmission();
      resources.stopBotAdmission();
    },
    async preserve(budget) {
      const initializations = stopMeetingInitializations();
      const controlPoll = stopMeetingControlCommandWorker();
      const personalPoll = stopPersonalMediaUploadWorker();
      const recoveryPoll = stopMeetingRecoveryWorker();
      const billingPoll = stopRenewalRecoveryWorker();
      const meetingUpdatePoll = stopMeetingUpdateDeliveryWorker();
      fenceRuntimeWorkAdmissions();
      const claims = settleClaims();
      const sessions = interruptSessions(budget);
      const server = resources.closeServer();
      const lifecycle = shutdownRuntimeLifecycle();
      const stopRenewals = () => {
        void stopReservationRenewals();
      };
      budget.signal.addEventListener("abort", stopRenewals, { once: true });
      try {
        const lifetimes = await Promise.allSettled([
          initializations,
          controlPoll,
          personalPoll,
          recoveryPoll,
          billingPoll,
          meetingUpdatePoll,
          claims,
          sessions,
          server,
          lifecycle,
        ]);
        // Initialization can finish allocating an owned session after shutdown has sealed admission.
        const interruptions = await interruptSessions(budget);
        await stopReservationRenewals();
        const transport = await Promise.allSettled([resources.destroyBot()]);
        return (
          lifetimes.every((result) => result.status === "fulfilled") &&
          interruptions.every(
            (result) =>
              result.status === "fulfilled" && result.value.kind === "settled",
          ) &&
          transport.every((result) => result.status === "fulfilled") &&
          Object.values(getRuntimeWorkCounts() ?? {}).every(
            (count) => count === 0,
          )
        );
      } finally {
        budget.signal.removeEventListener("abort", stopRenewals);
      }
    },
    flush: flushTelemetry,
    exit: (code) => process.exit(code),
  });
  owner.installSignalHandlers(process);
  return owner;
}
export function failRuntimeStartup(error: unknown): void {
  console.error("Runtime startup failed", error);
  if (!owner)
    throw new Error("Runtime startup must register shutdown ownership first", {
      cause: error,
    });
  void owner.request("startup_failure");
}
