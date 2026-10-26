import type OpenAI from "openai";
import type { ModelParamRole } from "../config/types";
import type {
  Response,
  ResponseCreateParamsNonStreaming,
  ResponseInputItem,
} from "openai/resources/responses/responses";
import { toResponseInputItems } from "openai/lib/responses/ResponseInputItems";
import type { SavedRecordingSettings } from "../types/recordingContent";
import { createOpenAIClient } from "./openaiClient";
import { buildOpenAIPromptCacheParams } from "./openaiPromptCache";

export const MEETING_TEXT_MAX_REQUESTS = 3;

export class EmptyOpenAITextOutputError extends Error {
  constructor() {
    super("OpenAI Responses output empty.");
    this.name = "EmptyOpenAITextOutputError";
  }
}

export type OpenAITextFormat =
  | { kind: "text" }
  | { kind: "json_object" }
  | { kind: "json_schema"; name: string; schema: Record<string, unknown> };

type TextGenerationOptions = {
  model: string;
  modelParamRole?: ModelParamRole;
  input: readonly ResponseInputItem[];
  modelParams: SavedRecordingSettings["models"]["notes"]["params"];
  format?: OpenAITextFormat;
  maxOutputTokens?: number;
  continuation?: { maxRequests: number };
  signal?: AbortSignal;
  safetyIdentifier?: string;
  tracing?: NonNullable<Parameters<typeof createOpenAIClient>[0]>;
};

type TextRequest = TextGenerationOptions & {
  format: OpenAITextFormat;
  client: OpenAI;
  promptCacheParams: Pick<
    ResponseCreateParamsNonStreaming,
    "prompt_cache_options"
  >;
};

function responseText(
  request: TextRequest,
): ResponseCreateParamsNonStreaming["text"] {
  const format = request.format;
  const verbosity = request.modelParams.verbosity;
  if (format.kind === "text") return verbosity ? { verbosity } : undefined;
  const outputFormat =
    format.kind === "json_object"
      ? { type: "json_object" as const }
      : {
          type: "json_schema" as const,
          name: format.name,
          schema: format.schema,
          strict: true,
        };
  return { format: outputFormat, ...(verbosity ? { verbosity } : {}) };
}

function assertResponseOutput(response: Response, previousText: string): void {
  const refused = response.output.some(
    (item) =>
      item.type === "message" &&
      item.content.some((part) => part.type === "refusal"),
  );
  if (refused) throw new Error("OpenAI Responses generation refused.");
  if (previousText && response.output_text === previousText) {
    throw new Error("OpenAI Responses continuation made no progress.");
  }
  if (response.status === "completed" && !response.output_text.trim()) {
    throw new EmptyOpenAITextOutputError();
  }
}

function canContinue(response: Response, format: OpenAITextFormat): boolean {
  return (
    response.status === "incomplete" &&
    response.incomplete_details?.reason === "max_output_tokens" &&
    format.kind === "text" &&
    Boolean(response.output_text.trim())
  );
}

async function generateResponsesText(request: TextRequest): Promise<string> {
  const input = [...request.input];
  const maxRequests = request.continuation?.maxRequests ?? 1;
  let output = "";
  let previousText = "";
  for (let attempt = 0; attempt < maxRequests; attempt += 1) {
    request.signal?.throwIfAborted();
    const response = await request.client.responses.create(
      {
        model: request.model,
        input,
        store: false,
        include: ["reasoning.encrypted_content"],
        reasoning: request.modelParams.reasoning_effort
          ? { effort: request.modelParams.reasoning_effort }
          : undefined,
        temperature: request.modelParams.temperature,
        text: responseText(request),
        max_output_tokens: request.maxOutputTokens,
        safety_identifier: request.safetyIdentifier,
        ...request.promptCacheParams,
      },
      request.signal ? { signal: request.signal } : undefined,
    );
    request.signal?.throwIfAborted();
    assertResponseOutput(response, previousText);
    const text = response.output_text;
    if (response.status === "completed") return output + text;
    if (!canContinue(response, request.format)) {
      throw new Error("OpenAI Responses generation incomplete or failed.");
    }
    output += text;
    previousText = text;
    input.push(...toResponseInputItems(response.output), {
      role: "user",
      content:
        "Continue exactly where the previous output stopped. Do not repeat earlier text.",
    });
  }
  throw new Error("OpenAI Responses request limit exhausted.");
}

export async function generateOpenAIText(
  options: TextGenerationOptions,
): Promise<string> {
  options.signal?.throwIfAborted();
  const format: OpenAITextFormat = options.format ?? { kind: "text" };
  const promptCacheParams = buildOpenAIPromptCacheParams({
    model: options.model,
    modelParamRole: options.modelParamRole,
  });
  const promptCache = promptCacheParams.prompt_cache_options;
  const client = createOpenAIClient({
    ...options.tracing,
    metadata: {
      ...options.tracing?.metadata,
      api: "responses",
      outputFormat: format.kind,
      reasoningEffort: options.modelParams.reasoning_effort,
      verbosity: options.modelParams.verbosity,
      ...(promptCache
        ? {
            promptCacheMode: promptCache.mode,
            promptCacheTtl: promptCache.ttl,
            promptCacheBreakpointCount: 0,
          }
        : {}),
    },
  });
  return generateResponsesText({
    ...options,
    format,
    client,
    promptCacheParams,
  });
}

export function generateOpenAINotes(
  options: Omit<TextGenerationOptions, "modelParamRole">,
): Promise<string> {
  return generateOpenAIText({ ...options, modelParamRole: "notes" });
}
