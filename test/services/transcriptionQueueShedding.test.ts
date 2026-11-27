/** @jest-environment node */
import type { ClientOptions } from "openai";
import type { SnippetTranscriptionResult } from "../../src/types/audio";
import {
  validResponse,
  withTracingFixture,
} from "../fixtures/transcriptionTracing";

jest.setTimeout(120_000);

const PROVIDER_LATENCY_MS = 1_000;
const MEETINGS = 3;
const SPEAKERS_PER_MEETING = 4;
const TURN_PERIOD_MS = 20_000;
const SIMULATED_MS = 8 * 60_000;
// Fast revisions per turn cycle through 2, 2, 3: about 2.3 fast calls per slow call.
const FAST_PER_TURN = [2, 2, 3];

type Mode = "fast" | "slow";

/** Every speaker's calls on one task: about 120 a minute against a 75 a minute queue. */
function arrivals() {
  const calls: Array<{ at: number; mode: Mode }> = [];
  for (let speaker = 0; speaker < MEETINGS * SPEAKERS_PER_MEETING; speaker++) {
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

test("three long meetings on one task shed fast previews and keep every slow snippet", async () => {
  jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
  const error = jest.spyOn(console, "error").mockImplementation(() => {});
  const fetch: NonNullable<ClientOptions["fetch"]> = () =>
    new Promise((resolve) =>
      setTimeout(
        () => resolve(Response.json(validResponse)),
        PROVIDER_LATENCY_MS,
      ),
    );
  try {
    await withTracingFixture(
      { realPolicies: true, transport: fetch },
      async (f) => {
        f.attachment.resolve();
        const results: Array<Promise<[Mode, SnippetTranscriptionResult]>> = [];
        for (const call of arrivals())
          setTimeout(() => {
            results.push(
              f
                .transcribe({}, { noiseGateMode: call.mode })
                .then((result) => [call.mode, result]),
            );
          }, call.at);
        for (
          let elapsed = 0;
          elapsed < SIMULATED_MS + 180_000;
          elapsed += 1_000
        )
          await jest.advanceTimersByTimeAsync(1_000);
        const settled = await Promise.all(results);
        const failed = (mode: Mode) =>
          settled.filter(([m, r]) => m === mode && r.status === "failed")
            .length;
        expect(failed("fast")).toBeGreaterThan(0);
        expect(failed("slow")).toBe(0);
        expect(error).toHaveBeenCalledWith(
          expect.stringContaining("Failed to transcribe snippet"),
          expect.objectContaining({ reason: "fast_shed", passMode: "fast" }),
        );
      },
    );
  } finally {
    error.mockRestore();
    jest.useRealTimers();
  }
});
