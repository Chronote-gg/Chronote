import { LangfuseSpanProcessor } from "@langfuse/otel";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { isLangfuseTracingEnabled } from "../services/langfuseClient";
import { config } from "../services/configService";

let started = false;
let sdk: NodeSDK | undefined;
let processor: LangfuseSpanProcessor | undefined;
let shutdown: Promise<void> | undefined;

export function startLangfuseTracing() {
  if (started || !isLangfuseTracingEnabled()) {
    return;
  }

  processor = new LangfuseSpanProcessor({
    publicKey: config.langfuse.publicKey,
    secretKey: config.langfuse.secretKey,
    baseUrl: config.langfuse.baseUrl,
    environment: config.langfuse.tracingEnvironment || undefined,
    release: config.langfuse.release || undefined,
  });
  sdk = new NodeSDK({ spanProcessors: [processor] });
  sdk.start();
  started = true;
}

startLangfuseTracing();

export async function flushLangfuseTracing(): Promise<void> {
  await processor?.forceFlush();
}

export function shutdownLangfuseTracing(): Promise<void> {
  shutdown ??= Promise.resolve().then(() => sdk?.shutdown());
  return shutdown;
}
