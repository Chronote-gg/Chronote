/** @jest-environment node */
import { createSpeechDetector } from "../../src/services/speechDetectionService";
import { DEFAULT_SPEECH_POLICY } from "../../src/services/speechDetectionPolicy";
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
afterEach(async () => {
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
it("admits one active and four waiting jobs with immediate sixth-job queue_full", async () => {
  const r = rig();
  const worker = await r.ready();
  const jobs = Array.from({ length: 5 }, () =>
    r.detector.assess(Uint8Array.of(1), "slow"),
  );
  await expect(
    r.detector.assess(Uint8Array.of(1), "slow"),
  ).resolves.toMatchObject({ kind: "unavailable", reason: "queue_full" });
  expect(worker.requests).toHaveLength(1);
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
it("removes expired queued work without killing the active worker", async () => {
  const r = rig();
  const worker = await r.ready();
  const active = r.detector.assess(Uint8Array.of(1), "slow");
  const queued = r.detector.assess(Uint8Array.of(2), "fast");
  r.clock.advance(500);
  await expect(queued).resolves.toMatchObject({ reason: "timeout" });
  expect(worker.terminated).toBe(false);
  worker.reply({
    type: "assessment",
    requestId: worker.requests[0].requestId,
    assessment: scored,
  });
  await expect(active).resolves.toEqual(scored);
  expect(worker.requests).toHaveLength(1);
});
it("includes queue time in the slow 1500ms deadline", async () => {
  const r = rig();
  const worker = await r.ready();
  const first = r.detector.assess(Uint8Array.of(1), "slow");
  r.clock.advance(100);
  const second = r.detector.assess(Uint8Array.of(2), "slow");
  r.clock.advance(1300);
  worker.reply({
    type: "assessment",
    requestId: worker.requests[0].requestId,
    assessment: scored,
  });
  await expect(first).resolves.toEqual(scored);
  r.clock.advance(199);
  expect(worker.terminated).toBe(false);
  r.clock.advance(1);
  await expect(second).resolves.toMatchObject({ reason: "timeout" });
  expect(worker.terminated).toBe(true);
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
  r.clock.advance(500);
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
  jest.doMock("onnxruntime-web", runtimeLoad);
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
    jest.dontMock("onnxruntime-web");
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
  r.clock.advance(500);
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

it("rejects a late negative reply even when the main thread has not fired its timer", async () => {
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
  expect(worker.terminated).toBe(true);
});
it("does not dispatch queued work after its absolute deadline", async () => {
  const r = rig();
  const worker = await r.ready();
  const active = r.detector.assess(Uint8Array.of(1), "slow");
  const queued = r.detector.assess(Uint8Array.of(2), "fast");
  r.clock.elapseWithoutTimers(600);
  worker.reply({
    type: "assessment",
    requestId: worker.requests[0].requestId,
    assessment: scored,
  });
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
