import "../observability/langfuseInstrumentation";
import "../voiceUdpGuard";
import "../ipv4first";
import {
  setupBot,
  isBotGatewayReady,
  stopBotAdmission,
  destroyBot,
} from "../bot";
import { setupWebServer } from "../webserver";
import { config } from "../services/configService";
import { verifyLangfusePrompts } from "../services/langfusePromptService";
import { cleanupTempBaseDir } from "../services/tempFileService";
import { initializeRuntimeLifecycle } from "../services/runtimeStartupService";
import {
  startRuntimeHealthServer,
  type RuntimeHealthServer,
} from "../services/runtimeHealthServer";
import { getStripeClient } from "../services/stripeClient";
import {
  startRenewalRecoveryWorker,
  verifyRenewalRecoveryReadiness,
} from "../services/renewalRecoveryWorkerService";
import { createRuntimeShutdown } from "../services/runtimeShutdownService";

export type AppBootstrapMode = "all" | "bot" | "api";

export function bootstrapApp(mode: AppBootstrapMode): Promise<void> {
  let healthServer: RuntimeHealthServer | undefined;
  const owner = createRuntimeShutdown({
    stopBotAdmission,
    destroyBot,
    closeServer: async () => {
      await healthServer?.close();
    },
  });
  return owner.runStartup(async () => {
    console.log(`Mock mode: ${config.mock.enabled}`);
    let runtime:
      Awaited<ReturnType<typeof initializeRuntimeLifecycle>> | undefined;
    try {
      if (config.runtime.ecs || mode !== "bot")
        healthServer = await startRuntimeHealthServer(config.server.port);
      owner.startupSignal.throwIfAborted();
      runtime = await initializeRuntimeLifecycle(
        () => mode !== "api" && (config.mock.enabled || isBotGatewayReady()),
        mode,
        owner.startupSignal,
        async () => {
          void owner.request("protection_loss");
        },
      );
      owner.startupSignal.throwIfAborted();
      await verifyLangfusePrompts();
      owner.startupSignal.throwIfAborted();
      await cleanupTempBaseDir();
      owner.startupSignal.throwIfAborted();
      if (mode !== "api" && !config.mock.enabled) await setupBot();
      owner.startupSignal.throwIfAborted();
      if (mode !== "bot") await setupWebServer(healthServer);
      owner.startupSignal.throwIfAborted();
      const stripe = mode !== "bot" ? getStripeClient() : null;
      if (stripe) await verifyRenewalRecoveryReadiness(stripe);
      await runtime.ready();
      if (stripe) startRenewalRecoveryWorker(stripe);
    } catch (error) {
      void owner.request("startup_failure");
      runtime?.failed();
      await healthServer?.close();
      throw error;
    }
  });
}
