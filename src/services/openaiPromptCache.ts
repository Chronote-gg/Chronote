import type { ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses";
import type { ModelParamRole } from "../config/types";

const EXPLICIT_CACHE_MODELS = [
  "gpt-5.6",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-6-sol",
  "gpt-6-luna",
  "gpt-6-astra",
  "gpt-6.1-sol",
];
const MODEL_SNAPSHOT_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function buildOpenAIPromptCacheParams(options: {
  model: string;
  modelParamRole?: ModelParamRole;
}): Pick<ResponseCreateParamsNonStreaming, "prompt_cache_options"> {
  if (options.modelParamRole !== "notes") return {};
  const normalized = options.model.trim().toLowerCase();
  const supported = EXPLICIT_CACHE_MODELS.some(
    (model) =>
      normalized === model ||
      (normalized.startsWith(`${model}-`) &&
        MODEL_SNAPSHOT_DATE.test(normalized.slice(model.length + 1))),
  );
  if (!supported) return {};

  // The current notes layout includes meeting context before its long static
  // instructions. With no breakpoints, explicit mode avoids caching unique input.
  return { prompt_cache_options: { mode: "explicit", ttl: "30m" } };
}
