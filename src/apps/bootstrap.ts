import "../observability/langfuseInstrumentation";
import "../voiceUdpGuard";
import "../ipv4first";
import { setupBot } from "../bot";
import { setupWebServer } from "../webserver";
import { config } from "../services/configService";
import { verifyLangfusePrompts } from "../services/langfusePromptService";
import { cleanupTempBaseDir } from "../services/tempFileService";

export type AppBootstrapMode = "all" | "bot" | "api";

export async function bootstrapApp(mode: AppBootstrapMode) {
  console.log(`Mock mode: ${config.mock.enabled}`);
  await verifyLangfusePrompts();
  await cleanupTempBaseDir();

  if (mode !== "api" && !config.mock.enabled) {
    setupBot();
  }

  if (mode !== "bot") {
    setupWebServer();
  }
}
