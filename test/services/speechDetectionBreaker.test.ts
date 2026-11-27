/** @jest-environment node */
import { SPEECH_HANG_CEILING_MS } from "../../src/services/speechDetectionService";
import type {
  SpeechAssessment,
  SpeechPhase,
} from "../../src/services/speechDetectionTypes";
import { ControlledSpeechWorker } from "../helpers/speechDetectionHarness";
import {
  fingerprint,
  scored,
  rig,
  reply,
  countMetric,
  settled,
  type Rig,
  assessFast,
  dispatchedMiss,
  inBudget,
  refused,
  opensFor,
} from "../helpers/speechDetectorRig";

it("never opens the breaker on queued expiries alone", async () => {
  const r = rig();
  const worker = await r.ready();
  const running = r.detector.assess(Uint8Array.of(1), "slow");
  const queued = Array.from({ length: 4 }, () => assessFast(r));
  r.clock.advance(500);
  await Promise.all(queued);
  reply(worker, 0);
  await expect(running).resolves.toEqual(scored);
  await inBudget(r, worker);
  expect(worker.requests).toHaveLength(2);
});
it("opens the breaker on two dispatched misses in a row, not one", async () => {
  const r = rig();
  const worker = await r.ready();
  await dispatchedMiss(r, worker);
  await dispatchedMiss(r, worker);
  await refused(r);
  expect(worker.requests).toHaveLength(2);
  expect(worker.terminated).toBe(false);
});
it("resets the miss count on an in-budget result", async () => {
  const r = rig();
  const worker = await r.ready();
  await dispatchedMiss(r, worker);
  await inBudget(r, worker);
  await dispatchedMiss(r, worker);
  await inBudget(r, worker);
});
it("escalates the window 5, 10, 20, 30 s on failed probes and resets after a success", async () => {
  const r = rig();
  const worker = await r.ready();
  await dispatchedMiss(r, worker);
  await dispatchedMiss(r, worker);
  for (const windowMs of [5000, 10000, 20000, 30000, 30000]) {
    await opensFor(r, windowMs);
    await dispatchedMiss(r, worker);
  }
  await opensFor(r, 30000);
  await inBudget(r, worker);
  await dispatchedMiss(r, worker);
  await dispatchedMiss(r, worker);
  await opensFor(r, 5000);
  await inBudget(r, worker);
});
it("starts the window only when the slow inference replies", async () => {
  const r = rig();
  const worker = await r.ready();
  await dispatchedMiss(r, worker);
  const held = assessFast(r);
  r.clock.advance(SPEECH_HANG_CEILING_MS - 1000);
  await expect(held).resolves.toMatchObject({ reason: "timeout" });
  reply(worker, 1);
  await opensFor(r, 5000);
  await inBudget(r, worker);
});
// A job settled in budget always had an in-budget inference, so only a job
// that already timed out can be a miss; these check that queue time is not.
it("does not count a queue-delayed job with an in-time inference as a miss", async () => {
  const r = rig();
  const worker = await r.ready();
  const slow = assessFast(r);
  r.clock.advance(450);
  const delayed = assessFast(r);
  r.clock.advance(150);
  await expect(slow).resolves.toMatchObject({ reason: "timeout" });
  reply(worker, 0);
  r.clock.advance(400);
  await expect(delayed).resolves.toMatchObject({ reason: "timeout" });
  // Dispatched with 350 ms left, a 400 ms inference is in time for the child.
  reply(worker, 1);
  await dispatchedMiss(r, worker);
  await inBudget(r, worker);
});
it("counts an in-budget invalid_input reply as an in-time inference", async () => {
  const r = rig();
  const worker = await r.ready();
  await dispatchedMiss(r, worker);
  const job = assessFast(r);
  reply(worker, 1, {
    kind: "unavailable",
    reason: "invalid_input",
    policyFingerprint: fingerprint,
  });
  await expect(job).resolves.toMatchObject({ reason: "invalid_input" });
  await dispatchedMiss(r, worker);
  await inBudget(r, worker);
});
it("opens only the fast breaker when 0.6 s inferences miss fast budgets but fit slow ones", async () => {
  const r = rig();
  const worker = await r.ready();
  const inference = async (phase: SpeechPhase) => {
    const job = r.detector.assess(Uint8Array.of(1), phase);
    r.clock.advance(600);
    reply(worker, worker.requests.length - 1);
    return job;
  };
  await expect(inference("fast")).resolves.toMatchObject({ reason: "timeout" });
  await expect(inference("fast")).resolves.toMatchObject({ reason: "timeout" });
  await refused(r, "fast");
  for (let i = 0; i < 3; i++)
    await expect(inference("slow")).resolves.toEqual(scored);
  await refused(r, "fast");
});
it("refuses a second arrival in the probing phase only", async () => {
  const r = rig();
  const worker = await r.ready();
  await dispatchedMiss(r, worker);
  await dispatchedMiss(r, worker);
  await opensFor(r, 5000);
  const probe = assessFast(r);
  await refused(r, "fast");
  const slow = r.detector.assess(Uint8Array.of(2), "slow");
  expect(await settled(slow)).toBe(false);
  reply(worker, 2);
  await expect(probe).resolves.toEqual(scored);
  reply(worker, 3);
  await expect(slow).resolves.toEqual(scored);
  await inBudget(r, worker);
});
it("settles a phase's queued jobs as not_ready when its breaker opens", async () => {
  const r = rig();
  const worker = await r.ready();
  await dispatchedMiss(r, worker, "slow");
  const held = r.detector.assess(Uint8Array.of(1), "slow");
  r.clock.advance(1400);
  const queuedSlow = r.detector.assess(Uint8Array.of(2), "slow");
  const queuedFast = assessFast(r);
  r.clock.advance(101);
  reply(worker, 1);
  await expect(held).resolves.toMatchObject({ reason: "timeout" });
  await expect(queuedSlow).resolves.toMatchObject({ reason: "not_ready" });
  expect(worker.requests).toHaveLength(3);
  reply(worker, 2);
  await expect(queuedFast).resolves.toEqual(scored);
  await refused(r, "slow");
});
/** The request id the child was sent at `index`. */
const sentId = (worker: ControlledSpeechWorker, index: number) =>
  worker.requests[index].requestId;
/** A slow job that runs for `ms`, so the last inference time becomes `ms`. */
async function lastInferenceTakes<T>(
  r: Rig,
  worker: ControlledSpeechWorker,
  ms: number,
  queue: () => T,
): Promise<T> {
  const index = worker.requests.length;
  const running = r.detector.assess(Uint8Array.of(9), "slow");
  const queued = queue();
  r.clock.advance(ms);
  reply(worker, index);
  await expect(running).resolves.toEqual(scored);
  return queued;
}
it("serves a fast job before a slow one with slack, so both finish", async () => {
  const r = rig();
  const worker = await r.ready();
  const [fast, slow] = await lastInferenceTakes(r, worker, 200, () => [
    assessFast(r),
    r.detector.assess(Uint8Array.of(2), "slow"),
  ]);
  expect(sentId(worker, 1)).toBe(sentId(worker, 0) + 1);
  r.clock.advance(200);
  reply(worker, 1);
  await expect(fast).resolves.toEqual(scored);
  r.clock.advance(200);
  reply(worker, 2);
  await expect(slow).resolves.toEqual(scored);
});
it("skips a job that cannot finish by the last inference time for a later feasible one", async () => {
  const r = rig();
  const worker = await r.ready();
  await lastInferenceTakes(r, worker, 400, () => {
    void assessFast(r);
    void r.detector.assess(Uint8Array.of(2), "slow");
  });
  expect(sentId(worker, 1)).toBe(sentId(worker, 0) + 2);
});
it("runs the latest deadline when nothing is feasible, then uses the refreshed estimate", async () => {
  const r = rig();
  const worker = await r.ready();
  const running = r.detector.assess(Uint8Array.of(9), "slow");
  r.clock.advance(800);
  void assessFast(r);
  r.clock.advance(200);
  void assessFast(r);
  r.clock.advance(200);
  reply(worker, 0);
  await expect(running).resolves.toEqual(scored);
  // A 1200 ms estimate leaves both fast jobs infeasible; the later one runs.
  expect(sentId(worker, 1)).toBe(sentId(worker, 0) + 2);
  r.clock.advance(50);
  const fast = assessFast(r);
  void r.detector.assess(Uint8Array.of(3), "slow");
  r.clock.advance(50);
  // That 100 ms inference refreshes the estimate, so the new fast job is feasible.
  reply(worker, 1);
  expect(sentId(worker, 2)).toBe(sentId(worker, 0) + 3);
  reply(worker, 2);
  await expect(fast).resolves.toEqual(scored);
});
type LoadPlan = {
  inferenceMs: number;
  stepMs: number;
  steps: number;
  arrival: (step: number) => SpeechPhase | undefined;
};
/** Drives arrivals against a child with a fixed inference time. */
function runLoad(r: Rig, worker: ControlledSpeechWorker, plan: LoadPlan) {
  const results: Promise<SpeechAssessment>[] = [];
  const dispatchedAt: number[] = [];
  const record = () => {
    while (dispatchedAt.length < worker.requests.length)
      dispatchedAt.push(r.clock.now());
  };
  let replied = 0;
  for (let step = 0; step < plan.steps; step++) {
    const phase = plan.arrival(step);
    if (phase) results.push(r.detector.assess(Uint8Array.of(1), phase));
    record();
    if (
      replied < worker.requests.length &&
      r.clock.now() >= dispatchedAt[replied] + plan.inferenceMs
    )
      reply(worker, replied++);
    record();
    r.clock.advance(plan.stepMs);
  }
  return { results: Promise.all(results), dispatchedAt };
}
const kinds = (results: SpeechAssessment[]) =>
  results.map((result) =>
    result.kind === "unavailable" ? result.reason : result.kind,
  );
it("serves a five-snippet burst within 100 ms in full", async () => {
  const r = rig();
  const worker = await r.ready();
  const { results } = runLoad(r, worker, {
    inferenceMs: 100,
    stepMs: 25,
    steps: 40,
    arrival: (step) => (step < 5 ? "fast" : undefined),
  });
  expect(kinds(await results)).toEqual(Array(5).fill("non_speech"));
});
it("never opens a breaker under mixed-phase steady load with in-time inferences", async () => {
  const r = rig();
  const worker = await r.ready();
  const { results } = runLoad(r, worker, {
    inferenceMs: 300,
    stepMs: 100,
    steps: 630,
    arrival: (step) =>
      step >= 600 || step % 3 ? undefined : step % 6 ? "slow" : "fast",
  });
  const outcomes = kinds(await results);
  expect(outcomes).not.toContain("not_ready");
  expect(
    outcomes.filter((kind) => kind === "non_speech").length,
  ).toBeGreaterThan(outcomes.length / 2);
});
it("bounds dispatches under a persistent 5 s inference to about one per 35 s", async () => {
  const r = rig();
  const worker = await r.ready();
  const { dispatchedAt } = runLoad(r, worker, {
    inferenceMs: 5000,
    stepMs: 100,
    steps: 3000,
    arrival: (step) => (step % 3 ? undefined : "fast"),
  });
  const lastMinute = dispatchedAt.filter((at) => at >= r.clock.now() - 60000);
  expect(lastMinute.length).toBeLessThanOrEqual(2);
  expect(dispatchedAt.length).toBeLessThanOrEqual(12);
  expect(worker.terminated).toBe(false);
});
it("opens both breakers at once when both phases miss", async () => {
  const r = rig();
  const worker = await r.ready();
  for (const phase of ["fast", "fast", "slow", "slow"] as const)
    await dispatchedMiss(r, worker, phase);
  await refused(r, "fast");
  await refused(r, "slow");
  expect(worker.terminated).toBe(false);
});
it.each<[string, (r: Rig) => void]>([
  ["timeout", (r) => r.clock.advance(500)],
  [
    "queue_full",
    (r) => {
      for (let i = 0; i < 4; i++)
        void r.detector.assess(Uint8Array.of(3), "slow");
    },
  ],
])(
  "lets the next arrival probe after a queued probe is lost to %s",
  async (reason, lose) => {
    const r = rig();
    const worker = await r.ready();
    await dispatchedMiss(r, worker);
    await dispatchedMiss(r, worker);
    await opensFor(r, 5000);
    const holder = worker.requests.length;
    void r.detector.assess(Uint8Array.of(2), "slow");
    const probe = assessFast(r);
    lose(r);
    await expect(probe).resolves.toMatchObject({ reason });
    // The next arrival is admitted as the new probe, so a further one waits.
    expect(await settled(assessFast(r))).toBe(false);
    await refused(r);
    expect(worker.requests).toHaveLength(holder + 1);
  },
);
it("drops the queued job with the earliest deadline when the queue is full", async () => {
  const r = rig();
  const worker = await r.ready();
  void r.detector.assess(Uint8Array.of(1), "slow");
  const queuedSlow = r.detector.assess(Uint8Array.of(2), "slow");
  const queuedFast = assessFast(r);
  for (let i = 0; i < 2; i++) void r.detector.assess(Uint8Array.of(3), "slow");
  void r.detector.assess(Uint8Array.of(4), "slow");
  await expect(queuedFast).resolves.toMatchObject({ reason: "queue_full" });
  expect(await settled(queuedSlow)).toBe(false);
  expect(worker.requests).toHaveLength(1);
});
it("resets the miss count and escalation when the child retires", async () => {
  const r = rig();
  const hung = await r.ready();
  await dispatchedMiss(r, hung);
  await dispatchedMiss(r, hung);
  await opensFor(r, 5000);
  const probe = assessFast(r);
  r.clock.advance(SPEECH_HANG_CEILING_MS);
  await expect(probe).resolves.toMatchObject({ reason: "timeout" });
  expect(hung.terminated).toBe(true);
  r.clock.advance(30000);
  const worker = await r.ready();
  await dispatchedMiss(r, worker);
  await dispatchedMiss(r, worker);
  await opensFor(r, 5000);
  await inBudget(r, worker);
});
type MetricCase = (
  r: Rig,
  worker: ControlledSpeechWorker,
) => Promise<() => Promise<unknown>>;
it.each<[string, MetricCase, number]>([
  [
    "breaker refusal",
    async (r, worker) => {
      await dispatchedMiss(r, worker);
      await dispatchedMiss(r, worker);
      return () => assessFast(r);
    },
    1,
  ],
  [
    "queue_full",
    async (r) => {
      const [, oldest] = Array.from({ length: 5 }, () => assessFast(r));
      return async () => {
        void assessFast(r);
        await oldest;
      };
    },
    1,
  ],
  [
    "timeout",
    async (r) => async () => {
      const job = assessFast(r);
      r.clock.advance(500);
      await job;
    },
    1,
  ],
  [
    "shutdown",
    async (r) => {
      await r.detector.shutdown();
      return () => assessFast(r);
    },
    1,
  ],
  ...(["invalid_input", "channel_cancellation"] as const).map(
    (reason): [string, MetricCase, number] => [
      `${reason} from the child`,
      async (r, worker) => async () => {
        const job = assessFast(r);
        reply(worker, worker.requests.length - 1, {
          kind: "unavailable",
          reason,
          policyFingerprint: fingerprint,
        });
        await job;
      },
      0,
    ],
  ),
])(
  "counts a %s result as attempted once",
  async (_, prepare, unavailableCount) => {
    const count = countMetric();
    const r = rig();
    const worker = await r.ready();
    const call = await prepare(r, worker);
    const before = {
      attempted: count("SpeechAssessmentAttempted"),
      unavailable: count("SpeechAssessmentUnavailable"),
    };
    await call();
    expect(count("SpeechAssessmentAttempted") - before.attempted).toBe(1);
    expect(count("SpeechAssessmentUnavailable") - before.unavailable).toBe(
      unavailableCount,
    );
  },
);
