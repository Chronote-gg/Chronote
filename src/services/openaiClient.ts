import OpenAI from "openai";
import { createHmac } from "node:crypto";
import { observeOpenAI } from "@langfuse/openai";
import type { SpanContext } from "@opentelemetry/api";
import { config } from "./configService";
import { isLangfuseTracingEnabled } from "./langfuseClient";
import type { LangfusePromptMeta } from "./langfusePromptService";

type LangfuseOpenAiOptions = {
  traceName?: string;
  generationName?: string;
  userId?: string;
  sessionId?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  langfusePrompt?: LangfusePromptMeta;
  parentSpanContext?: SpanContext;
  disableTracing?: boolean;
};

function buildBaseOpenAIClient() {
  return new OpenAI({
    apiKey: config.openai.apiKey,
    organization: config.openai.organizationId,
    project: config.openai.projectId,
  });
}

export const buildOpenAISafetyIdentifier = (userId?: string) => {
  const normalized = userId?.trim();
  if (!normalized) return undefined;
  return createHmac("sha256", config.server.sessionSecret)
    .update(`chronote:openai-safety:v1:${normalized}`)
    .digest("hex");
};

export function createOpenAIClient(
  options: LangfuseOpenAiOptions = {},
): OpenAI {
  const client = buildBaseOpenAIClient();
  if (options.disableTracing || !isLangfuseTracingEnabled()) {
    return client;
  }
  return observeOpenAI(client, {
    traceName: options.traceName,
    generationName: options.generationName,
    userId: options.userId,
    sessionId: options.sessionId,
    tags: options.tags,
    generationMetadata: options.metadata,
    langfusePrompt: options.langfusePrompt,
    parentSpanContext: options.parentSpanContext,
  });
}
