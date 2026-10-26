import { createReadStream, type ReadStream } from "node:fs";
import OpenAI from "openai";

export class TranscriptionInputError extends Error {
  constructor(cause: unknown) {
    super("Transcription input failed.", { cause });
    this.name = "TranscriptionInputError";
  }
}

type RequestOutcome<T> =
  { kind: "success"; value: T } | { kind: "failure"; error: unknown };

function causedBy(error: unknown, readError: Error) {
  const seen = new Set<Error>();
  while (error instanceof Error && !seen.has(error)) {
    if (error === readError) return true;
    seen.add(error);
    error = error.cause;
  }
  return false;
}

function resolveOutcome<T>(outcome: RequestOutcome<T>, readError?: Error): T {
  if (outcome.kind === "success") {
    if (readError) throw new TranscriptionInputError(readError);
    return outcome.value;
  }
  const { error } = outcome;
  if (
    error instanceof OpenAI.APIUserAbortError ||
    (error instanceof Error && error.name === "AbortError")
  ) {
    throw error;
  }
  if (readError && causedBy(error, readError)) {
    throw new TranscriptionInputError(error);
  }
  throw error;
}

/** The SDK response does not prove its local upload stream has closed. */
export async function withTranscriptionInput<T>(
  filePath: string,
  request: (file: ReadStream) => Promise<T>,
): Promise<T> {
  const file = createReadStream(filePath);
  let readError: Error | undefined;
  file.on("error", (error) => {
    readError ??= error;
  });
  const closed = new Promise<void>((resolve) => {
    file.once("close", resolve);
  });
  let outcome: RequestOutcome<T>;
  try {
    outcome = { kind: "success", value: await request(file) };
  } catch (error) {
    outcome = { kind: "failure", error };
  } finally {
    file.destroy();
    await closed;
  }
  return resolveOutcome(outcome, readError);
}
