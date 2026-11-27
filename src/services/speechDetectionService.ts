import path from "node:path";
import { fork } from "node:child_process";
import { DEFAULT_SPEECH_POLICY } from "./speechDetectionPolicy";
import { recordSpeechWorkerRestart } from "../metrics";
import { emitMetric, LIFECYCLE_METRICS } from "../lifecycleMetrics";
import type {
  SpeechPolicy,
  SpeechWorkerReply,
  SpeechWorkerRequest,
} from "./speechDetectionTypes";
import { z } from "zod";
import type {
  SpeechDetector,
  SpeechDetectorBindings,
  SpeechAssessment,
  SpeechPhase,
  SpeechUnavailableReason,
  SpeechWorkerTransport,
} from "./speechDetectionTypes";

const reasonSchema = z.enum([
  "off",
  "forced",
  "not_ready",
  "queue_full",
  "timeout",
  "worker_error",
  "invalid_input",
  "invalid_output",
  "asset_error",
  "channel_cancellation",
  "shutdown",
]);
const metricsSchema = z
  .object({
    peakSpeechProbability: z.number().min(0).max(1),
    maxConsecutiveSpeechFrames: z.number().int().nonnegative(),
    scannedFrames: z.number().int().positive(),
    totalFrames: z.number().int().positive(),
    gain: z.number().positive().max(100),
  })
  .refine(
    (m) =>
      m.scannedFrames <= m.totalFrames &&
      m.maxConsecutiveSpeechFrames <= m.scannedFrames,
  );
const assessmentSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("unavailable"),
    policyFingerprint: z.string(),
    reason: reasonSchema,
  }),
  z.object({
    kind: z.literal("speech"),
    policyFingerprint: z.string(),
    metrics: metricsSchema,
  }),
  z.object({
    kind: z.literal("non_speech"),
    policyFingerprint: z.string(),
    metrics: metricsSchema,
  }),
  z.object({
    kind: z.literal("uncertain"),
    policyFingerprint: z.string(),
    metrics: metricsSchema,
  }),
]);
const replySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("failure"), reason: reasonSchema }),
  z.object({ type: z.literal("ready"), policyFingerprint: z.string() }),
  z.object({
    type: z.literal("assessment"),
    requestId: z.number().int().positive(),
    assessment: assessmentSchema,
  }),
]);
/**
 * A job's whole budget, queue time included, counted from enqueue: no caller
 * waits longer than this. An expired job fails alone and is never dispatched.
 */
const JOB_BUDGET_MS = { fast: 500, slow: 1500 } as const;
/**
 * Expiries in a row that mean sustained overload rather than one slow
 * inference: a full queue (one running and four waiting) expiring together.
 */
export const SPEECH_SHED_AFTER_EXPIRIES = 5;
/**
 * How long new work is refused once shedding starts, so the child drains its
 * backlog and the CPU is given back. Ten slow budgets; short against the 30 s
 * retirement cooldown, and nothing is killed or reinitialized.
 */
export const SPEECH_SHED_WINDOW_MS = 5000;
/**
 * A running inference past this is hung rather than slow, and only this
 * retires the child. It is twice the slowest measured cold model load (5 s)
 * and over six times the slow inference budget.
 */
export const SPEECH_HANG_CEILING_MS = 10000;
const RETIREMENT_COOLDOWN_MS = 30000;
const INITIALIZATION_DEADLINE_MS = 30000;
const MAX_WAITING_JOBS = 4;
type Timer = ReturnType<SpeechDetectorBindings["schedule"]>;
type Job = {
  requestId: number;
  wav: ArrayBuffer;
  deadline: number;
  resolve: (assessment: SpeechAssessment) => void;
  timer: Timer;
};
/**
 * The child's single slot. It stays occupied until the child replies, even
 * after its job timed out and was settled (`job` cleared), so the late reply
 * is matched by id and discarded instead of answering the next job.
 */
type Running = {
  requestId: number;
  job?: Job;
  hang: Timer;
};
type Generation = {
  transport: SpeechWorkerTransport;
  ready: boolean;
  readiness: Promise<boolean>;
  finishWarm: (ready: boolean) => void;
  initTimer: Timer;
  initDeadline: number;
  detach: (() => void)[];
};

export function createSpeechDetector(
  bindings: SpeechDetectorBindings,
): SpeechDetector {
  let generation: Generation | undefined;
  let running: Running | undefined;
  const waiting: Job[] = [];
  const terminations = new Set<Promise<void>>();
  let nextId = 0;
  let cooldownUntil = 0;
  let shedUntil = 0;
  let consecutiveExpiries = 0;
  let stopped = false;
  let hasStartedWorker = false;
  const unavailable = (reason: SpeechUnavailableReason): SpeechAssessment => ({
    kind: "unavailable",
    reason,
    policyFingerprint: bindings.policy.policyFingerprint,
  });
  const settle = (job: Job, assessment: SpeechAssessment): void => {
    job.timer.cancel();
    job.resolve(assessment);
  };
  const expire = (job: Job): void => {
    settle(job, unavailable("timeout"));
    consecutiveExpiries++;
    if (consecutiveExpiries < SPEECH_SHED_AFTER_EXPIRIES) return;
    consecutiveExpiries = 0;
    shedUntil = bindings.now() + SPEECH_SHED_WINDOW_MS;
  };
  /** Kills the child; every job it holds or has queued fails once with `reason`. */
  const retire = (reason: SpeechUnavailableReason): void => {
    const old = generation;
    generation = undefined;
    cooldownUntil = bindings.now() + RETIREMENT_COOLDOWN_MS;
    if (running) {
      running.hang.cancel();
      if (running.job) settle(running.job, unavailable(reason));
      running = undefined;
    }
    for (const job of waiting.splice(0)) settle(job, unavailable(reason));
    if (!old) return;
    if (reason !== "shutdown")
      emitMetric(LIFECYCLE_METRICS.speechDetectorRetired);
    old.initTimer.cancel();
    old.finishWarm(false);
    for (const detach of old.detach) detach();
    const termination = old.transport.terminate().then(
      () => {
        terminations.delete(termination);
      },
      () => {
        terminations.delete(termination);
      },
    );
    terminations.add(termination);
  };
  const dispatch = (): void => {
    if (!generation?.ready || running) return;
    let job = waiting.shift();
    while (job && bindings.now() >= job.deadline) {
      expire(job);
      job = waiting.shift();
    }
    if (!job) return;
    const slot: Running = {
      requestId: job.requestId,
      job,
      hang: bindings.schedule(() => {
        if (running === slot) retire("timeout");
      }, SPEECH_HANG_CEILING_MS),
    };
    running = slot;
    try {
      generation.transport.post({
        type: "assess",
        requestId: job.requestId,
        wav: job.wav,
        policyFingerprint: bindings.policy.policyFingerprint,
      });
    } catch {
      retire("worker_error");
    }
  };
  /** Frees the slot with the child's reply; a job that already timed out drops it. */
  const acceptAssessment = (
    slot: Running,
    assessment: SpeechAssessment,
  ): void => {
    const engineFailure = engineFailureReason(assessment);
    if (engineFailure) {
      retire(engineFailure);
      return;
    }
    if (!hasValidAssessmentMetrics(assessment, bindings.policy)) {
      retire("invalid_output");
      return;
    }
    slot.hang.cancel();
    running = undefined;
    const { job } = slot;
    if (job && bindings.now() >= job.deadline) expire(job);
    else if (job) {
      consecutiveExpiries = 0;
      settle(job, assessment);
    }
    dispatch();
  };
  const acceptReady = (current: Generation, fingerprint: string): void => {
    if (bindings.now() >= current.initDeadline) {
      retire("timeout");
      return;
    }
    if (current.ready || fingerprint !== bindings.policy.policyFingerprint) {
      retire("invalid_output");
      return;
    }
    current.ready = true;
    current.initTimer.cancel();
    current.finishWarm(true);
  };
  const start = (): Generation | undefined => {
    if (generation) return generation;
    if (stopped || bindings.now() < cooldownUntil || terminations.size > 0)
      return undefined;
    const initDeadline = bindings.now() + INITIALIZATION_DEADLINE_MS;
    let transport: SpeechWorkerTransport;
    try {
      transport = bindings.spawn(bindings.policy);
    } catch {
      cooldownUntil = bindings.now() + RETIREMENT_COOLDOWN_MS;
      return undefined;
    }
    if (hasStartedWorker) recordSpeechWorkerRestart();
    hasStartedWorker = true;
    let finishWarm: (ready: boolean) => void = () => {};
    const readiness = new Promise<boolean>((resolve) => {
      finishWarm = resolve;
    });
    const current: Generation = {
      transport,
      initDeadline,
      ready: false,
      readiness,
      finishWarm,
      initTimer: bindings.schedule(
        () => {
          if (generation === current) retire("timeout");
        },
        Math.max(0, initDeadline - bindings.now()),
      ),
      detach: [],
    };
    generation = current;
    current.detach.push(
      transport.onFailure((reason) => {
        if (generation === current) retire(reason);
      }),
    );
    current.detach.push(
      transport.onReply((message) => {
        if (generation !== current) return;
        const parsed = replySchema.safeParse(message);
        if (!parsed.success) {
          retire("invalid_output");
          return;
        }
        const reply = parsed.data;
        if (reply.type === "failure") {
          retire(reply.reason);
          return;
        }
        if (reply.type === "ready") {
          acceptReady(current, reply.policyFingerprint);
          return;
        }
        if (
          !current.ready ||
          reply.assessment.policyFingerprint !==
            bindings.policy.policyFingerprint
        ) {
          retire("invalid_output");
          return;
        }
        if (running?.requestId === reply.requestId)
          acceptAssessment(running, reply.assessment);
      }),
    );
    return current;
  };
  /** Settles a job that expired while queued, or while it was running. */
  const expireFromTimer = (job: Job): void => {
    const index = waiting.indexOf(job);
    if (index >= 0) waiting.splice(index, 1);
    else if (running?.job === job) running.job = undefined;
    else return;
    expire(job);
  };
  const enqueue = (
    wav: Uint8Array,
    phase: SpeechPhase,
  ): Promise<SpeechAssessment> => {
    if (stopped) return Promise.resolve(unavailable("shutdown"));
    const current = start();
    if (!current?.ready || bindings.now() < shedUntil)
      return Promise.resolve(unavailable("not_ready"));
    if (running && waiting.length >= MAX_WAITING_JOBS)
      return Promise.resolve(unavailable("queue_full"));
    const ownedWav = new Uint8Array(wav).buffer;
    const budget = JOB_BUDGET_MS[phase];
    return new Promise((resolve) => {
      const job: Job = {
        requestId: ++nextId,
        wav: ownedWav,
        deadline: bindings.now() + budget,
        resolve,
        timer: bindings.schedule(() => expireFromTimer(job), budget),
      };
      waiting.push(job);
      dispatch();
    });
  };
  return {
    warm() {
      return start()?.readiness ?? Promise.resolve(false);
    },
    assess(wav, phase) {
      return enqueue(wav, phase);
    },
    async shutdown() {
      stopped = true;
      retire("shutdown");
      await Promise.all(terminations);
    },
  };
}

function engineFailureReason(
  assessment: SpeechAssessment,
): SpeechUnavailableReason | undefined {
  if (assessment.kind !== "unavailable") return undefined;
  const { reason } = assessment;
  return reason === "worker_error" ||
    reason === "invalid_output" ||
    reason === "asset_error"
    ? reason
    : undefined;
}

function hasValidAssessmentMetrics(
  assessment: SpeechAssessment,
  policy: SpeechPolicy,
): boolean {
  if (assessment.kind === "unavailable") return true;
  const { metrics } = assessment;
  if (assessment.kind === "speech")
    return metrics.maxConsecutiveSpeechFrames >= policy.minSpeechFrames;
  if (metrics.scannedFrames !== metrics.totalFrames) return false;
  return (
    assessment.kind !== "non_speech" ||
    (metrics.peakSpeechProbability < policy.rejectionCeiling &&
      metrics.maxConsecutiveSpeechFrames < policy.minSpeechFrames)
  );
}

function spawnSpeechWorker(policy: SpeechPolicy): SpeechWorkerTransport {
  const source = path.extname(__filename) === ".ts";
  const worker = fork(
    path.join(
      __dirname,
      source ? "speechDetectionWorker.ts" : "speechDetectionWorker.js",
    ),
    [policy.policyFingerprint],
    {
      // The compiled child needs no TypeScript compiler heap.
      execArgv: source
        ? ["-r", require.resolve("ts-node/register")]
        : ["--max-old-space-size=16", "--max-semi-space-size=1"],
      serialization: "advanced",
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      windowsHide: true,
      env: source
        ? {
            ...process.env,
            MALLOC_ARENA_MAX: "1",
            TS_NODE_PROJECT: path.resolve(__dirname, "../../tsconfig.json"),
            TS_NODE_TRANSPILE_ONLY: "true",
          }
        : { ...process.env, MALLOC_ARENA_MAX: "1" },
    },
  );
  let terminating = false;
  const exited = new Promise<void>((resolve) =>
    worker.once("close", () => resolve()),
  );
  const replies = new Set<(reply: SpeechWorkerReply) => void>();
  const failures = new Set<(reason: SpeechUnavailableReason) => void>();
  const fail = (reason: SpeechUnavailableReason): void => {
    if (!terminating) for (const listener of failures) listener(reason);
  };
  worker.on("message", (message: unknown) => {
    const reply = replySchema.safeParse(message);
    if (!reply.success) {
      fail("invalid_output");
      return;
    }
    for (const listener of replies) listener(reply.data);
  });
  worker.on("error", (error: unknown) => {
    const parsed = z.object({ message: z.string() }).safeParse(error);
    const message = parsed.success ? parsed.data.message : "";
    fail(
      message === "asset_error"
        ? "asset_error"
        : message === "invalid_output"
          ? "invalid_output"
          : "worker_error",
    );
  });
  worker.on("exit", () => {
    fail("worker_error");
  });
  return {
    post(request: SpeechWorkerRequest) {
      worker.send(request, (error) => {
        if (error) fail("worker_error");
      });
    },
    onReply(listener) {
      replies.add(listener);
      return () => {
        replies.delete(listener);
      };
    },
    onFailure(listener) {
      failures.add(listener);
      return () => {
        failures.delete(listener);
      };
    },
    async terminate() {
      terminating = true;
      replies.clear();
      failures.clear();
      worker.kill("SIGKILL");
      await exited;
    },
  };
}
let singleton: SpeechDetector | undefined;
export function getSpeechDetector(): SpeechDetector {
  singleton ??= createSpeechDetector({
    policy: DEFAULT_SPEECH_POLICY,
    spawn: spawnSpeechWorker,
    now: () => performance.now(),
    schedule(callback, delayMs) {
      const timer = setTimeout(callback, delayMs);
      return {
        cancel: () => {
          clearTimeout(timer);
        },
      };
    },
  });
  return singleton;
}
export async function shutdownSpeechDetector(): Promise<void> {
  const detector = singleton;
  singleton = undefined;
  await detector?.shutdown();
}
