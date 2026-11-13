import {
  destroyBot,
  isBotGatewayReady,
  setupBot,
  startEligibleBotWork,
} from "../bot";
import { getAllMeetings } from "../meetings";
import { setupWebServer } from "../webserver";
import { config } from "../services/configService";
import { verifyLangfusePrompts } from "../services/langfusePromptService";
import { LIFECYCLE } from "../services/lifecycleTiming";
import { setLocalFinishStarter } from "../services/meetingClose";
import {
  activeFinishCount,
  isFinishingLocally,
  runLocalFinish,
  startMeetingFinisher,
} from "../services/meetingFinisher";
import { latestLeaseCap } from "../services/meetingLease";
import {
  prepareMeetingUpdateDeliveryWorker,
  startMeetingUpdateDeliveryWorker,
  verifyMeetingUpdateDeliveryReadiness,
} from "../services/meetingUpdateDeliveryWorkerService";
import { startPersonalMediaUploadWorker } from "../services/personalMediaUploadWorkerService";
import { startProcessingRetryWorker } from "../services/processingRetryWorkerService";
import {
  startRenewalRecoveryWorker,
  verifyRenewalRecoveryReadiness,
} from "../services/renewalRecoveryWorkerService";
import {
  startRuntimeHealthServer,
  type RuntimeHealthServer,
} from "../services/runtimeHealthServer";
import { getWorkerIdentity } from "../services/runtimeInstanceService";
import { getShutdownSignal } from "../services/shutdownSignal";
import { getStripeClient } from "../services/stripeClient";
import {
  configureCaptureProtection,
  getProtectedUntil,
} from "../services/taskProtection";
import { startLocalSweep } from "../services/tempFileService";
import {
  flushTelemetry,
  runWorkerShutdown,
  type WorkerResources,
} from "../services/workerShutdown";
import {
  onFirstEligible,
  startWorkerRegistry,
} from "../services/workerRegistry";

export type WorkerMode = "all" | "bot" | "api";
export type StartedWorker = { stop(): Promise<void> };

// One worker per module instance; the scenario harness isolates modules to run several.
let server: RuntimeHealthServer | undefined;
let stopSweep: (() => void) | undefined;

/** What shutdown releases that only this composition root holds. Safe to use before start-up finishes. */
export const workerResources: WorkerResources = {
  closeServer: async () => {
    await server?.close();
  },
  destroyBot,
  stopLocalSweep: () => stopSweep?.(),
};

function captureCount(): number {
  return getAllMeetings().filter(
    (meeting) => meeting.sessionMode !== "tts_only",
  ).length;
}

function isLocallyLive(meetingId: string): boolean {
  return (
    getAllMeetings().some((meeting) => meeting.meetingId === meetingId) ||
    isFinishingLocally(meetingId)
  );
}

/** Each piece starts on its own, so one that throws cannot leave the others unstarted. */
function startPiece(name: string, start: () => void) {
  try {
    start();
  } catch (error) {
    console.error("Worker background job failed to start", {
      job: name,
      error,
    });
  }
}

/** Background work that only an eligible worker runs; each poller also checks eligibility on every tick. */
function startEligibleWork(mode: WorkerMode, runsBot: boolean) {
  startPiece("finisher", startMeetingFinisher);
  startPiece("update delivery", startMeetingUpdateDeliveryWorker);
  if (mode !== "bot") {
    startPiece("processing retry", startProcessingRetryWorker);
    startPiece("personal upload", startPersonalMediaUploadWorker);
    startPiece("renewal recovery", () => {
      const stripe = getStripeClient();
      if (stripe) startRenewalRecoveryWorker(stripe);
    });
  }
  if (runsBot) startPiece("bot", startEligibleBotWork);
}

async function verifyDependencies(mode: WorkerMode) {
  await verifyLangfusePrompts();
  await verifyMeetingUpdateDeliveryReadiness();
  await prepareMeetingUpdateDeliveryWorker();
  const stripe = mode !== "bot" ? getStripeClient() : null;
  if (stripe) await verifyRenewalRecoveryReadiness(stripe);
}

/**
 * The composition root for every mode. No signal handlers and no exit here:
 * `bootstrap.ts` owns those, so several workers can start in one process.
 */
export async function startWorker(options: {
  mode: WorkerMode;
}): Promise<StartedWorker> {
  const { mode } = options;
  const shutdown = getShutdownSignal();
  if (
    !config.runtime.ecs &&
    !config.mock.enabled &&
    !config.database.useLocalDynamoDB
  )
    throw new Error(
      "A worker outside ECS requires explicit mock or local DynamoDB storage",
    );
  console.log(`Mock mode: ${config.mock.enabled}`);
  await getWorkerIdentity();
  shutdown.throwIfAborted();
  configureCaptureProtection({ latestLeaseCap });
  setLocalFinishStarter(runLocalFinish);
  await verifyDependencies(mode);
  shutdown.throwIfAborted();
  if (config.runtime.ecs || mode !== "bot")
    server = await startRuntimeHealthServer(config.server.port);
  shutdown.throwIfAborted();
  if (mode !== "bot") await setupWebServer(server);
  shutdown.throwIfAborted();
  const runsBot = mode !== "api" && !config.mock.enabled;
  if (runsBot) await setupBot();
  shutdown.throwIfAborted();
  stopSweep = startLocalSweep(isLocallyLive);
  onFirstEligible(() => startEligibleWork(mode, runsBot));
  await startWorkerRegistry({
    mode,
    // REHEARSAL ONLY, never merge: on ECS this worker never reports ready, to
    // simulate a failed first deployment in Sandbox.
    isGatewayReady: () =>
      !process.env.ECS_CONTAINER_METADATA_URI_V4 &&
      (config.mock.enabled || isBotGatewayReady()),
    isServerListening: () => server?.server.listening ?? false,
    load: () => ({
      captures: captureCount(),
      finishing: activeFinishCount(),
      protectedUntil: getProtectedUntil(),
    }),
  });
  return {
    stop: async () => {
      await runWorkerShutdown(
        workerResources,
        Date.now() + LIFECYCLE.shutdownBudgetMs,
      );
      await flushTelemetry().catch((error: unknown) =>
        console.warn("Worker telemetry flush failed", error),
      );
    },
  };
}
