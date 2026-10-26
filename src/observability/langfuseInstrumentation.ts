import { LangfuseSpanProcessor } from "@langfuse/otel";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { isLangfuseTracingEnabled } from "../services/langfuseClient";

let started = false;
let sdk: NodeSDK | undefined;
let shutdown: Promise<void> | undefined;

function startLangfuseTracing() {
  if (started || !isLangfuseTracingEnabled()) {
    return;
  }

  sdk = new NodeSDK({
    spanProcessors: [new LangfuseSpanProcessor()],
  });
  sdk.start();
  started = true;
}

startLangfuseTracing();

export function shutdownLangfuseTracing(): Promise<void> {
  shutdown ??= Promise.resolve().then(() => sdk?.shutdown());
  return shutdown;
}
