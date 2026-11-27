/** @jest-environment node */
import {
  SPEECH_HANG_CEILING_MS,
  createSpeechDetector,
} from "../../src/services/speechDetectionService";
import { DEFAULT_SPEECH_POLICY } from "../../src/services/speechDetectionPolicy";
import type { SpeechPhase } from "../../src/services/speechDetectionTypes";
import {
  ControlledSpeechWorker,
  FakeSpeechClock,
} from "../helpers/speechDetectionHarness";
import { metricsRegistry } from "../../src/metrics";

it("settlesTimedOutWorkWithoutRejectingSpeech", async () => {
  const clock = new FakeSpeechClock();
  const worker = new ControlledSpeechWorker();
  const detector = createSpeechDetector({
    policy: DEFAULT_SPEECH_POLICY,
    spawn: () => worker,
    now: clock.now,
    schedule: clock.schedule,
  });
  const warm = detector.warm();
  worker.reply({
    type: "ready",
    policyFingerprint: DEFAULT_SPEECH_POLICY.policyFingerprint,
  });
  expect(await warm).toBe(true);
  const pending = detector.assess(Uint8Array.of(1, 2), "fast");
  clock.advance(500);
  await expect(pending).resolves.toMatchObject({
    kind: "unavailable",
    reason: "timeout",
  });
  await detector.shutdown();
});

const fingerprint = DEFAULT_SPEECH_POLICY.policyFingerprint;
const scored = {
  kind: "non_speech",
  policyFingerprint: fingerprint,
  metrics: {
    peakSpeechProbability: 0.01,
    maxConsecutiveSpeechFrames: 0,
    scannedFrames: 1,
    totalFrames: 1,
    gain: 1,
  },
} satisfies import("../../src/services/speechDetectionTypes").SpeechAssessment;
const rigs: ReturnType<typeof rig>[] = [];
function rig() {
  const clock = new FakeSpeechClock();
  const workers: ControlledSpeechWorker[] = [];
  const detector = createSpeechDetector({
    policy: DEFAULT_SPEECH_POLICY,
    spawn: () => {
      const worker = new ControlledSpeechWorker();
      workers.push(worker);
      return worker;
    },
    now: clock.now,
    schedule: clock.schedule,
  });
  const result = {
    clock,
    workers,
    detector,
    async ready() {
      const warm = detector.warm();
      const worker = workers[workers.length - 1];
      worker.reply({ type: "ready", policyFingerprint: fingerprint });
      expect(await warm).toBe(true);
      return worker;
    },
  };
  rigs.push(result);
  return result;
}
const speech = {
  kind: "speech",
  policyFingerprint: fingerprint,
  metrics: {
    ...scored.metrics,
    peakSpeechProbability: 0.9,
    maxConsecutiveSpeechFrames: 2,
    scannedFrames: 2,
    totalFrames: 2,
  },
} satisfies import("../../src/services/speechDetectionTypes").SpeechAssessment;
function reply(
  worker: ControlledSpeechWorker,
  index: number,
  assessment: import("../../src/services/speechDetectionTypes").SpeechAssessment = scored,
) {
  worker.reply({
    type: "assessment",
    requestId: worker.requests[index].requestId,
    assessment,
  });
}
/** Counts the metric lines the detector writes, by metric name. */
function countMetric() {
  process.env.METRICS_NAMESPACE = "meeting-notes-test/Lifecycle";
  const write = jest.spyOn(process.stdout, "write").mockReturnValue(true);
  return (name: string) =>
    write.mock.calls.filter(([line]) => String(line).includes(`"${name}":1`))
      .length;
}
/** Whether a promise has settled, without advancing the fake clock. */
async function settled(promise: Promise<unknown>) {
  let done = false;
  void promise.then(() => {
    done = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  return done;
}
afterEach(async () => {
  delete process.env.METRICS_NAMESPACE;
  jest.restoreAllMocks();
  for (const { detector, clock } of rigs.splice(0)) {
    await detector.shutdown();
    expect(clock.pendingTimers).toBe(0);
  }
});

it("starts lazily and returns immediately while not ready", async () => {
  const { detector, workers } = rig();
  expect(workers).toHaveLength(0);
  await expect(
    detector.assess(Uint8Array.of(1), "fast"),
  ).resolves.toMatchObject({ kind: "unavailable", reason: "not_ready" });
  expect(workers).toHaveLength(1);
});
it("drops the oldest of four waiting jobs as queue_full to admit a new arrival", async () => {
  const r = rig();
  const worker = await r.ready();
  const [active, oldest, ...rest] = Array.from({ length: 5 }, () =>
    r.detector.assess(Uint8Array.of(1), "slow"),
  );
  const newest = r.detector.assess(Uint8Array.of(1), "slow");
  await expect(oldest).resolves.toMatchObject({
    kind: "unavailable",
    reason: "queue_full",
  });
  expect(worker.requests).toHaveLength(1);
  const jobs = [active, ...rest, newest];
  for (let i = 0; i < 5; i++) {
    worker.reply({
      type: "assessment",
      requestId: worker.requests[i].requestId,
      assessment: scored,
    });
  }
  expect((await Promise.all(jobs)).map((x) => x.kind)).toEqual(
    Array(5).fill("non_speech"),
  );
});
it.each(["fast", "slow"] as const)(
  "answers every %s caller within its budget and never dispatches an expired queued job",
  async (phase) => {
    const r = rig();
    const worker = await r.ready();
    const budget = phase === "fast" ? 500 : 1500;
    const jobs = Array.from({ length: 4 }, () =>
      r.detector.assess(Uint8Array.of(1), phase),
    );
    r.clock.advance(budget - 1);
    expect(await settled(jobs[0])).toBe(false);
    r.clock.advance(1);
    expect((await Promise.all(jobs)).map((job) => job.kind)).toEqual(
      Array(jobs.length).fill("unavailable"),
    );
    reply(worker, 0);
    expect(worker.requests).toHaveLength(1);
    expect(worker.terminated).toBe(false);
  },
);
it("counts the budget from enqueue, including time spent queued", async () => {
  const r = rig();
  const worker = await r.ready();
  const first = r.detector.assess(Uint8Array.of(1), "slow");
  r.clock.advance(100);
  const second = r.detector.assess(Uint8Array.of(2), "slow");
  r.clock.advance(1300);
  reply(worker, 0);
  await expect(first).resolves.toEqual(scored);
  expect(worker.requests).toHaveLength(2);
  r.clock.advance(199);
  expect(await settled(second)).toBe(false);
  r.clock.advance(1);
  await expect(second).resolves.toMatchObject({ reason: "timeout" });
  expect(worker.terminated).toBe(false);
});
it("times out a slow running job alone and completes the next job on the same child", async () => {
  const r = rig();
  const worker = await r.ready();
  const slow = r.detector.assess(Uint8Array.of(1), "fast");
  r.clock.advance(500);
  await expect(slow).resolves.toMatchObject({ reason: "timeout" });
  const next = r.detector.assess(Uint8Array.of(2), "fast");
  expect(worker.terminated).toBe(false);
  // The child is still busy with the timed-out job, so nothing else is sent.
  expect(worker.requests).toHaveLength(1);
  reply(worker, 0, speech);
  expect(worker.requests).toHaveLength(2);
  reply(worker, 1);
  await expect(next).resolves.toEqual(scored);
  expect(r.workers).toHaveLength(1);
});
it("ignores a late reply for a timed-out job so it cannot answer the next job", async () => {
  const r = rig();
  const worker = await r.ready();
  const timedOut = r.detector.assess(Uint8Array.of(1), "fast");
  r.clock.advance(500);
  await expect(timedOut).resolves.toMatchObject({ reason: "timeout" });
  reply(worker, 0);
  const next = r.detector.assess(Uint8Array.of(2), "fast");
  // A duplicate of the stale reply carries the old id, never the next job's.
  reply(worker, 0, speech);
  reply(worker, 1);
  await expect(next).resolves.toEqual(scored);
  expect(worker.terminated).toBe(false);
});
type Rig = ReturnType<typeof rig>;
const assessFast = (r: Rig) => r.detector.assess(Uint8Array.of(1), "fast");
const budgetOf = { fast: 500, slow: 1500 } as const;
/** One dispatched job whose inference outlives its phase budget, then replies late. */
async function dispatchedMiss(
  r: Rig,
  worker: ControlledSpeechWorker,
  phase: SpeechPhase = "fast",
) {
  const index = worker.requests.length;
  const job = r.detector.assess(Uint8Array.of(1), phase);
  expect(worker.requests).toHaveLength(index + 1);
  r.clock.advance(budgetOf[phase]);
  await expect(job).resolves.toMatchObject({ reason: "timeout" });
  r.clock.advance(1);
  reply(worker, index);
}
async function inBudget(
  r: Rig,
  worker: ControlledSpeechWorker,
  phase: SpeechPhase = "fast",
) {
  const job = r.detector.assess(Uint8Array.of(1), phase);
  reply(worker, worker.requests.length - 1);
  await expect(job).resolves.toEqual(scored);
}
async function refused(r: Rig, phase: SpeechPhase = "fast") {
  await expect(
    r.detector.assess(Uint8Array.of(1), phase),
  ).resolves.toMatchObject({ reason: "not_ready" });
}
/** The breaker stays open for `windowMs` from now, then admits a probe. */
async function opensFor(r: Rig, windowMs: number) {
  r.clock.advance(windowMs - 1);
  await refused(r);
  r.clock.advance(1);
}
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
it("dispatches the queued job with the most budget left, newest on ties", async () => {
  const r = rig();
  const worker = await r.ready();
  void r.detector.assess(Uint8Array.of(1), "slow");
  for (let i = 0; i < 3; i++) void r.detector.assess(Uint8Array.of(1), "slow");
  for (let i = 0; i < 4; i++) reply(worker, i);
  const first = worker.requests[0].requestId;
  expect(worker.requests.map((request) => request.requestId)).toEqual([
    first,
    first + 3,
    first + 2,
    first + 1,
  ]);
});
it("dispatches an older slow job before a newer fast one with less budget left", async () => {
  const r = rig();
  const worker = await r.ready();
  void r.detector.assess(Uint8Array.of(1), "slow");
  const slow = r.detector.assess(Uint8Array.of(2), "slow");
  r.clock.advance(100);
  const fast = assessFast(r);
  reply(worker, 0);
  expect(worker.requests[1].requestId).toBe(worker.requests[0].requestId + 1);
  reply(worker, 1);
  await expect(slow).resolves.toEqual(scored);
  reply(worker, 2);
  await expect(fast).resolves.toEqual(scored);
});
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
it("bounds dispatches under a persistent 5 s inference to about one per 35 s", async () => {
  const r = rig();
  const worker = await r.ready();
  const inferenceMs = 5000;
  const dispatchedAt: number[] = [];
  const record = () => {
    while (dispatchedAt.length < worker.requests.length)
      dispatchedAt.push(r.clock.now());
  };
  let replied = 0;
  for (let step = 0; step < 3000; step++) {
    if (step % 3 === 0) void assessFast(r);
    record();
    if (
      replied < worker.requests.length &&
      r.clock.now() >= dispatchedAt[replied] + inferenceMs
    )
      reply(worker, replied++);
    record();
    r.clock.advance(100);
  }
  const lastMinute = dispatchedAt.filter((at) => at >= r.clock.now() - 60000);
  expect(lastMinute.length).toBeLessThanOrEqual(2);
  expect(dispatchedAt.length).toBeLessThanOrEqual(12);
  expect(worker.terminated).toBe(false);
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
  [
    "invalid_input from the child",
    async (r, worker) => async () => {
      const job = assessFast(r);
      reply(worker, worker.requests.length - 1, {
        kind: "unavailable",
        reason: "invalid_input",
        policyFingerprint: fingerprint,
      });
      await job;
    },
    0,
  ],
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
it("retires a hung child exactly once and recovers the queue after respawn", async () => {
  const count = countMetric();
  const r = rig();
  const hung = await r.ready();
  const first = r.detector.assess(Uint8Array.of(1), "fast");
  r.clock.advance(SPEECH_HANG_CEILING_MS - 200);
  const queued = r.detector.assess(Uint8Array.of(2), "fast");
  r.clock.advance(200);
  await expect(first).resolves.toMatchObject({ reason: "timeout" });
  await expect(queued).resolves.toMatchObject({
    kind: "unavailable",
    reason: "timeout",
  });
  expect(hung.terminated).toBe(true);
  expect(count("SpeechDetectorRetired")).toBe(1);
  reply(hung, 0);
  r.clock.advance(SPEECH_HANG_CEILING_MS);
  r.clock.advance(30000);
  const worker = await r.ready();
  const job = r.detector.assess(Uint8Array.of(3), "fast");
  reply(worker, 0);
  await expect(job).resolves.toEqual(scored);
  r.clock.advance(SPEECH_HANG_CEILING_MS);
  expect(worker.terminated).toBe(false);
  expect(r.workers).toHaveLength(2);
  expect(count("SpeechDetectorRetired")).toBe(1);
});
it("settles every pending job on worker crash", async () => {
  const r = rig();
  const worker = await r.ready();
  const jobs = Array.from({ length: 5 }, () =>
    r.detector.assess(Uint8Array.of(1), "slow"),
  );
  worker.fail("worker_error");
  expect((await Promise.all(jobs)).map((x) => x.kind)).toEqual(
    Array(5).fill("unavailable"),
  );
});
it("settles pending readiness and all jobs on shutdown without restarting", async () => {
  const r = rig();
  const worker = await r.ready();
  const jobs = Array.from({ length: 5 }, () =>
    r.detector.assess(Uint8Array.of(1), "slow"),
  );
  await r.detector.shutdown();
  expect(worker.terminated).toBe(true);
  expect((await Promise.all(jobs)).map((x) => x.kind)).toEqual(
    Array(5).fill("unavailable"),
  );
  await expect(r.detector.warm()).resolves.toBe(false);
  await expect(
    r.detector.assess(Uint8Array.of(1), "fast"),
  ).resolves.toMatchObject({ reason: "shutdown" });
  expect(r.workers).toHaveLength(1);
  const cold = rig();
  const warming = cold.detector.warm();
  await cold.detector.shutdown();
  await expect(warming).resolves.toBe(false);
});
it("doesNotRestartDuringCooldown", async () => {
  metricsRegistry.resetMetrics();
  const r = rig();
  const worker = await r.ready();
  const job = r.detector.assess(Uint8Array.of(1), "fast");
  r.clock.advance(SPEECH_HANG_CEILING_MS);
  await expect(job).resolves.toMatchObject({ reason: "timeout" });
  for (let i = 0; i < 3; i++) {
    r.clock.advance(9999);
    await expect(
      r.detector.assess(Uint8Array.of(1), "fast"),
    ).resolves.toMatchObject({ reason: "not_ready" });
    await expect(r.detector.warm()).resolves.toBe(false);
  }
  expect(r.workers).toHaveLength(1);
  expect(
    (
      await metricsRegistry
        .getSingleMetric("chronote_speech_detection_worker_restarts_total")
        ?.get()
    )?.values[0].value,
  ).toBe(0);
  r.clock.advance(3);
  const ready = r.detector.warm();
  expect(r.workers).toHaveLength(2);
  expect(
    (
      await metricsRegistry
        .getSingleMetric("chronote_speech_detection_worker_restarts_total")
        ?.get()
    )?.values[0].value,
  ).toBe(1);
  worker.reply({
    type: "assessment",
    requestId: worker.requests[0].requestId,
    assessment: scored,
  });
  r.workers[1].reply({ type: "ready", policyFingerprint: fingerprint });
  await expect(ready).resolves.toBe(true);
});

it("does not load an ONNX runtime or spawn when imported, obtained or shut down unused", async () => {
  const workerSpawn = jest.fn(() => {
    throw Error("Unexpected worker creation");
  });
  const runtimeLoad = jest.fn(() => {
    throw Error("Unexpected ONNX import");
  });
  jest.doMock("node:child_process", () => ({ fork: workerSpawn }));
  jest.doMock("onnxruntime-node", runtimeLoad);
  try {
    await jest.isolateModulesAsync(async () => {
      const { getSpeechDetector, shutdownSpeechDetector } =
        await import("../../src/services/speechDetectionService");
      getSpeechDetector();
      await shutdownSpeechDetector();
    });
    expect(workerSpawn).not.toHaveBeenCalled();
    expect(runtimeLoad).not.toHaveBeenCalled();
  } finally {
    jest.dontMock("node:child_process");
    jest.dontMock("onnxruntime-node");
  }
});
it.each(["asset_error", "worker_error"] as const)(
  "cools down after initialization %s",
  async (reason) => {
    const r = rig();
    const warm = r.detector.warm();
    r.workers[0].fail(reason);
    await expect(warm).resolves.toBe(false);
    await expect(r.detector.warm()).resolves.toBe(false);
    expect(r.workers).toHaveLength(1);
    r.clock.advance(30000);
    await r.ready();
    expect(r.workers).toHaveLength(2);
  },
);
it("bounds initialization to 30 seconds and cancels its timer on ready", async () => {
  const r = rig();
  const warm = r.detector.warm();
  r.clock.advance(29999);
  expect(r.workers[0].terminated).toBe(false);
  r.clock.advance(1);
  await expect(warm).resolves.toBe(false);
  expect(r.workers[0].terminated).toBe(true);
  r.clock.advance(30000);
  await r.ready();
  expect(r.clock.pendingTimers).toBe(0);
});
it("rejects a mismatched ready fingerprint and assessment policy", async () => {
  const r = rig();
  const warm = r.detector.warm();
  r.workers[0].reply({ type: "ready", policyFingerprint: "wrong" });
  await expect(warm).resolves.toBe(false);
  r.clock.advance(30000);
  const worker = await r.ready();
  const job = r.detector.assess(Uint8Array.of(1), "fast");
  worker.reply({
    type: "assessment",
    requestId: worker.requests[0].requestId,
    assessment: { ...scored, policyFingerprint: "wrong" },
  });
  await expect(job).resolves.toMatchObject({
    kind: "unavailable",
    reason: "invalid_output",
  });
});
it("rejects malformed scores instead of treating them as nonspeech", async () => {
  const r = rig();
  const worker = await r.ready();
  const job = r.detector.assess(Uint8Array.of(1), "fast");
  worker.reply({
    type: "assessment",
    requestId: worker.requests[0].requestId,
    assessment: {
      ...scored,
      metrics: { ...scored.metrics, peakSpeechProbability: NaN },
    },
  });
  await expect(job).resolves.toMatchObject({
    kind: "unavailable",
    reason: "invalid_output",
  });
});
it("copies owned WAV bytes before transfer without changing caller PCM", async () => {
  const r = rig();
  const worker = await r.ready();
  const pcm = Buffer.from([1, 2, 3, 4]);
  const wav = pcm.subarray(1, 3);
  const job = r.detector.assess(wav, "fast");
  const transferred = structuredClone(worker.requests[0].wav, {
    transfer: [worker.requests[0].wav],
  });
  expect(pcm).toEqual(Buffer.from([1, 2, 3, 4]));
  expect(wav).toEqual(Buffer.from([2, 3]));
  expect(new Uint8Array(transferred)).toEqual(Uint8Array.of(2, 3));
  worker.reply({
    type: "assessment",
    requestId: worker.requests[0].requestId,
    assessment: scored,
  });
  await job;
});

it("ignores a captured reply from a retired generation even with a current request ID", async () => {
  const r = rig();
  const old = await r.ready();
  const replay = old.captureReplies();
  const abandoned = r.detector.assess(Uint8Array.of(1), "fast");
  r.clock.advance(SPEECH_HANG_CEILING_MS);
  await abandoned;
  r.clock.advance(30000);
  const current = await r.ready();
  const job = r.detector.assess(Uint8Array.of(2), "fast");
  replay({
    type: "assessment",
    requestId: current.requests[0].requestId,
    assessment: scored,
  });
  current.reply({
    type: "assessment",
    requestId: current.requests[0].requestId,
    assessment: {
      kind: "speech",
      policyFingerprint: fingerprint,
      metrics: {
        ...scored.metrics,
        peakSpeechProbability: 0.9,
        maxConsecutiveSpeechFrames: 2,
        scannedFrames: 2,
        totalFrames: 2,
      },
    },
  });
  await expect(job).resolves.toMatchObject({ kind: "speech" });
});
it("does not create a worker when a never-started detector shuts down", async () => {
  const r = rig();
  await r.detector.shutdown();
  expect(r.workers).toHaveLength(0);
  await expect(r.detector.warm()).resolves.toBe(false);
});
it("cools down a synchronous spawn failure without rejecting callers", async () => {
  const clock = new FakeSpeechClock();
  let spawns = 0;
  const detector = createSpeechDetector({
    policy: DEFAULT_SPEECH_POLICY,
    spawn() {
      spawns++;
      throw Error("spawn failed");
    },
    now: clock.now,
    schedule: clock.schedule,
  });
  await expect(detector.warm()).resolves.toBe(false);
  await expect(
    detector.assess(Uint8Array.of(1), "fast"),
  ).resolves.toMatchObject({ reason: "not_ready" });
  expect(spawns).toBe(1);
  clock.advance(30000);
  await expect(detector.warm()).resolves.toBe(false);
  expect(spawns).toBe(2);
  await detector.shutdown();
});
it("retires a session returning engine failure before accepting more work", async () => {
  const r = rig();
  const worker = await r.ready();
  const job = r.detector.assess(Uint8Array.of(1), "fast");
  worker.reply({
    type: "assessment",
    requestId: worker.requests[0].requestId,
    assessment: {
      kind: "unavailable",
      reason: "worker_error",
      policyFingerprint: fingerprint,
    },
  });
  await expect(job).resolves.toMatchObject({ reason: "worker_error" });
  await expect(
    r.detector.assess(Uint8Array.of(2), "fast"),
  ).resolves.toMatchObject({ reason: "not_ready" });
  expect(worker.terminated).toBe(true);
});

it("rejects a late negative reply without retiring, even when the main thread has not fired its timer", async () => {
  const r = rig();
  const worker = await r.ready();
  const job = r.detector.assess(Uint8Array.of(1), "fast");
  r.clock.elapseWithoutTimers(500);
  worker.reply({
    type: "assessment",
    requestId: worker.requests[0].requestId,
    assessment: scored,
  });
  await expect(job).resolves.toMatchObject({ reason: "timeout" });
  expect(worker.terminated).toBe(false);
});
it("does not dispatch queued work after its budget", async () => {
  const r = rig();
  const worker = await r.ready();
  const active = r.detector.assess(Uint8Array.of(1), "slow");
  const queued = r.detector.assess(Uint8Array.of(2), "fast");
  r.clock.elapseWithoutTimers(600);
  reply(worker, 0);
  await expect(active).resolves.toEqual(scored);
  await expect(queued).resolves.toMatchObject({ reason: "timeout" });
  expect(worker.requests).toHaveLength(1);
});
it("does not accept readiness after the absolute initialization deadline", async () => {
  const r = rig();
  const warm = r.detector.warm();
  r.clock.elapseWithoutTimers(30000);
  r.workers[0].reply({ type: "ready", policyFingerprint: fingerprint });
  await expect(warm).resolves.toBe(false);
});

it("accepts partial positive proof while rejecting partial negative scans", async () => {
  const r = rig();
  const worker = await r.ready();
  const positive = r.detector.assess(Uint8Array.of(1), "fast");
  worker.reply({
    type: "assessment",
    requestId: worker.requests[0].requestId,
    assessment: {
      kind: "speech",
      policyFingerprint: fingerprint,
      metrics: {
        ...scored.metrics,
        peakSpeechProbability: 0.5,
        maxConsecutiveSpeechFrames: 2,
        scannedFrames: 2,
        totalFrames: 100,
      },
    },
  });
  await expect(positive).resolves.toMatchObject({ kind: "speech" });
  const negative = r.detector.assess(Uint8Array.of(2), "fast");
  worker.reply({
    type: "assessment",
    requestId: worker.requests[1].requestId,
    assessment: { ...scored, metrics: { ...scored.metrics, totalFrames: 100 } },
  });
  await expect(negative).resolves.toMatchObject({
    kind: "unavailable",
    reason: "invalid_output",
  });
});
