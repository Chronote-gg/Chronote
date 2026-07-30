import "dotenv/config";
import { LangfuseClient, type LangfuseClientParams } from "@langfuse/client";

import { DEFAULT_LANGFUSE_BASE_URL } from "../../src/services/langfuseDefaults";

function requireEnv(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`${name} is required.`);
  }
  return trimmed;
}

function resolveBaseUrl(): string {
  const baseUrl = process.env.LANGFUSE_BASE_URL?.trim();
  return baseUrl && baseUrl.length > 0 ? baseUrl : DEFAULT_LANGFUSE_BASE_URL;
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
    baseUrl: resolveBaseUrl(),
  };

  return new LangfuseClient(params);
}
