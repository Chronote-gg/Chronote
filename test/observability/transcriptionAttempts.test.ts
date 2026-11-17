/** @jest-environment node */
import type { Transcription } from "openai/resources/audio";
import { createTranscriptionAttemptLedger } from "../../src/observability/transcriptionAttempts";
import { buildLangfuseTranscriptionAccounting } from "../../src/observability/langfuseUsageDetails";
import { validResponse } from "../fixtures/transcriptionTracing";

type Ledger = ReturnType<typeof createTranscriptionAttemptLedger>;
async function dispatch(ledger: Ledger, usage?: Transcription["usage"]) {
  const attempt = ledger.beginAttempt();
  attempt.markSdkInvocation();
  await attempt.wrapFetch(async () => Response.json({}))(
    "https://synthetic.invalid",
  );
  if (usage) {
    attempt.recordReturnedUsage(usage);
    attempt.settle({ kind: "success" });
  } else {
    attempt.settle({ kind: "failure", failure: "http", status: 503 });
  }
  return attempt;
}

test("local preparation has no dispatch, usage or inferred billing", () => {
  const ledger = createTranscriptionAttemptLedger(3);
  ledger.beginAttempt().settle({ kind: "failure", failure: "input" });
  const snapshot = ledger.snapshot();
  expect(snapshot).toMatchObject({
    sdkInvocationCount: 0,
    httpDispatchAttemptCount: 0,
    knownUsageAttemptCount: 0,
    unknownUsageAttemptCount: 0,
    attemptUsageCoverage: "not_attempted",
    returnedUsages: [],
  });
  const accounting = buildLangfuseTranscriptionAccounting([], 3, snapshot);
  expect(accounting.status).toBe("unpriced");
  expect(accounting.usageDetails).toBeUndefined();
});

test("failed dispatch plus returned usage is partial despite one priced response", async () => {
  const ledger = createTranscriptionAttemptLedger(2);
  await dispatch(ledger);
  await dispatch(ledger, validResponse.usage);
  const snapshot = ledger.snapshot();
  expect(snapshot).toMatchObject({
    sdkInvocationCount: 2,
    httpDispatchAttemptCount: 2,
    retryCount: 1,
    knownUsageAttemptCount: 1,
    unknownUsageAttemptCount: 1,
    attemptUsageCoverage: "partial",
    estimatedAttemptAudioSeconds: 4,
    returnedUsages: [validResponse.usage],
  });
  expect(
    buildLangfuseTranscriptionAccounting(snapshot.returnedUsages, 2, snapshot),
  ).toMatchObject({
    status: "partial",
    requestCount: 1,
    pricedRequestCount: 1,
    unpricedRequestCount: 0,
    usageDetails: { input: 23, output: 11, total: 34 },
  });
});

test.each([
  { type: "duration", seconds: 3 },
  { type: "duration", seconds: 0 },
] satisfies Transcription["usage"][])(
  "duration usage %# is known but cannot establish token pricing",
  async (usage) => {
    const ledger = createTranscriptionAttemptLedger();
    await dispatch(ledger, usage);
    const snapshot = ledger.snapshot();
    expect(snapshot.attemptUsageCoverage).toBe("complete");
    expect(snapshot.knownUsageAttemptCount).toBe(1);
    expect(
      buildLangfuseTranscriptionAccounting([usage], undefined, snapshot).status,
    ).toBe("unpriced");
  },
);

test.each([Number.NaN, -1, Infinity])(
  "invalid usage %s remains unknown without invalid aggregate numbers",
  async (value) => {
    const ledger = createTranscriptionAttemptLedger(value);
    const usage: Transcription["usage"] = {
      type: "tokens",
      input_tokens: value,
      output_tokens: 2,
      total_tokens: value,
    };
    await dispatch(ledger, usage);
    const snapshot = ledger.snapshot();
    expect(snapshot).toMatchObject({
      knownUsageAttemptCount: 0,
      unknownUsageAttemptCount: 1,
      attemptUsageCoverage: "unknown",
      returnedUsages: [usage],
    });
    expect(snapshot.estimatedAttemptAudioSeconds).toBeUndefined();
    expect(
      buildLangfuseTranscriptionAccounting([usage], undefined, snapshot).status,
    ).toBe("unpriced");
  },
);

test("a returned response without usage still contributes to response counts", async () => {
  const ledger = createTranscriptionAttemptLedger();
  const attempt = await dispatch(ledger);
  attempt.recordReturnedUsage(undefined);
  const snapshot = ledger.snapshot();
  expect(snapshot.returnedUsages).toEqual([undefined]);
  expect(
    buildLangfuseTranscriptionAccounting(
      snapshot.returnedUsages,
      undefined,
      snapshot,
    ),
  ).toMatchObject({
    requestCount: 1,
    unpricedRequestCount: 1,
    status: "unpriced",
  });
});

test("attempt-bound fetches keep overlapping attempt usage separate", async () => {
  const ledger = createTranscriptionAttemptLedger();
  const first = ledger.beginAttempt();
  const second = ledger.beginAttempt();
  first.markSdkInvocation();
  second.markSdkInvocation();
  const firstFetch = first.wrapFetch(async () => {
    throw new TypeError("private body");
  });
  const secondFetch = second.wrapFetch(async () => Response.json({}));
  await secondFetch("https://synthetic.invalid/second");
  second.recordReturnedUsage(validResponse.usage);
  await expect(
    firstFetch("https://synthetic.invalid/private-path"),
  ).rejects.toThrow();
  first.settle({ kind: "failure", failure: "connection" });
  second.settle({ kind: "success" });
  expect(ledger.snapshot()).toMatchObject({
    httpDispatchAttemptCount: 2,
    knownUsageAttemptCount: 1,
    unknownUsageAttemptCount: 1,
    retryCount: 1,
  });
  expect(JSON.stringify(ledger.snapshot())).not.toMatch(
    /private body|private-path/,
  );
});

test("snapshot usage survives a later attempt failure and caller mutation", async () => {
  const ledger = createTranscriptionAttemptLedger();
  await dispatch(ledger, validResponse.usage);
  ledger.snapshot().returnedUsages.length = 0;
  await dispatch(ledger);
  expect(ledger.snapshot().returnedUsages).toEqual([validResponse.usage]);
});
