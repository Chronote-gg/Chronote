import { createHash } from "node:crypto";
import { getEncoding } from "js-tiktoken";
import { createOpenAIClient } from "./openaiClient";
import { startObservation } from "@langfuse/tracing";
import { isLangfuseTracingEnabled } from "./langfuseClient";
import type { CreateEmbeddingResponse } from "openai/resources/embeddings";

export const SEARCH_EMBEDDING_MODEL = "text-embedding-3-small";
export const SEARCH_EMBEDDING_DIMENSIONS = 1536;
const tokenizer = getEncoding("cl100k_base");
export const searchEmbeddingInputHash = (text: string) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        SEARCH_EMBEDDING_MODEL,
        SEARCH_EMBEDDING_DIMENSIONS,
        text,
      ]),
    )
    .digest("hex");

export async function embedSearchText(
  text: string,
  signal?: AbortSignal,
): Promise<number[]> {
  return (await embedSearchTexts([text], signal))[0];
}

function embeddingVectors(result: CreateEmbeddingResponse, inputCount: number) {
  const vectors: number[][] = [];
  for (let index = 0; index < inputCount; index++) {
    const vector = result.data.find((item) => item.index === index)?.embedding;
    if (
      result.model !== SEARCH_EMBEDDING_MODEL ||
      !vector ||
      vector.length !== SEARCH_EMBEDDING_DIMENSIONS ||
      vector.some((n) => !Number.isFinite(n))
    ) {
      throw Error("Search embedding model or dimensions mismatch");
    }
    vectors.push(vector);
  }
  return vectors;
}

export async function embedSearchTexts(
  texts: string[],
  signal?: AbortSignal,
): Promise<number[][]> {
  signal?.throwIfAborted();
  if (
    texts.some(
      (text) => !text.trim() || tokenizer.encode(text, [], []).length > 8192,
    )
  )
    throw Error("Search embedding input is empty or exceeds 8192 tokens");
  if (!texts.length) return [];
  // The generic OpenAI wrapper does not recognize embedding-only token usage.
  const client = createOpenAIClient({ disableTracing: true });
  const vectors: number[][] = [];
  // 32 maximum-length inputs stay below the provider's 300,000-token request limit.
  for (let offset = 0; offset < texts.length; offset += 32) {
    signal?.throwIfAborted();
    const batch = texts.slice(offset, offset + 32);
    const observation = isLangfuseTracingEnabled()
      ? startObservation(
          "meeting-search-embedding",
          {
            model: SEARCH_EMBEDDING_MODEL,
            metadata: {
              inputCount: batch.length,
              dimensions: SEARCH_EMBEDDING_DIMENSIONS,
            },
          },
          { asType: "embedding" },
        )
      : undefined;
    try {
      const result = await client.embeddings.create(
        {
          model: SEARCH_EMBEDDING_MODEL,
          dimensions: SEARCH_EMBEDDING_DIMENSIONS,
          input: batch,
          encoding_format: "float",
        },
        { signal, maxRetries: 2, timeout: 45_000 },
      );
      if (result.usage)
        observation?.update({
          usageDetails: {
            input: result.usage.prompt_tokens,
            total: result.usage.total_tokens,
          },
        });
      vectors.push(...embeddingVectors(result, batch.length));
    } catch (error) {
      observation?.update({
        level: "ERROR",
        statusMessage: "Embedding request failed",
      });
      throw error;
    } finally {
      observation?.end();
    }
  }
  return vectors;
}
