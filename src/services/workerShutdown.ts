import type { EventEmitter } from "node:events";
import { stopMeetingInitializations } from "../meetings";
import { shutdownLangfuseTracing } from "../observability/langfuseInstrumentation";
import { shutdownAnalytics } from "./analyticsService";
import { shutdownLangfuseClient } from "./langfuseClient";
import { LIFECYCLE } from "./lifecycleTiming";
import { closeAllCaptures } from "./meetingClose";
import { stopMeetingControlCommandWorker } from "./meetingControlWorkerService";
import {
  releaseLocalFinishClaims,
  stopMeetingFinisher,
} from "./meetingFinisher";
import { stopMeetingUpdateDeliveryWorker } from "./meetingUpdateDeliveryWorkerService";
import { stopPersonalMediaUploadWorker } from "./personalMediaUploadWorkerService";
import {
  createProcessShutdownOwner,
  type ProcessShutdownOwner,
} from "./processShutdownService";
import { stopProcessingRetryWorker } from "./processingRetryWorkerService";
import {
  releaseRenewalRecoveryLease,
  stopRenewalRecoveryWorker,
} from "./renewalRecoveryWorkerService";
import { drainBillingOperations } from "./runtimeBillingOperationService";
import { beginShutdown } from "./shutdownSignal";
import { shutdownSpeechDetector } from "./speechDetectionService";
import { stopWorkerRegistry } from "./workerRegistry";

/** What only the composition root holds: its HTTP server, its Discord client and its local sweep. */
export type WorkerResources = {
  closeServer(): Promise<void>;
  destroyBot(): Promise<void>;
  stopLocalSweep(): void;
};

const TIMED_OUT = Symbol("timed out");

/** Settles within `boundMs`; a failure, a synchronous throw or a timeout is logged and reported as false. */
async function runStep(
  name: string,
  boundMs: number,
  run: (boundMs: number) => unknown,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      Promise.resolve().then(() => run(boundMs)),
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), Math.max(0, boundMs));
      }),
    ]);
    if (outcome !== TIMED_OUT) return true;
    console.warn("Worker shutdown step timed out", { step: name, boundMs });
    return false;
  } catch (error) {
    console.error("Worker shutdown step failed", { step: name, error });
    return false;
  } finally {
    clearTimeout(timer);
  }
}

type Step = { name: string; run: (boundMs: number) => unknown };
/** Steps in one stage run together, each guarded on its own; stages run in order. */
type Stage = { capMs: number; steps: Step[] };

/**
 * Worst case, with LIFECYCLE's values: 3 s registry, 3 s stops and starts,
 * then capture closing gets at least 85 - 6 - 14 = 65 s, then 8 s finish
 * claims, 3 s drain and 3 s server and bot; the telemetry flush and the exit
 * use the 5 s reserve, so everything ends within the 90 s budget.
 */
function stages(resources: WorkerResources): Stage[] {
  let uploads: Promise<void> = Promise.resolve();
  const step = LIFECYCLE.shutdownStepMs;
  return [
    // First and alone, so other workers and the deploy script stop counting this one at once.
    { capMs: step, steps: [{ name: "registry", run: stopWorkerRegistry }] },
    {
      capMs: step,
      steps: [
        // The upload job already stopped with the shutdown signal; its claim lapses and costs one attempt.
        {
          name: "uploads",
          run: () => {
            uploads = stopPersonalMediaUploadWorker();
          },
        },
        { name: "control", run: stopMeetingControlCommandWorker },
        { name: "processing retry", run: stopProcessingRetryWorker },
        { name: "update delivery", run: stopMeetingUpdateDeliveryWorker },
        { name: "renewal recovery", run: stopRenewalRecoveryWorker },
        // Its timer and any scan, so no claim is taken while captures close.
        { name: "finisher", run: stopMeetingFinisher },
        { name: "local sweep", run: () => resources.stopLocalSweep() },
        // A start in progress was aborted by the shutdown signal; this waits for it to release its lease.
        { name: "starts", run: stopMeetingInitializations },
      ],
    },
    {
      // No cap of its own: it gets whatever the capped stages leave.
      capMs: Number.POSITIVE_INFINITY,
      steps: [
        {
          name: "captures",
          run: (boundMs) =>
            closeAllCaptures({
              endReason: "unknown",
              abnormal: true,
              deadlineMs: Date.now() + boundMs,
            }),
        },
      ],
    },
    // After every close: attempts this process runs are aborted and their claims handed back uncounted.
    {
      capMs: LIFECYCLE.finishAbortWaitMs + step,
      steps: [{ name: "finish claims", run: releaseLocalFinishClaims }],
    },
    {
      capMs: step,
      steps: [
        {
          name: "billing",
          run: (boundMs) =>
            drainBillingOperations(AbortSignal.timeout(Math.max(1, boundMs))),
        },
        // The renewal poller has stopped, so the next eligible worker need not wait out the lease.
        { name: "renewal lease", run: releaseRenewalRecoveryLease },
        { name: "upload poll", run: () => uploads },
      ],
    },
    {
      capMs: step,
      steps: [
        { name: "server", run: () => resources.closeServer() },
        { name: "bot", run: () => resources.destroyBot() },
      ],
    },
  ];
}

/**
 * Each stage gets its cap, clamped so that every later capped stage keeps its
 * own cap before the deadline: a hung step can only take time from capture
 * closing, the one stage without a cap.
 */
async function shutdownSteps(
  resources: WorkerResources,
  deadlineMs: number,
): Promise<boolean> {
  beginShutdown();
  const plan = stages(resources);
  const outcomes: boolean[] = [];
  for (const [index, stage] of plan.entries()) {
    const reserved = plan
      .slice(index + 1)
      .filter((later) => Number.isFinite(later.capMs))
      .reduce((total, later) => total + later.capMs, 0);
    const boundMs = Math.min(stage.capMs, deadlineMs - Date.now() - reserved);
    outcomes.push(
      ...(await Promise.all(
        stage.steps.map((current) =>
          runStep(current.name, boundMs, current.run),
        ),
      )),
    );
  }
  return outcomes.every(Boolean);
}

let shutdown: Promise<boolean> | undefined;
/**
 * Stops this worker within `deadlineMs`: not ready first, then no new work,
 * then every capture saved as interrupted and every finish claim handed back.
 * The first call's promise is returned to every later caller.
 */
export function runWorkerShutdown(
  resources: WorkerResources,
  deadlineMs: number,
): Promise<boolean> {
  shutdown ??= shutdownSteps(resources, deadlineMs);
  return shutdown;
}

export async function flushTelemetry(): Promise<void> {
  const results = await Promise.allSettled([
    shutdownAnalytics(),
    shutdownSpeechDetector(),
    shutdownLangfuseClient(),
    shutdownLangfuseTracing(),
  ]);
  if (results.some((result) => result.status === "rejected"))
    throw new Error("Worker telemetry shutdown remains unresolved");
}

let owner: ProcessShutdownOwner | undefined;
export function installWorkerShutdown(
  resources: WorkerResources,
  signals: Pick<EventEmitter, "on" | "removeListener"> = process,
): ProcessShutdownOwner {
  if (owner) throw new Error("Worker shutdown is already installed");
  owner = createProcessShutdownOwner({
    closeAdmission: beginShutdown,
    // The reserve is left for the telemetry flush and the exit.
    preserve: (budget) =>
      runWorkerShutdown(
        resources,
        budget.deadline - LIFECYCLE.shutdownReserveMs,
      ),
    flush: flushTelemetry,
    exit: (code) => process.exit(code),
  });
  owner.installSignalHandlers(signals);
  return owner;
}

export function failWorkerStartup(error: unknown): void {
  console.error("Worker startup failed", error);
  if (!owner)
    throw new Error("Worker startup must install its shutdown first", {
      cause: error,
    });
  void owner.request("startup_failure");
}
