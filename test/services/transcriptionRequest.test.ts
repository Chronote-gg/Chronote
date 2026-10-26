/** @jest-environment node */
import timers from "node:timers/promises";
import {
  buildAsrFixture,
  transientResponse,
  validResponse,
} from "../fixtures/transcriptionRequest";
import { deferred, flushTurn } from "../fixtures/transcriptionTracing";

afterEach(() => jest.restoreAllMocks());

test.each([408, 409, 429, 500, 503, 599])(
  "retries transient HTTP %i with a fresh closed stream",
  async (status) => {
    const f = await buildAsrFixture({
      outcomes: [{ ...transientResponse, status }, validResponse],
    });
    await expect(f.run()).resolves.toEqual(validResponse);
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(f.openedStreams).toHaveLength(2);
    expect(f.closedStreams).toEqual(f.openedStreams);
    expect(f.openedStreams[0]).not.toBe(f.openedStreams[1]);
    expect(f.ledger.snapshot()).toMatchObject({
      sdkInvocationCount: 2,
      httpDispatchAttemptCount: 2,
      retryCount: 1,
      knownUsageAttemptCount: 1,
      unknownUsageAttemptCount: 1,
      attemptUsageCoverage: "partial",
    });
  },
);

test.each([400, 401, 403, 404, 422])(
  "does not retry terminal HTTP %i even when the provider requests retry",
  async (status) => {
    const f = await buildAsrFixture({
      outcomes: [{ status, headers: { "x-should-retry": "true" } }],
    });
    await expect(f.run()).rejects.toMatchObject({ status });
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(f.closedStreams).toHaveLength(1);
  },
);

test.each([
  { status: 429, code: "insufficient_quota" },
  { status: 503, headers: { "x-should-retry": "false" } },
])(
  "terminal provider exclusion %# stops after one dispatch",
  async (outcome) => {
    const f = await buildAsrFixture({ outcomes: [outcome] });
    await expect(f.run()).rejects.toMatchObject({ status: outcome.status });
    expect(f.fetch).toHaveBeenCalledTimes(1);
  },
);

test("exhaustion dispatches exactly four times with SDK retries disabled", async () => {
  const f = await buildAsrFixture({
    outcomes: Array.from({ length: 4 }, () => transientResponse),
  });
  await expect(f.run()).rejects.toMatchObject({ status: 503 });
  expect(f.fetch).toHaveBeenCalledTimes(4);
  expect(
    f.requests.map(({ headers }) => headers.get("x-stainless-retry-count")),
  ).toEqual(["0", "0", "0", "0"]);
  expect(f.closedStreams).toHaveLength(4);
  expect(f.ledger.snapshot()).toMatchObject({
    logicalCandidateCount: 1,
    sdkInvocationCount: 4,
    httpDispatchAttemptCount: 4,
    retryCount: 3,
    unknownUsageAttemptCount: 4,
    attemptUsageCoverage: "unknown",
  });
  await flushTurn();
  expect(f.fetch).toHaveBeenCalledTimes(4);
});

test("network rejection is dispatched unknown work and can recover", async () => {
  const f = await buildAsrFixture({
    outcomes: [new TypeError("synthetic connection failure"), validResponse],
  });
  jest.spyOn(timers, "setTimeout").mockResolvedValue(undefined);
  await expect(f.run()).resolves.toEqual(validResponse);
  expect(f.ledger.snapshot()).toMatchObject({
    httpDispatchAttemptCount: 2,
    knownUsageAttemptCount: 1,
    unknownUsageAttemptCount: 1,
  });
});

test("classification recognizes timeout but excludes input and unrelated errors", async () => {
  const f = await buildAsrFixture({ outcomes: [validResponse] });
  const { default: OpenAI } = await import("openai");
  const { TranscriptionInputError } =
    await import("../../src/services/transcriptionInput");
  expect(
    f.isTransientTranscriptionFailure(new OpenAI.APIConnectionTimeoutError()),
  ).toBe(true);
  expect(
    f.isTransientTranscriptionFailure(
      new TranscriptionInputError(new Error("synthetic read")),
    ),
  ).toBe(false);
  expect(f.isTransientTranscriptionFailure(new Error("ordinary error"))).toBe(
    false,
  );
  expect(f.isTransientTranscriptionFailure({ status: 503 })).toBe(false);
});

test.each([
  [{ "retry-after-ms": "0" }, 0],
  [{ "retry-after-ms": "60000" }, 60_000],
  [{ "retry-after-ms": "12", "retry-after": "20" }, 12],
  [{ "retry-after": "0" }, 0],
  [{ "retry-after": "60" }, 60_000],
])("honors bounded Retry-After headers %#", async (headers, delay) => {
  const f = await buildAsrFixture({
    outcomes: [{ status: 503, headers }, validResponse],
  });
  const sleep = jest.spyOn(timers, "setTimeout").mockResolvedValue(undefined);
  await f.run();
  expect(sleep).toHaveBeenCalledWith(delay, undefined, { signal: f.signal });
});

test.each(["bad", "-1", "Infinity", "60001"])(
  "falls back to jitter for invalid retry-after-ms %s",
  async (value) => {
    const f = await buildAsrFixture({
      outcomes: [
        { status: 503, headers: { "retry-after-ms": value } },
        validResponse,
      ],
    });
    const sleep = jest.spyOn(timers, "setTimeout").mockResolvedValue(undefined);
    jest.spyOn(Math, "random").mockReturnValue(0);
    await f.run();
    const { ExponentialBackoff } = await import("cockatiel");
    expect(sleep.mock.calls[0]?.[0]).toBe(
      new ExponentialBackoff({
        initialDelay: 128,
        exponent: 2,
        maxDelay: 30_000,
      }).next().duration,
    );
  },
);

test("uses the HTTP-date retry delay", async () => {
  const now = Date.parse("2026-10-21T12:00:00Z");
  jest.spyOn(Date, "now").mockReturnValue(now);
  const f = await buildAsrFixture({
    outcomes: [
      {
        status: 503,
        headers: { "retry-after": "Wed, 21 Oct 2026 12:00:02 GMT" },
      },
      validResponse,
    ],
  });
  const sleep = jest.spyOn(timers, "setTimeout").mockResolvedValue(undefined);
  await f.run();
  expect(sleep.mock.calls[0]?.[0]).toBe(2_000);
});

test("advances the configured backoff even when Retry-After overrides a delay", async () => {
  const f = await buildAsrFixture({
    outcomes: [
      transientResponse,
      { status: 503 },
      { status: 503 },
      validResponse,
    ],
  });
  const { ExponentialBackoff } = await import("cockatiel");
  const sequence = new ExponentialBackoff({
    initialDelay: 128,
    exponent: 2,
    maxDelay: 30_000,
  });
  jest.spyOn(Math, "random").mockReturnValue(0.5);
  const first = sequence.next();
  const second = first.next(undefined);
  const third = second.next(undefined);
  const sleep = jest.spyOn(timers, "setTimeout").mockResolvedValue(undefined);
  await f.run();
  expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([
    0,
    second.duration,
    third.duration,
  ]);
});

test("abort before input preparation opens no stream and dispatches nothing", async () => {
  const f = await buildAsrFixture({ outcomes: [validResponse] });
  f.controller.abort();
  await expect(f.run()).rejects.toMatchObject({ name: "AbortError" });
  expect(f.openedStreams).toHaveLength(0);
  expect(f.fetch).not.toHaveBeenCalled();
});

test("abort interrupts a Retry-After wait without another dispatch", async () => {
  const f = await buildAsrFixture({
    outcomes: [{ status: 503, headers: { "retry-after-ms": "60000" } }],
  });
  const actualSleep = timers.setTimeout;
  const sleeping = deferred<void>();
  jest.spyOn(timers, "setTimeout").mockImplementation((...args) => {
    sleeping.resolve();
    return actualSleep(...args);
  });
  const task = f.run();
  const rejected = expect(task).rejects.toMatchObject({ name: "AbortError" });
  await sleeping.promise;
  f.controller.abort();
  await rejected;
  expect(f.fetch).toHaveBeenCalledTimes(1);
  expect(f.closedStreams).toHaveLength(1);
});

test("issued fetch drains after abort without claiming unreturned SDK usage", async () => {
  const release = deferred<void>();
  const f = await buildAsrFixture({
    outcomes: [validResponse],
    holdFetch: release.promise,
  });
  let settled = false;
  const task = f.run().finally(() => {
    settled = true;
  });
  const rejected = expect(task).rejects.toMatchObject({ name: "AbortError" });
  await f.entered;
  f.controller.abort();
  await flushTurn();
  expect(settled).toBe(false);
  release.resolve();
  await rejected;
  expect(f.closedStreams).toHaveLength(1);
  expect(f.fetch).toHaveBeenCalledTimes(1);
  expect(f.ledger.snapshot()).toMatchObject({
    sdkInvocationCount: 1,
    httpDispatchAttemptCount: 1,
    retryCount: 0,
    knownUsageAttemptCount: 0,
    unknownUsageAttemptCount: 1,
    attemptUsageCoverage: "unknown",
    returnedUsages: [],
  });
});

test("SDK-returned usage survives abort before the result publication fence", async () => {
  const f = await buildAsrFixture({ outcomes: [validResponse] });
  const beginAttempt = f.ledger.beginAttempt;
  const returned = jest.fn();
  jest.spyOn(f.ledger, "beginAttempt").mockImplementation((candidate) => {
    const attempt = beginAttempt(candidate);
    const recordReturnedUsage = attempt.recordReturnedUsage;
    jest.spyOn(attempt, "recordReturnedUsage").mockImplementation((usage) => {
      expect(f.signal.aborted).toBe(false);
      recordReturnedUsage(usage);
      returned(usage);
      f.controller.abort();
    });
    return attempt;
  });

  await expect(f.run()).rejects.toMatchObject({ name: "AbortError" });

  expect(returned).toHaveBeenCalledTimes(1);
  expect(returned).toHaveBeenCalledWith(validResponse.usage);
  expect(f.fetch).toHaveBeenCalledTimes(1);
  expect(f.closedStreams).toEqual(f.openedStreams);
  expect(f.closedStreams).toHaveLength(1);
  expect(f.ledger.snapshot()).toMatchObject({
    sdkInvocationCount: 1,
    httpDispatchAttemptCount: 1,
    retryCount: 0,
    knownUsageAttemptCount: 1,
    unknownUsageAttemptCount: 0,
    attemptUsageCoverage: "complete",
    returnedUsages: [validResponse.usage],
  });
});

test("preparation failure has no SDK invocation or fetch dispatch", async () => {
  const failure = new Error("synthetic open failure");
  const f = await buildAsrFixture({
    outcomes: [validResponse],
    openError: failure,
  });
  await expect(f.run()).rejects.toBeDefined();
  expect(f.fetch).not.toHaveBeenCalled();
  expect(f.ledger.snapshot()).toMatchObject({
    sdkInvocationCount: 0,
    httpDispatchAttemptCount: 0,
    attemptUsageCoverage: "not_attempted",
  });
});

test("multipart EIO after fetch entry is terminal local failure with unknown usage", async () => {
  const failure = Object.assign(new Error("synthetic EIO"), { code: "EIO" });
  const f = await buildAsrFixture({
    outcomes: [validResponse],
    readError: failure,
  });
  const { TranscriptionInputError } =
    await import("../../src/services/transcriptionInput");
  const scope = f.createTranscriptionFailureScope();
  await scope.run(async () => {
    try {
      await f.run();
      throw new Error("Expected multipart read to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(TranscriptionInputError);
      expect(f.isExhaustedTranscriptionFailure(error)).toBe(false);
    }
  });
  expect(f.fetch).toHaveBeenCalledTimes(1);
  expect(f.closedStreams).toHaveLength(1);
  expect(f.ledger.snapshot()).toMatchObject({
    httpDispatchAttemptCount: 1,
    unknownUsageAttemptCount: 1,
    retryCount: 0,
  });
});

test.each([false, true])(
  "delegates to the %s default transport without changing multipart inputs",
  async (defaultTransport) => {
    const f = await buildAsrFixture({
      outcomes: [validResponse],
      defaultTransport,
    });
    await f.run();
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(f.bodies[0]).toContain("synthetic wav bytes");
    for (const value of [
      "gpt-4o-transcribe",
      "Project terminology.",
      "logprobs",
    ]) {
      expect(f.bodies[0]).toContain(value);
    }
    expect(f.requests[0]?.headers.get("authorization")).toBe(
      "Bearer test-openai-api-key",
    );
  },
);

test("failure provenance is operation-local even when another scope sees the same error", async () => {
  const f = await buildAsrFixture({
    outcomes: Array.from({ length: 4 }, () => transientResponse),
  });
  const scope = f.createTranscriptionFailureScope();
  const otherScope = f.createTranscriptionFailureScope();
  await scope.run(async () => {
    try {
      await f.run();
      throw new Error("Expected exhaustion");
    } catch (error) {
      expect(f.isExhaustedTranscriptionFailure(error)).toBe(true);
      await otherScope.run(async () => {
        expect(f.isExhaustedTranscriptionFailure(error)).toBe(false);
        await flushTurn();
        expect(f.isExhaustedTranscriptionFailure(error)).toBe(false);
      });
      expect(f.isExhaustedTranscriptionFailure(error)).toBe(true);
    }
  });
});

test("exhaustion preserves exact SDK error identity across concurrent failure scopes", async () => {
  const f = await buildAsrFixture({ outcomes: [validResponse] });
  const { default: OpenAI } = await import("openai");
  const factory = await import("../../src/services/openaiClient");
  const original = factory.createOpenAIClient({ disableTracing: true });
  const failure = new OpenAI.APIConnectionTimeoutError();
  jest
    .spyOn(original.audio.transcriptions, "create")
    .mockRejectedValue(failure);
  jest.spyOn(factory, "createOpenAIClient").mockReturnValue(original);
  jest.spyOn(timers, "setTimeout").mockResolvedValue(undefined);
  const exhausted = deferred<void>();
  const release = deferred<void>();
  const owner = f.createTranscriptionFailureScope();
  const unrelated = f.createTranscriptionFailureScope();
  await Promise.all([
    owner.run(async () => {
      await expect(f.run()).rejects.toBe(failure);
      expect(f.isExhaustedTranscriptionFailure(failure)).toBe(true);
      exhausted.resolve();
      await release.promise;
      expect(f.isExhaustedTranscriptionFailure(failure)).toBe(true);
    }),
    unrelated.run(async () => {
      await exhausted.promise;
      expect(f.isExhaustedTranscriptionFailure(failure)).toBe(false);
      release.resolve();
    }),
  ]);
});

test("multipart preparation can invoke the SDK without entering fetch", async () => {
  const failure = new Error("synthetic multipart preparation");
  const f = await buildAsrFixture({
    outcomes: [validResponse],
    multipartError: failure,
  });
  await expect(f.run()).rejects.toBe(failure);
  expect(f.fetch).not.toHaveBeenCalled();
  expect(f.closedStreams).toHaveLength(1);
  expect(f.ledger.snapshot()).toMatchObject({
    sdkInvocationCount: 1,
    httpDispatchAttemptCount: 0,
    unknownUsageAttemptCount: 0,
    attemptUsageCoverage: "not_attempted",
  });
});
