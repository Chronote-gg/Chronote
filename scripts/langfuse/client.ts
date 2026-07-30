import "dotenv/config";
import { LangfuseClient, type LangfuseClientParams } from "@langfuse/client";

import { resolveLangfuseBaseUrl } from "../../src/services/langfuseDefaults";

function requireEnv(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`${name} is required.`);
  }
  return trimmed;
}

export function getLangfuseClient(): LangfuseClient {
  const publicKey = requireEnv(
    process.env.LANGFUSE_PUBLIC_KEY,
    "LANGFUSE_PUBLIC_KEY",
  );
  const secretKey = requireEnv(
    process.env.LANGFUSE_SECRET_KEY,
    "LANGFUSE_SECRET_KEY",
  );

  const params: LangfuseClientParams = {
    publicKey,
    secretKey,
    baseUrl: resolveLangfuseBaseUrl(process.env.LANGFUSE_BASE_URL),
  };

  return new LangfuseClient(params);
}
