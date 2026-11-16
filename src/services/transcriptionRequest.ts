import { AsyncLocalStorage } from "node:async_hooks";
import { setTimeout } from "node:timers/promises";
import OpenAI, { type ClientOptions } from "openai";
import type {
  Transcription,
  TranscriptionCreateParamsNonStreaming,
} from "openai/resources/audio";
import { ExponentialBackoff, type IBackoff } from "cockatiel";
import {
  TRANSCRIPTION_MAX_RETRIES,
  TRANSCRIPTION_RETRY_AFTER_MAX_MS,
  TRANSCRIPTION_RETRY_EXPONENT,
  TRANSCRIPTION_RETRY_INITIAL_DELAY_MS,
  TRANSCRIPTION_RETRY_MAX_DELAY_MS,
} from "../constants";
import {
  type createTranscriptionAttemptLedger,
  type TranscriptionAttemptOutcome,
} from "../observability/transcriptionAttempts";
import { createOpenAIClient } from "./openaiClient";
import {
  TranscriptionInputError,
  withTranscriptionInput,
} from "./transcriptionInput";

import type { TranscriptionLanguage } from "../config/transcriptionLanguage";
const nativeFetch = globalThis.fetch;
const failureScopes = new AsyncLocalStorage<WeakSet<Error>>();

type RequestInput = {
  file: string;
  signal: AbortSignal;
  request: Omit<TranscriptionCreateParamsNonStreaming<"json">, "file">;
  ledger: ReturnType<typeof createTranscriptionAttemptLedger>;
  clientOptions?: Parameters<typeof createOpenAIClient>[0];
  transport?: Pick<ClientOptions, "fetch">;
  onSdkInvocation?: () => void;
};

export function createTranscriptionFailureScope() {
  const exhausted = new WeakSet<Error>();
  return {
    run<T>(callback: () => T): T {
      return failureScopes.run(exhausted, callback);
    },
  };
}

export function isTransientTranscriptionFailure(error: unknown): boolean {
  if (
    error instanceof TranscriptionInputError ||
    error instanceof OpenAI.APIUserAbortError ||
    !(error instanceof OpenAI.APIError)
  ) {
    return false;
  }
  if (error.headers?.get("x-should-retry") === "false") return false;
  if (error instanceof OpenAI.APIConnectionError) return true;
  if (error.status === 429 && error.code === "insufficient_quota") return false;
  const status = error.status;
  return (
    status === 408 ||
    status === 409 ||
    status === 429 ||
    (status !== undefined && status >= 500 && status <= 599)
  );
}

export function isExhaustedTranscriptionFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    failureScopes.getStore()?.has(error) === true &&
    isTransientTranscriptionFailure(error)
  );
}

function failureOutcome(
  error: unknown,
  signal: AbortSignal,
): TranscriptionAttemptOutcome {
  if (signal.aborted || error instanceof OpenAI.APIUserAbortError) {
    return { kind: "failure", failure: "cancelled" };
  }
  if (error instanceof TranscriptionInputError) {
    return { kind: "failure", failure: "input" };
  }
  if (error instanceof OpenAI.APIConnectionTimeoutError) {
    return { kind: "failure", failure: "timeout" };
  }
  if (error instanceof OpenAI.APIConnectionError) {
    return { kind: "failure", failure: "connection" };
  }
  if (error instanceof OpenAI.APIError && error.status !== undefined) {
    return { kind: "failure", failure: "http", status: error.status };
  }
  return { kind: "failure", failure: "other" };
}

function boundedDelay(value: number) {
  return Number.isFinite(value) &&
    value >= 0 &&
    value <= TRANSCRIPTION_RETRY_AFTER_MAX_MS
    ? value
    : undefined;
}

function retryAfterSecondsOrDate(header: string | null) {
  if (!header?.trim()) return undefined;
  const seconds = Number(header);
  return boundedDelay(
    Number.isNaN(seconds) ? Date.parse(header) - Date.now() : seconds * 1_000,
  );
}

function retryAfterDelay(error: unknown) {
  if (!(error instanceof OpenAI.APIError)) return undefined;
  const milliseconds = error.headers?.get("retry-after-ms");
  const preferred = milliseconds?.trim()
    ? boundedDelay(Number(milliseconds))
    : undefined;
  return (
    preferred ??
    retryAfterSecondsOrDate(error.headers?.get("retry-after") ?? null)
  );
}

async function runAttempt(input: RequestInput): Promise<Transcription> {
  const { signal, ledger } = input;
  signal.throwIfAborted();
  const attempt = ledger.beginAttempt();
  try {
    const client = createOpenAIClient(input.clientOptions, {
      fetch: attempt.wrapFetch(input.transport?.fetch ?? nativeFetch),
    });
    const result = await withTranscriptionInput(input.file, async (file) => {
      signal.throwIfAborted();
      input.onSdkInvocation?.();
      attempt.markSdkInvocation();
      const response = await client.audio.transcriptions.create(
        { ...input.request, file },
        { signal, maxRetries: 0 },
      );
      attempt.recordReturnedUsage(response.usage);
      signal.throwIfAborted();
      return response;
    });
    signal.throwIfAborted();
    attempt.settle({ kind: "success" });
    return result;
  } catch (error) {
    attempt.settle(failureOutcome(error, signal));
    throw error;
  }
}

export async function runTranscriptionRequest(
  input: RequestInput,
): Promise<Transcription> {
  const generator = new ExponentialBackoff({
    initialDelay: TRANSCRIPTION_RETRY_INITIAL_DELAY_MS,
    exponent: TRANSCRIPTION_RETRY_EXPONENT,
    maxDelay: TRANSCRIPTION_RETRY_MAX_DELAY_MS,
  });
  let backoff: IBackoff<unknown> | undefined;
  for (let retryCount = 0; ; retryCount += 1) {
    input.signal.throwIfAborted();
    try {
      return await runAttempt(input);
    } catch (error) {
      input.signal.throwIfAborted();
      const transient = isTransientTranscriptionFailure(error);
      if (!transient || retryCount === TRANSCRIPTION_MAX_RETRIES) {
        if (transient && error instanceof Error) {
          failureScopes.getStore()?.add(error);
        }
        throw error;
      }
      backoff = backoff ? backoff.next(undefined) : generator.next();
      const delay = retryAfterDelay(error) ?? backoff.duration;
      await setTimeout(delay, undefined, { signal: input.signal });
    }
  }
}

type TranscriptionModelCapabilities = {
  keywords: boolean;
  languageField: "language" | "languages";
};

// Verified against the API: gpt-transcribe takes `keywords` and a `languages`
// list that replaces `language`; the older models reject both with HTTP 400.
const TRANSCRIPTION_MODEL_CAPABILITIES: Record<
  string,
  TranscriptionModelCapabilities
> = {
  "gpt-transcribe": { keywords: true, languageField: "languages" },
  "gpt-4o-transcribe": { keywords: false, languageField: "language" },
  "gpt-4o-mini-transcribe": { keywords: false, languageField: "language" },
  // Not selectable in production; the offline eval compares against it.
  "whisper-1": { keywords: false, languageField: "language" },
};

export function transcriptionModelCapabilities(
  model: string,
): TranscriptionModelCapabilities {
  const capabilities = TRANSCRIPTION_MODEL_CAPABILITIES[model];
  if (!capabilities)
    throw new Error(`Unsupported transcription model ${model}`);
  return capabilities;
}

/**
 * The production ASR request. It sends no prompt, so the provider has nothing
 * to echo back. A language hint goes out only when the server pins one; auto
 * lets the provider detect the language. Dictionary keywords go out only to a
 * model that accepts them.
 */
export function buildTranscriptionRequest(
  model: string,
  language: TranscriptionLanguage,
  keywords: readonly string[],
) {
  const capabilities = transcriptionModelCapabilities(model);
  return {
    model,
    temperature: 0,
    response_format: "json" as const,
    include: ["logprobs" as const],
    ...(language === "auto"
      ? {}
      : capabilities.languageField === "languages"
        ? { languages: [language] }
        : { language }),
    ...(capabilities.keywords && keywords.length
      ? { keywords: [...keywords] }
      : {}),
  };
}
