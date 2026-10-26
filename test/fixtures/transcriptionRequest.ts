import { Readable } from "node:stream";
import type { ClientOptions } from "openai";
import type { Transcription } from "openai/resources/audio";
import { deferred, validResponse } from "./transcriptionTracing";

export type AsrOutcome =
  | Transcription
  | Error
  | { status: number; headers?: Record<string, string>; code?: string };
type FixtureOptions = {
  outcomes: AsrOutcome[];
  signal?: AbortSignal;
  prompt?: string;
  openError?: Error;
  readError?: Error;
  multipartError?: Error;
  holdFetch?: Promise<void>;
  defaultTransport?: boolean;
};

export async function buildAsrFixture(options: FixtureOptions) {
  jest.resetModules();
  jest.dontMock("../../src/services/openaiClient");
  jest.dontMock("cockatiel");
  const openedStreams: Readable[] = [];
  const closedStreams: Readable[] = [];
  jest.doMock("node:fs", () => ({
    ...jest.requireActual<typeof import("node:fs")>("node:fs"),
    createReadStream: () => {
      if (options.openError) throw options.openError;
      const stream = options.readError
        ? new Readable({
            read() {
              this.destroy(options.readError);
            },
          })
        : Readable.from([Buffer.from("synthetic wav bytes")]);
      if (options.multipartError) {
        Object.defineProperty(stream, Symbol.asyncIterator, {
          get() {
            throw options.multipartError;
          },
        });
      }
      openedStreams.push(stream);
      stream.once("close", () => closedStreams.push(stream));
      return stream;
    },
  }));
  jest.doMock("../../src/services/langfuseClient", () => ({
    isLangfuseTracingEnabled: () => false,
  }));
  const entered = deferred<void>();
  const bodies: string[] = [];
  const requests: Array<{ url: string; headers: Headers }> = [];
  let index = 0;
  const fetch: NonNullable<ClientOptions["fetch"]> = jest.fn(
    async (url, init) => {
      requests.push({ url: String(url), headers: new Headers(init?.headers) });
      entered.resolve();
      bodies.push(await new Response(init?.body).text());
      await options.holdFetch;
      const outcome = options.outcomes[index++];
      if (!outcome) throw new Error("Unexpected extra ASR dispatch");
      if (outcome instanceof Error) throw outcome;
      if ("status" in outcome) {
        return Response.json(
          { error: { message: "synthetic failure", code: outcome.code } },
          { status: outcome.status, headers: outcome.headers },
        );
      }
      return Response.json(outcome);
    },
  );
  const unexpectedFetch = async () => {
    throw new Error("Unexpected uncaptured native transport");
  };
  jest
    .spyOn(globalThis, "fetch")
    .mockImplementation(options.defaultTransport ? fetch : unexpectedFetch);
  const request = await import("../../src/services/transcriptionRequest");
  if (options.defaultTransport) globalThis.fetch = unexpectedFetch;
  const { createTranscriptionAttemptLedger } =
    await import("../../src/observability/transcriptionAttempts");
  const ledger = createTranscriptionAttemptLedger(2);
  const controller = new AbortController();
  const signal = options.signal ?? controller.signal;
  const run = () =>
    request.runTranscriptionRequest({
      candidate: "prompt",
      file: "/synthetic/request.wav",
      signal,
      request: {
        model: "gpt-4o-transcribe",
        language: "en",
        temperature: 0,
        response_format: "json",
        include: ["logprobs"],
        prompt: options.prompt ?? "Project terminology.",
      },
      ledger,
      clientOptions: { disableTracing: true },
      ...(options.defaultTransport ? {} : { transport: { fetch } }),
    });
  return {
    ...request,
    run,
    fetch,
    entered: entered.promise,
    ledger,
    controller,
    signal,
    bodies,
    requests,
    openedStreams,
    closedStreams,
  };
}

export const transientResponse = {
  status: 503,
  headers: { "retry-after-ms": "0" },
};

export { validResponse };
