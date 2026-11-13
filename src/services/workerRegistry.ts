import {
  LEGACY_STANDBY_UNREADABLE_LOG,
  WORKER_ELIGIBLE_LOG,
  workerEligible,
} from "../metrics";
import {
  getWorkerRegistryRepository,
  WORKERS_PK,
  type RegistryView,
  type WorkerRecord,
  type WorkerRegistryRepository,
} from "../repositories/workerRegistryRepository";
import { LIFECYCLE } from "./lifecycleTiming";
import {
  getWorkerIdentity,
  type WorkerIdentity,
} from "./runtimeInstanceService";
import { isShuttingDown } from "./shutdownSignal";
import {
  isFreshRecord,
  resolveEligibility,
  type EligibilityReason,
} from "./workerEligibility";

const MS_PER_SECOND = 1000;
// The ready:false write is what tells peers and the deploy script to stop counting this worker.
const FINAL_WRITE_ATTEMPTS = 2;

export type WorkerLoad = {
  captures: number;
  finishing: number;
  protectedUntil?: number;
};
export type WorkerRegistryOptions = {
  mode: "all" | "bot" | "api";
  isGatewayReady(): boolean;
  isServerListening(): boolean;
  load(): WorkerLoad;
};

export type WorkerRegistryDeps = {
  repository: WorkerRegistryRepository;
  resolveIdentity(): Promise<WorkerIdentity>;
  nowMs(): number;
  /** Runs `run` once after `delayMs` and returns a function that cancels it. */
  schedule(run: () => Promise<void>, delayMs: number): () => void;
  isShuttingDown(): boolean;
};

function probesReady(options: WorkerRegistryOptions): boolean {
  const gateway = options.mode === "api" || options.isGatewayReady();
  const server = options.mode === "bot" || options.isServerListening();
  return gateway && server;
}

export function createWorkerRegistry(deps: WorkerRegistryDeps) {
  let identity: WorkerIdentity | undefined;
  let options: WorkerRegistryOptions | undefined;
  let view: RegistryView = { workers: [], cutover: false };
  let hasRead = false;
  let eligible = false;
  let everReady = false;
  let everEligible = false;
  let lastEligibleLogMs: number | undefined;
  let legacyReadFailed = false;
  let lastUnreadableLogMs: number | undefined;
  let stopping = false;
  let cancel: (() => void) | undefined;
  let inFlight: Promise<void> | undefined;
  const firstEligibleListeners: Array<() => void> = [];

  function notifyFirstEligible(listener: () => void) {
    try {
      listener();
    } catch (error) {
      console.error("Worker first-eligible listener failed", error);
    }
  }

  function setEligible(value: boolean, nowMs: number) {
    eligible = value;
    workerEligible.set(value ? 1 : 0);
    if (!value) {
      lastEligibleLogMs = undefined;
      return;
    }
    if (
      lastEligibleLogMs === undefined ||
      nowMs - lastEligibleLogMs >= LIFECYCLE.registryEligibleLogMs
    ) {
      console.log(WORKER_ELIGIBLE_LOG, {
        instanceId: identity?.instanceId,
        release: identity?.release,
      });
      lastEligibleLogMs = nowMs;
    }
    if (everEligible) return;
    everEligible = true;
    firstEligibleListeners.splice(0).forEach(notifyFirstEligible);
  }

  async function refreshView(): Promise<number[] | undefined> {
    try {
      view = await deps.repository.read();
      hasRead = true;
    } catch (error) {
      console.warn("Worker registry read failed, keeping the last view", error);
    }
    legacyReadFailed = false;
    if (view.cutover) return undefined;
    try {
      return await deps.repository.legacyHeartbeats();
    } catch (error) {
      legacyReadFailed = true;
      console.warn("Legacy runtime heartbeat read failed", error);
      return undefined;
    }
  }

  function logUnreadableStandby(reason: EligibilityReason, nowMs: number) {
    if (reason !== "legacy_standby" || !legacyReadFailed) {
      lastUnreadableLogMs = undefined;
      return;
    }
    if (
      lastUnreadableLogMs !== undefined &&
      nowMs - lastUnreadableLogMs < LIFECYCLE.registryEligibleLogMs
    )
      return;
    console.error(LEGACY_STANDBY_UNREADABLE_LOG, {
      instanceId: identity?.instanceId,
    });
    lastUnreadableLogMs = nowMs;
  }

  async function markCutover(self: WorkerIdentity, now: number) {
    try {
      await deps.repository.writeCutover(self.instanceId, now);
      view = { ...view, cutover: true };
    } catch (error) {
      console.warn("Worker registry cutover write failed", error);
    }
  }

  async function writeRecord(
    self: WorkerIdentity,
    current: WorkerRegistryOptions,
    ready: boolean,
    now: number,
  ): Promise<boolean> {
    const load = current.load();
    const record: WorkerRecord = {
      pk: WORKERS_PK,
      sk: `WORKER#${self.instanceId}`,
      recordType: "worker",
      instanceId: self.instanceId,
      release: self.release,
      ready,
      heartbeatAt: now,
      captures: load.captures,
      finishing: load.finishing,
      protectedUntil: load.protectedUntil,
      taskArn: self.taskArn,
      expiresAt: now + LIFECYCLE.registryItemTtlSeconds,
    };
    try {
      await deps.repository.put(record);
      return true;
    } catch (error) {
      console.warn("Worker registry write failed", error);
      return false;
    }
  }

  async function heartbeat(
    self: WorkerIdentity,
    current: WorkerRegistryOptions,
  ) {
    const nowMs = deps.nowMs();
    const now = Math.floor(nowMs / MS_PER_SECOND);
    const legacyHeartbeats = await refreshView();
    const shuttingDown = deps.isShuttingDown();
    // A draining worker must stop advertising readiness, or peers on lower releases keep deferring to it.
    const ready = hasRead && probesReady(current) && !shuttingDown;
    const decision = resolveEligibility({
      self: { instanceId: self.instanceId, release: self.release, ready },
      shuttingDown,
      view,
      legacyHeartbeats,
      now,
    });
    logUnreadableStandby(decision.reason, nowMs);
    if (decision.writeCutover) await markCutover(self, now);
    if (stopping) return;
    if ((await writeRecord(self, current, ready, now)) && ready)
      everReady = true;
    setEligible(decision.eligible && !stopping, nowMs);
  }

  async function runHeartbeat(
    self: WorkerIdentity,
    current: WorkerRegistryOptions,
  ) {
    inFlight = heartbeat(self, current).catch((error: unknown) => {
      console.error("Worker registry heartbeat failed", error);
    });
    await inFlight;
    if (!stopping)
      cancel = deps.schedule(
        () => runHeartbeat(self, current),
        LIFECYCLE.registryHeartbeatMs,
      );
  }

  return {
    async start(startOptions: WorkerRegistryOptions): Promise<void> {
      if (identity) throw new Error("Worker registry already started");
      const self = await deps.resolveIdentity();
      // A shutdown that began while the identity resolved must not be followed by a first record.
      if (stopping) return;
      identity = self;
      options = startOptions;
      await runHeartbeat(self, startOptions);
    },
    async stop(): Promise<void> {
      if (stopping) return;
      stopping = true;
      if (!identity || !options) return;
      // In memory first, so nothing new is taken even while a heartbeat write hangs.
      setEligible(false, deps.nowMs());
      await inFlight;
      cancel?.();
      for (let attempt = 0; attempt < FINAL_WRITE_ATTEMPTS; attempt += 1)
        if (
          await writeRecord(
            identity,
            options,
            false,
            Math.floor(deps.nowMs() / MS_PER_SECOND),
          )
        )
          break;
    },
    isEligible: () => eligible,
    /** From the last registry view, so it costs no request; a stale view reads a live worker as gone. */
    isWorkerFresh(instanceId: string): boolean {
      const now = Math.floor(deps.nowMs() / MS_PER_SECOND);
      return view.workers.some(
        (worker) =>
          worker.instanceId === instanceId && isFreshRecord(worker, now),
      );
    },
    hasBeenReady: () => everReady,
    onFirstEligible(listener: () => void) {
      if (everEligible) notifyFirstEligible(listener);
      else firstEligibleListeners.push(listener);
    },
    getWorkerRelease(): number {
      if (!identity) throw new Error("Worker registry has not started");
      return identity.release;
    },
  };
}
export type WorkerRegistry = ReturnType<typeof createWorkerRegistry>;

let processRegistry: WorkerRegistry | undefined;
function registry(): WorkerRegistry {
  processRegistry ??= createWorkerRegistry({
    repository: getWorkerRegistryRepository(),
    resolveIdentity: getWorkerIdentity,
    nowMs: Date.now,
    schedule(run, delayMs) {
      const timer = setTimeout(() => void run(), delayMs);
      timer.unref();
      return () => clearTimeout(timer);
    },
    isShuttingDown,
  });
  return processRegistry;
}

/** Resolves after the first registry read and write, whether or not they succeeded. */
export function startWorkerRegistry(
  options: WorkerRegistryOptions,
): Promise<void> {
  return registry().start(options);
}
export function stopWorkerRegistry(): Promise<void> {
  return registry().stop();
}
export function isEligible(): boolean {
  return registry().isEligible();
}
export function isWorkerFresh(instanceId: string): boolean {
  return registry().isWorkerFresh(instanceId);
}
export function hasBeenReady(): boolean {
  return registry().hasBeenReady();
}
export function onFirstEligible(listener: () => void): void {
  registry().onFirstEligible(listener);
}
export function getWorkerRelease(): number {
  return registry().getWorkerRelease();
}
