import path from "node:path";
import { fork } from "node:child_process";
import { DEFAULT_SPEECH_POLICY } from "./speechDetectionPolicy";
import { recordSpeechWorkerRestart } from "../metrics";
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
type Timer = ReturnType<SpeechDetectorBindings["schedule"]>;
type Job = {
  requestId: number;
  wav: ArrayBuffer;
  deadline: number;
  resolve: (assessment: SpeechAssessment) => void;
  timer: Timer;
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
  let active: Job | undefined;
  const waiting: Job[] = [];
  const terminations = new Set<Promise<void>>();
  let nextId = 0;
  let cooldownUntil = 0;
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
  const retire = (reason: SpeechUnavailableReason): void => {
    const old = generation;
    generation = undefined;
    cooldownUntil = bindings.now() + 30000;
    if (active) {
      settle(active, unavailable(reason));
      active = undefined;
    }
    for (const job of waiting.splice(0)) settle(job, unavailable(reason));
    if (!old) return;
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
    if (!generation?.ready || active) return;
    let job = waiting.shift();
    while (job && bindings.now() >= job.deadline) {
      settle(job, unavailable("timeout"));
      job = waiting.shift();
    }
    if (!job) return;
    active = job;
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
    const initDeadline = bindings.now() + 30000;
    let transport: SpeechWorkerTransport;
    try {
      transport = bindings.spawn(bindings.policy);
    } catch {
      cooldownUntil = bindings.now() + 30000;
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
        if (!active || active.requestId !== reply.requestId) return;
        if (bindings.now() >= active.deadline) {
          retire("timeout");
          return;
        }
        const assessment = reply.assessment;
        if (
          assessment.kind === "unavailable" &&
          (assessment.reason === "worker_error" ||
            assessment.reason === "invalid_output" ||
            assessment.reason === "asset_error")
        ) {
          retire(assessment.reason);
          return;
        }
        if (!hasValidAssessmentMetrics(assessment, bindings.policy)) {
          retire("invalid_output");
          return;
        }
        const completed = active;
        active = undefined;
        settle(completed, assessment);
        dispatch();
      }),
    );
    return current;
  };
  return {
    warm() {
      return start()?.readiness ?? Promise.resolve(false);
    },
    assess(wav, phase) {
      if (stopped) return Promise.resolve(unavailable("shutdown"));
      const current = start();
      if (!current?.ready) return Promise.resolve(unavailable("not_ready"));
      if (active && waiting.length >= 4)
        return Promise.resolve(unavailable("queue_full"));
      const deadline = bindings.now() + (phase === "fast" ? 500 : 1500);
      const ownedWav = new Uint8Array(wav).buffer;
      return new Promise((resolve) => {
        const job: Job = {
          requestId: ++nextId,
          wav: ownedWav,
          deadline,
          resolve,
          timer: bindings.schedule(
            () => {
              if (active === job) retire("timeout");
              else {
                const index = waiting.indexOf(job);
                if (index >= 0) {
                  waiting.splice(index, 1);
                  settle(job, unavailable("timeout"));
                }
              }
            },
            Math.max(0, deadline - bindings.now()),
          ),
        };
        waiting.push(job);
        dispatch();
      });
    },
    async shutdown() {
      stopped = true;
      retire("shutdown");
      await Promise.all(terminations);
    },
  };
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
