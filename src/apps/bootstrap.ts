import "../observability/langfuseInstrumentation";
import "../voiceUdpGuard";
import "../ipv4first";
import { installWorkerShutdown } from "../services/workerShutdown";
import { startWorker, workerResources, type WorkerMode } from "./worker";

export type AppBootstrapMode = WorkerMode;

/** Installs the signal-driven shutdown first, so a SIGTERM during start-up still stops the worker in order. */
export async function bootstrapApp(mode: AppBootstrapMode): Promise<void> {
  const owner = installWorkerShutdown(workerResources);
  await owner.runStartup(() => startWorker({ mode }));
}
