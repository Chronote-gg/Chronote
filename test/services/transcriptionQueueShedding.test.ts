/** @jest-environment node */
import type { ClientOptions } from "openai";
import {
  validResponse,
  withTracingFixture,
} from "../fixtures/transcriptionTracing";

jest.setTimeout(120_000);

const PROVIDER_LATENCY_MS = 1_000;
const SPEAKERS_PER_MEETING = 4;
const TURN_PERIOD_MS = 20_000;
const SIMULATED_MS = 8 * 60_000;
// Every job must settle within this much simulated time after the last arrival.
const DRAIN_LIMIT_MS = 30 * 60_000;
// Fast revisions per turn cycle through 2, 2, 3: about 2.3 fast calls per slow call.
const FAST_PER_TURN = [2, 2, 3];

type Mode = "fast" | "slow";
type Constants = typeof import("../../src/constants");

/** Every speaker's calls on one task; three meetings make about 120 a minute. */
function arrivals(meetings: number) {
  const calls: Array<{ at: number; mode: Mode }> = [];
  for (let speaker = 0; speaker < meetings * SPEAKERS_PER_MEETING; speaker++) {
    for (
      let turn = 0, start = speaker * 1_700;
      start < SIMULATED_MS;
      turn++, start += TURN_PERIOD_MS
    ) {
      const fast = FAST_PER_TURN[turn % FAST_PER_TURN.length];
      for (let revision = 0; revision < fast; revision++)
        calls.push({ at: start + revision * 1_500, mode: "fast" });
      calls.push({ at: start + 5_000, mode: "slow" });
    }
  }
  return calls;
}

/** Runs the real queue against a fake provider and reports what it refused. */
async function simulate(meetings: number, overrides: Partial<Constants> = {}) {
  jest.doMock("../../src/constants", () => ({
    ...jest.requireActual<Constants>("../../src/constants"),
    ...overrides,
  }));
  jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
  const error = jest.spyOn(console, "error").mockImplementation(() => {});
  const fetch: NonNullable<ClientOptions["fetch"]> = () =>
    new Promise((resolve) =>
      setTimeout(
        () => resolve(Response.json(validResponse)),
        PROVIDER_LATENCY_MS,
      ),
    );
  const failed = { fast: 0, slow: 0 };
  let maxQueueWaitMs = 0;
  try {
    await withTracingFixture(
      { realPolicies: true, transport: fetch },
      async (f) => {
        f.attachment.resolve();
        const calls = arrivals(meetings);
        let settled = 0;
        for (const call of calls)
          setTimeout(() => {
            const queuedAt = Date.now();
            void f
              .transcribe({}, { noiseGateMode: call.mode })
              .then((result) => {
                settled += 1;
                if (result.status === "failed") failed[call.mode] += 1;
                else
                  maxQueueWaitMs = Math.max(
                    maxQueueWaitMs,
                    Date.now() - queuedAt - PROVIDER_LATENCY_MS,
                  );
              });
          }, call.at);
        for (
          let elapsed = 0;
          settled < calls.length && elapsed < SIMULATED_MS + DRAIN_LIMIT_MS;
          elapsed += 1_000
        )
          await jest.advanceTimersByTimeAsync(1_000);
        if (settled < calls.length)
          throw new Error(
            `${calls.length - settled} of ${calls.length} jobs never settled`,
          );
      },
    );
    return { slowRejected: failed.slow, fastShed: failed.fast, maxQueueWaitMs };
  } finally {
    error.mockRestore();
    jest.useRealTimers();
    jest.dontMock("../../src/constants");
  }
}

const NO_SHEDDING = { TRANSCRIPTION_FAST_MAX_QUEUED: Number.POSITIVE_INFINITY };

test("three long meetings on one task fit the queue without refusing a snippet", async () => {
  const run = await simulate(3);
  expect(run.slowRejected).toBe(0);
  expect(run.fastShed).toBe(0);
});

test("past capacity the queue sheds fast previews and keeps every slow snippet", async () => {
  // About 320 calls a minute against about 200: roughly 830 of 1,790 fast calls
  // are shed, while without shedding about 260 of 770 slow calls are refused.
  const shedding = await simulate(8);
  expect(shedding.slowRejected).toBe(0);
  expect(shedding.fastShed).toBeGreaterThan(600);
  expect(shedding.fastShed).toBeLessThan(1_100);
  const unshed = await simulate(8, NO_SHEDDING);
  expect(unshed.slowRejected).toBeGreaterThan(150);
  expect(unshed.slowRejected).toBeLessThan(400);
});
