import { afterEach, expect, jest } from "@jest/globals";
import { createSpeechDetector } from "../../src/services/speechDetectionService";
import { DEFAULT_SPEECH_POLICY } from "../../src/services/speechDetectionPolicy";
import type {
  SpeechAssessment,
  SpeechPhase,
} from "../../src/services/speechDetectionTypes";
import {
  ControlledSpeechWorker,
  FakeSpeechClock,
} from "./speechDetectionHarness";

// Shared by the speech detector test files. Importing this registers an
// afterEach that shuts every rig down and checks no timer is left pending.
export const fingerprint = DEFAULT_SPEECH_POLICY.policyFingerprint;
export const scored = {
  kind: "non_speech",
  policyFingerprint: fingerprint,
  metrics: {
    peakSpeechProbability: 0.01,
    maxConsecutiveSpeechFrames: 0,
    scannedFrames: 1,
    totalFrames: 1,
    gain: 1,
  },
} satisfies SpeechAssessment;
const rigs: ReturnType<typeof rig>[] = [];
export function rig() {
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
export const speech = {
  kind: "speech",
  policyFingerprint: fingerprint,
  metrics: {
    ...scored.metrics,
    peakSpeechProbability: 0.9,
    maxConsecutiveSpeechFrames: 2,
    scannedFrames: 2,
    totalFrames: 2,
  },
} satisfies SpeechAssessment;
export function reply(
  worker: ControlledSpeechWorker,
  index: number,
  assessment: SpeechAssessment = scored,
) {
  worker.reply({
    type: "assessment",
    requestId: worker.requests[index].requestId,
    assessment,
  });
}
/** Counts the metric lines the detector writes, by metric name. */
export function countMetric() {
  process.env.METRICS_NAMESPACE = "meeting-notes-test/Lifecycle";
  const write = jest.spyOn(process.stdout, "write").mockReturnValue(true);
  return (name: string) =>
    write.mock.calls.filter(([line]) => String(line).includes(`"${name}":1`))
      .length;
}
/** Whether a promise has settled, without advancing the fake clock. */
export async function settled(promise: Promise<unknown>) {
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

export type Rig = ReturnType<typeof rig>;
export const assessFast = (r: Rig) =>
  r.detector.assess(Uint8Array.of(1), "fast");
const budgetOf = { fast: 500, slow: 1500 } as const;
/** One dispatched job whose inference outlives its phase budget, then replies late. */
export async function dispatchedMiss(
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
export async function inBudget(
  r: Rig,
  worker: ControlledSpeechWorker,
  phase: SpeechPhase = "fast",
) {
  const job = r.detector.assess(Uint8Array.of(1), phase);
  reply(worker, worker.requests.length - 1);
  await expect(job).resolves.toEqual(scored);
}
export async function refused(r: Rig, phase: SpeechPhase = "fast") {
  await expect(
    r.detector.assess(Uint8Array.of(1), phase),
  ).resolves.toMatchObject({ reason: "not_ready" });
}
/** The breaker stays open for `windowMs` from now, then admits a probe. */
export async function opensFor(r: Rig, windowMs: number) {
  r.clock.advance(windowMs - 1);
  await refused(r);
  r.clock.advance(1);
}
