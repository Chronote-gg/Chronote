import { RuntimeAdmissionUnavailable } from "./runtimeAdmissionError";
import { admitCompatibleReplacement } from "./runtimeCompatibleReplacementService";
import type { DeploymentControlRepository } from "../repositories/deploymentControlRepository";
import { isDeepStrictEqual } from "node:util";
import {
  sameRuntimeIdentity,
  type RuntimeIdentity,
  type RuntimeReadiness,
  type RuntimeRecord,
  type RuntimeWorkKind,
  type RuntimeWorkHandle,
  type AdmissionContext,
  type RetirementResult,
  type ControlRecord,
  type RetirementRequest,
} from "../types/deploymentControl";
import {
  RUNTIME_PROTECTION_MARGIN_SECONDS,
  type RuntimeProtectionService,
} from "./runtimeProtectionService";

export const RUNTIME_HEARTBEAT_MS = 10_000;
export const RUNTIME_READINESS_SECONDS = 30;
export type RuntimeReadinessProbe = Pick<
  RuntimeReadiness,
  "gatewayReady" | "cacheReady" | "dependenciesReady"
>;
export type RuntimeWorkRegistration = RuntimeWorkHandle & {
  transition(kind: RuntimeWorkKind): void;
  beginOwnedControl(): RuntimeWorkHandle;
};
export type RuntimeLifecycle = ReturnType<typeof createRuntimeLifecycle>;

export function createRuntimeLifecycle(options: {
  identity: RuntimeIdentity;
  runtimeMode?: RuntimeReadiness["runtimeMode"];
  repository: DeploymentControlRepository;
  protection: RuntimeProtectionService;
  now?: () => number;
  probeReadiness: () => Promise<RuntimeReadinessProbe>;
  checkpointAndFence?: () => Promise<void>;
}) {
  const { identity, repository, protection } = options;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  let row: RuntimeRecord | undefined;
  let allowed = false;
  let ineligible = false;
  let unsafe = false;
  let releaseUncertain = false;
  let started = false;
  let safetyHandler = options.checkpointAndFence;
  const servingListeners = new Set<() => void>();
  const counts: Record<RuntimeWorkKind, number> = {
    pending_admission: 0,
    recording: 0,
    finalization: 0,
    personal_processing: 0,
    recovery_processing: 0,
    voice_operation: 0,
    ancillary_delivery: 0,
  };
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let tail: Promise<unknown> = Promise.resolve();
  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = tail.then(operation);
    tail = next.catch(() => undefined);
    return next;
  }
  protection.setUnsafeHandler(async () => {
    allowed = false;
    unsafe = true;
    // Safety must run before expiry, independently of a pending network heartbeat.
    await safetyHandler?.();
  });
  async function readRuntime() {
    const stored = await repository.getRecord(
      "ENV",
      `RUNTIME#${identity.instanceId}`,
    );
    if (
      stored &&
      (stored.recordType !== "runtime" ||
        !sameRuntimeIdentity(stored.identity, identity))
    )
      throw new Error("Runtime identity mismatch");
    return stored;
  }
  function snapshotReadiness(
    control: ControlRecord,
    flags: RuntimeReadinessProbe,
    proofTime: number,
  ): RuntimeReadiness {
    return {
      identity,
      runtimeMode: options.runtimeMode ?? "all",
      observedEpoch: control.coordinatorEpoch,
      observedGeneration: control.servingGeneration,
      ...flags,
      gatewayReady: options.runtimeMode === "api" ? false : flags.gatewayReady,
      dependenciesReady:
        flags.dependenciesReady &&
        Boolean(safetyHandler) &&
        !unsafe &&
        !ineligible,
      provenAt: proofTime,
      expiresAt: proofTime + RUNTIME_READINESS_SECONDS,
    };
  }
  function canAcceptWork(control: ControlRecord, current: RuntimeRecord) {
    const selected = control.servingMembers[identity.instanceId];
    const { readiness } = current;
    return (
      !ineligible &&
      !unsafe &&
      current.role === "serving" &&
      Boolean(selected && sameRuntimeIdentity(selected, identity)) &&
      control.servingGeneration === current.authorizedGeneration &&
      (readiness.runtimeMode === "api" || readiness.gatewayReady) &&
      readiness.cacheReady &&
      readiness.dependenciesReady &&
      readiness.expiresAt > now() &&
      protection.isSafe()
    );
  }
  async function refreshRetirement(pending: RuntimeRecord | undefined) {
    if (
      pending?.retirementRequest &&
      (await retirementAuthorized(pending, pending.retirementRequest))
    ) {
      const result = await retire(
        pending.retirementRequest.coordinatorEpoch,
        pending.retirementRequest,
      );
      if (result.kind === "busy" && row) {
        const projected = {
          ...row,
          heartbeatAt: now(),
          workCounts: { ...counts },
        };
        if ((await repository.writeRuntime(projected)) === "applied")
          row = projected;
      }
      if (row) return structuredClone(row.readiness);
    }
    if (pending?.role === "retired" || pending?.role === "releasing") {
      row = pending;
      allowed = false;
      return structuredClone(pending.readiness);
    }
    return undefined;
  }
  async function refresh(): Promise<RuntimeReadiness> {
    const retirement = await refreshRetirement(await readRuntime());
    if (retirement) return retirement;
    const control = await repository.getRecord("ENV", "CONTROL");
    if (control?.recordType !== "control")
      throw new Error("Deployment control unavailable");
    if (control.runtimeEnvironment !== identity.kind)
      throw new Error("Runtime identity does not match control environment");
    const proofTime = now();
    const flags = await options.probeReadiness();
    const readiness = snapshotReadiness(control, flags, proofTime);
    const proof = protection.getConfirmation();
    if (!proof) throw new Error("Runtime protection unavailable");
    // Expire the published admission/promotion proof before ECS protection does.
    readiness.expiresAt = Math.min(
      readiness.expiresAt,
      proof.expiresAt - RUNTIME_PROTECTION_MARGIN_SECONDS,
    );
    const stored = await readRuntime();
    const next: RuntimeRecord = {
      ...stored,
      pk: "ENV",
      sk: `RUNTIME#${identity.instanceId}`,
      recordType: "runtime",
      identity,
      role: stored?.role ?? "candidate",
      authorizedGeneration:
        stored?.authorizedGeneration ?? control.servingGeneration,
      heartbeatAt: now(),
      readiness,
      protection: proof,
      workCounts: { ...counts },
    };
    if (next.role === "stale") throw new Error("Stale runtime cannot restart");
    if ((await repository.writeRuntime(next)) !== "applied")
      throw new Error("Runtime changed during heartbeat");
    row = next;
    if (await admitCompatibleReplacement(repository, next, now()))
      return refresh();
    allowed = canAcceptWork(control, row);
    if (allowed)
      for (const listener of servingListeners) {
        servingListeners.delete(listener);
        listener();
      }
    return structuredClone(readiness);
  }
  function refreshRuntimeReadiness() {
    return serialize(async () => {
      try {
        return await refresh();
      } catch (error) {
        allowed = false;
        throw error;
      }
    });
  }
  async function start() {
    if (started) throw new Error("Runtime lifecycle already started");
    started = true;
    await protection.start();
    try {
      if (await readRuntime())
        throw new Error("Runtime identity is already registered");
      await refreshRuntimeReadiness();
    } catch (error) {
      protection.stop();
      throw error;
    }
    heartbeat = setInterval(() => {
      void refreshRuntimeReadiness().catch(() => {
        allowed = false;
      });
    }, RUNTIME_HEARTBEAT_MS);
    heartbeat.unref();
  }
  function beginRuntimeWork(kind: RuntimeWorkKind): RuntimeWorkRegistration {
    if (
      !allowed ||
      ineligible ||
      unsafe ||
      !safetyHandler ||
      !protection.isSafe() ||
      !row ||
      row.readiness.expiresAt <= now()
    )
      throw new RuntimeAdmissionUnavailable("Runtime is not accepting work");
    counts[kind]++;
    let settled = false;
    return {
      beginOwnedControl() {
        if (
          settled ||
          !["recording", "finalization", "voice_operation"].includes(kind) ||
          unsafe ||
          !safetyHandler ||
          !protection.isSafe() ||
          !row ||
          ["releasing", "retired", "stale", "candidate"].includes(row.role)
        )
          throw new Error("Session cannot grant control ownership");
        counts.ancillary_delivery++;
        let controlSettled = false;
        return {
          settle() {
            if (controlSettled) return;
            controlSettled = true;
            counts.ancillary_delivery--;
          },
        };
      },
      settle() {
        if (!settled) {
          settled = true;
          counts[kind]--;
        }
      },
      // A finalizer keeps the same ownership handle while the runtime drains.
      transition(next) {
        if (settled) throw new Error("Work is already settled");
        counts[kind]--;
        counts[next]++;
        kind = next;
      },
    };
  }
  function getRuntimeAdmissionContext(): Promise<AdmissionContext> {
    return serialize(async () => {
      try {
        await refresh();
      } catch (error) {
        allowed = false;
        throw error;
      }
      if (!allowed || !row)
        throw new RuntimeAdmissionUnavailable("Runtime is not serving");
      return {
        instanceId: identity.instanceId,
        identity,
        authorizedGeneration: row.authorizedGeneration,
        observedEpoch: row.readiness.observedEpoch,
        protocolVersion: 1,
        now: now(),
      };
    });
  }
  async function changeRole(
    stored: RuntimeRecord,
    role: RuntimeRecord["role"],
    retirementEpoch: number,
    acknowledgment?: RuntimeRecord["retirementAcknowledgment"],
  ) {
    const next: RuntimeRecord = {
      ...stored,
      role,
      workCounts: { ...counts },
      heartbeatAt: now(),
      readiness: { ...stored.readiness, dependenciesReady: false },
      ...(acknowledgment ? { retirementAcknowledgment: acknowledgment } : {}),
      ...(role === "candidate"
        ? { retirementRequest: undefined, retirementAcknowledgment: undefined }
        : {}),
    };
    if (
      (await repository.transitionRuntimeRole({
        record: next,
        expectedRole: stored.role,
        expectedGeneration: stored.authorizedGeneration,
        retirementEpoch,
        expectedRetirementRequest: stored.retirementRequest,
        expectedRetirementAcknowledgment: stored.retirementAcknowledgment,
      })) !== "applied"
    )
      throw new Error("Runtime role changed");
    row = next;
    return next;
  }
  async function retirementAuthorized(
    stored: RuntimeRecord,
    request: RetirementRequest,
  ) {
    const control = await repository.getRecord("ENV", "CONTROL");
    return (
      control?.recordType === "control" &&
      control.coordinatorEpoch === request.coordinatorEpoch &&
      control.coordinatorToken === request.coordinatorToken &&
      control.coordinatorExpiresAt > now() &&
      !control.servingMembers[identity.instanceId] &&
      sameRuntimeIdentity(request.identity, identity) &&
      request.authorizedGeneration === stored.authorizedGeneration &&
      isDeepStrictEqual(stored.retirementRequest, request)
    );
  }
  async function retire(
    retirementEpoch: number,
    request?: RetirementRequest,
  ): Promise<RetirementResult> {
    try {
      let stored = await readRuntime();
      if (!stored) throw new Error("Runtime missing");
      if (request && !(await retirementAuthorized(stored, request)))
        throw new Error("Retirement authority changed");
      ineligible = true;
      allowed = false;
      if (!["draining", "releasing", "retired"].includes(stored.role))
        stored = await changeRole(stored, "draining", retirementEpoch);
      if (Object.values(counts).some((count) => count > 0))
        return {
          kind: "busy",
          counts: { ...counts },
          reason: "work_remaining",
        };
      if (releaseUncertain)
        return {
          kind: "uncertain",
          counts: { ...counts },
          reason: "dependency_unavailable",
        };
      if (stored.role === "retired")
        return { kind: "retired", counts: { ...counts } };
      if (stored.role !== "releasing")
        stored = await changeRole(stored, "releasing", retirementEpoch);
      if (request) {
        const current = await readRuntime();
        if (!current || !(await retirementAuthorized(current, request)))
          throw new Error("Retirement authority changed before release");
      }
      try {
        await protection.release();
      } catch {
        releaseUncertain = true;
        throw new Error("Protection release uncertain");
      }
      await changeRole(
        stored,
        "retired",
        retirementEpoch,
        request ? { request, retiredAt: now() } : undefined,
      );
      return { kind: "retired", counts: { ...counts } };
    } catch {
      return {
        kind: "uncertain",
        counts: { ...counts },
        reason: "dependency_unavailable",
      };
    }
  }
  function prepareRuntimeRetirement({
    retirementEpoch,
  }: {
    retirementEpoch: number;
  }): Promise<RetirementResult> {
    // Direct local shutdown retains its synchronous admission barrier.
    // Durable requests validate their authority before closing a runtime.
    ineligible = true;
    allowed = false;
    return serialize(() => retire(retirementEpoch));
  }
  function reauthorizeRuntime({
    retirementEpoch,
  }: {
    retirementEpoch: number;
  }): Promise<void> {
    return serialize(async () => {
      if (releaseUncertain)
        throw new Error("Protection release has not been confirmed");
      const stored = await readRuntime();
      if (
        stored?.role !== "retired" ||
        Object.values(counts).some((count) => count > 0)
      )
        throw new Error("Runtime is not retired");
      await protection.start();
      await changeRole(stored, "candidate", retirementEpoch);
      unsafe = false;
      ineligible = false;
      await refresh();
    });
  }
  return {
    start,
    refreshRuntimeReadiness,
    beginRuntimeWork,
    getRuntimeAdmissionContext,
    prepareRuntimeRetirement,
    reauthorizeRuntime,
    registerSafetyHandler(handler: (() => Promise<void>) | undefined) {
      if (Object.values(counts).some((count) => count > 0))
        throw new Error("Cannot replace safety handler while work is owned");
      safetyHandler = handler;
      if (!handler) allowed = false;
    },
    getWorkCounts: () => ({ ...counts }),
    isAcceptingWork: () =>
      allowed &&
      !ineligible &&
      !unsafe &&
      protection.isSafe() &&
      Boolean(row && row.readiness.expiresAt > now()),
    getReadiness: () => (row ? structuredClone(row.readiness) : undefined),
    getRole: () => row?.role,
    whenServing(listener: () => void) {
      if (allowed) listener();
      else servingListeners.add(listener);
    },
    confirmRuntimeProtection: () =>
      serialize(async () => {
        if (ineligible || releaseUncertain)
          throw new Error("Runtime is ineligible");
        return protection.confirm();
      }),
    closeAdmission() {
      allowed = false;
      ineligible = true;
    },
    async shutdown() {
      allowed = false;
      ineligible = true;
      clearInterval(heartbeat);
      await Promise.allSettled([tail, protection.shutdown()]);
      clearInterval(heartbeat);
    },
    stop() {
      clearInterval(heartbeat);
      protection.stop();
      allowed = false;
    },
  };
}

let runtime: RuntimeLifecycle | undefined;
const pendingServingListeners: Array<() => void> = [];
export function installRuntimeLifecycle(value: RuntimeLifecycle) {
  if (runtime) throw new Error("Runtime lifecycle already installed");
  runtime = value;
  for (const listener of pendingServingListeners.splice(0))
    value.whenServing(listener);
}
export function getRuntimeLifecycle(): RuntimeLifecycle {
  if (!runtime) throw new Error("Runtime lifecycle has not started");
  return runtime;
}
export const beginRuntimeWork = (kind: RuntimeWorkKind) =>
  getRuntimeLifecycle().beginRuntimeWork(kind);
export const getRuntimeAdmissionContext = () =>
  getRuntimeLifecycle().getRuntimeAdmissionContext();
export const refreshRuntimeReadiness = () =>
  getRuntimeLifecycle().refreshRuntimeReadiness();
export const prepareRuntimeRetirement = (input: { retirementEpoch: number }) =>
  getRuntimeLifecycle().prepareRuntimeRetirement(input);
export const reauthorizeRuntime = (input: { retirementEpoch: number }) =>
  getRuntimeLifecycle().reauthorizeRuntime(input);
export const registerRuntimeSafetyHandler = (handler: () => Promise<void>) =>
  getRuntimeLifecycle().registerSafetyHandler(handler);
export const closeRuntimeAdmission = () => runtime?.closeAdmission();
export const getRuntimeReadiness = () => runtime?.getReadiness();
export const confirmRuntimeProtection = () =>
  getRuntimeLifecycle().confirmRuntimeProtection();
export const whenRuntimeServing = (listener: () => void) =>
  runtime
    ? runtime.whenServing(listener)
    : pendingServingListeners.push(listener);
export const isRuntimeWarm = () =>
  !runtime ||
  runtime.getRole() === "candidate" ||
  runtime.getRole() === "retired";
export async function startRuntimeLifecycle(
  identity: RuntimeIdentity,
): Promise<void> {
  const current = getRuntimeLifecycle();
  await current.start();
  const readiness = current.getReadiness();
  if (!readiness || !sameRuntimeIdentity(readiness.identity, identity)) {
    current.stop();
    throw new Error("Runtime startup identity mismatch");
  }
}

export const shutdownRuntimeLifecycle = async () => {
  await runtime?.shutdown();
};
export const getRuntimeWorkCounts = () => runtime?.getWorkCounts();
