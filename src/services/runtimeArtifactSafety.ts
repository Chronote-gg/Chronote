import type { ArtifactSafetyRepository } from "../repositories/artifactSafetyRepository";
import type { DeploymentControlRepository } from "../repositories/deploymentControlRepository";
import {
  artifactSafetyBaseSchema,
  artifactSafetyKey,
  artifactSafetyRecordSchema,
  artifactStorageProofSchema,
  ARTIFACT_PROOF_SECONDS,
  type ArtifactSafetyRecord,
  type ArtifactSafetyRequest,
  type ArtifactStorageSnapshot,
} from "../types/artifactSafety";
import {
  controlRecordSchema,
  runtimeRecordSchema,
  sameRuntimeIdentity,
  type RuntimeIdentity,
  type RuntimeRecord,
  type RetirementRequest,
} from "../types/deploymentControl";
import type {
  ArtifactSafetyContext,
  ArtifactSafetyPurpose,
} from "./artifactSafetyRules";
import type { ArtifactAdmissionGate } from "./artifactAdmissionGate";
import type { RuntimeArtifactStorage } from "./runtimeArtifactStorage";
import { stableJson } from "../utils/stableJson";

type AuthorityMode =
  "runtime" | "preparing" | "activating" | { request: RetirementRequest };
type Preparation = {
  request: ArtifactSafetyRequest;
  controller: AbortController;
  cancelled: boolean;
  expired: boolean;
  timer?: ReturnType<typeof setTimeout>;
  promise: Promise<void>;
};
function liveBase(row: ArtifactSafetyRecord, now: number) {
  return {
    ...artifactSafetyBaseSchema.parse(row),
    revision: row.revision + 1,
    heartbeatAt: now,
    freshUntil: now + ARTIFACT_PROOF_SECONDS,
  };
}
function proof(
  snapshot: ArtifactStorageSnapshot,
  now: number,
  deadline = now + ARTIFACT_PROOF_SECONDS,
) {
  return artifactStorageProofSchema.parse({
    snapshot,
    provenAt: now,
    expiresAt: Math.min(now + ARTIFACT_PROOF_SECONDS, deadline),
  });
}
function boundRequest(
  row: ArtifactSafetyRecord,
  request: ArtifactSafetyRequest,
) {
  if (!("request" in row) || stableJson(row.request) !== stableJson(request))
    throw new Error("Artifact request changed");
  return row.request;
}

export function createRuntimeArtifactSafety(options: {
  identity: RuntimeIdentity;
  repository: ArtifactSafetyRepository;
  control: Pick<DeploymentControlRepository, "getRecord">;
  admission: ArtifactAdmissionGate;
  storage: RuntimeArtifactStorage;
  isProtected(): boolean;
  now?: () => number;
  signal?: AbortSignal;
}) {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  let operation: Preparation | undefined;
  let stopped = false;
  let unavailable = false;
  async function runtime() {
    const row = runtimeRecordSchema.parse(
      await options.control.getRecord(
        "ENV",
        "RUNTIME#" + options.identity.instanceId,
      ),
    );
    if (!sameRuntimeIdentity(row.identity, options.identity))
      throw new Error("Artifact runtime changed");
    return row;
  }
  async function context(mode: AuthorityMode): Promise<ArtifactSafetyContext> {
    const row = await runtime();
    if (mode === "runtime") return { kind: "runtime", runtime: row };
    const control = controlRecordSchema.parse(
      await options.control.getRecord("ENV", "CONTROL"),
    );
    if (typeof mode === "object")
      return { kind: "retiring", runtime: row, control, request: mode.request };
    return mode === "preparing"
      ? { kind: "preparing", runtime: row, control }
      : { kind: "activating", runtime: row, control };
  }
  async function write(
    purpose: ArtifactSafetyPurpose,
    mode: AuthorityMode,
    update: (
      current: ArtifactSafetyRecord,
      time: number,
    ) => ArtifactSafetyRecord,
    signal?: AbortSignal,
  ) {
    for (let attempt = 0; attempt < 3; attempt++) {
      signal?.throwIfAborted();
      const current = await options.repository.read(options.identity, signal);
      if (!current) throw new Error("Artifact capability missing");
      const authority = await context(mode);
      signal?.throwIfAborted();
      const time = now();
      const next = update(current, time);
      if (
        (await options.repository.write(
          { purpose, expected: current, next, context: authority, now: time },
          signal,
        )) === "applied"
      )
        return next;
    }
    throw new Error("Artifact state changed during publication");
  }
  async function capability() {
    let current = await options.repository.read(
      options.identity,
      options.signal,
    );
    if (current) return current;
    const authority = await context("runtime");
    const time = now();
    const next = artifactSafetyRecordSchema.parse({
      ...artifactSafetyKey(options.identity),
      recordType: "artifact_safety",
      schemaVersion: 1,
      identity: options.identity,
      revision: 0,
      heartbeatAt: time,
      freshUntil: time + ARTIFACT_PROOF_SECONDS,
      startup: { kind: "pending" },
      state: "idle",
    });
    await options.repository.write(
      { purpose: "initialize", next, context: authority, now: time },
      options.signal,
    );
    current = await options.repository.read(options.identity, options.signal);
    if (!current) throw new Error("Artifact capability unavailable");
    return current;
  }
  function warnUnavailable() {
    if (!unavailable)
      console.warn(
        "Artifact safety verification unavailable; replacement remains gated",
      );
    unavailable = true;
  }
  async function block(current: Preparation) {
    const reason = current.expired
      ? options.admission.active
        ? "work_remaining"
        : "deadline_expired"
      : "preservation_incomplete";
    await write("block", "runtime", (row, time) =>
      artifactSafetyRecordSchema.parse({
        ...liveBase(row, time),
        state: "blocked",
        request: boundRequest(row, current.request),
        reason,
      }),
    );
  }
  async function runPreparation(current: Preparation, drained: Promise<void>) {
    try {
      await write(
        "drain",
        "preparing",
        (row, time) =>
          artifactSafetyRecordSchema.parse({
            ...liveBase(row, time),
            state: "draining",
            request: boundRequest(row, current.request),
            activeProducers: options.admission.active,
          }),
        current.controller.signal,
      );
      await drained;
      current.controller.signal.throwIfAborted();
      const snapshot = await options.storage.seal(current.controller.signal);
      await write(
        "seal",
        "preparing",
        (row, time) =>
          artifactSafetyRecordSchema.parse({
            ...liveBase(row, time),
            state: "sealed",
            request: boundRequest(row, current.request),
            proof: proof(snapshot, time, current.request.expiresAt),
          }),
        current.controller.signal,
      );
    } catch {
      if (!current.cancelled) await block(current).catch(warnUnavailable);
    } finally {
      if (current.timer) clearTimeout(current.timer);
      if (operation === current) operation = undefined;
    }
  }
  function beginPreparation(request: ArtifactSafetyRequest) {
    if (
      operation &&
      !operation.cancelled &&
      stableJson(operation.request) === stableJson(request)
    )
      return;
    if (operation) {
      operation.cancelled = true;
      operation.controller.abort();
    }
    const controller = new AbortController();
    const drained = options.admission.seal(controller.signal);
    void drained.catch(() => {});
    const current: Preparation = {
      request,
      controller,
      cancelled: false,
      expired: request.expiresAt <= now(),
      promise: Promise.resolve(),
    };
    operation = current;
    if (current.expired)
      controller.abort(new Error("Artifact preparation expired"));
    else {
      current.timer = setTimeout(
        () => {
          current.expired = true;
          controller.abort(new Error("Artifact preparation expired"));
        },
        Math.max(1, (request.expiresAt - now()) * 1000),
      );
      current.timer.unref();
    }
    current.promise = runPreparation(current, drained);
  }
  async function cancel(request: ArtifactSafetyRequest) {
    if (!options.isProtected())
      throw new Error("Source protection is not confirmed for cancellation");
    await write("cancel_ack", "preparing", (row, time) =>
      artifactSafetyRecordSchema.parse({
        ...liveBase(row, time),
        state: "cancelled",
        request: boundRequest(row, request),
        cancelledAt: time,
      }),
    );
    if (operation) {
      operation.cancelled = true;
      operation.controller.abort();
    }
    options.storage.resume();
    options.admission.resume();
  }
  async function publishStartup(
    snapshot: ArtifactStorageSnapshot,
    serving: boolean,
  ) {
    return write(
      serving ? "renew_startup" : "startup",
      serving ? "activating" : "runtime",
      (row, time) =>
        artifactSafetyRecordSchema.parse({
          ...liveBase(row, time),
          state: "idle",
          startup: { kind: "sealed", proof: proof(snapshot, time) },
        }),
      options.signal,
    );
  }
  async function activate(row: ArtifactSafetyRecord) {
    if (row.startup.kind !== "sealed" || row.state !== "idle")
      throw new Error("Candidate artifact startup is not sealed");
    if (row.startup.proof.expiresAt <= now()) {
      const snapshot = await options.storage.recheck(
        row.startup.proof.snapshot,
        options.signal,
      );
      await publishStartup(snapshot, true);
    }
    await write(
      "activate",
      "activating",
      (current, time) =>
        artifactSafetyRecordSchema.parse({
          ...liveBase(current, time),
          state: "idle",
          startup: { kind: "active", activatedAt: time },
        }),
      options.signal,
    );
    options.storage.resume();
    options.admission.resume();
  }
  async function prepareRollback(
    row: Extract<ArtifactSafetyRecord, { state: "consumed" }>,
  ) {
    const control = controlRecordSchema.parse(
      await options.control.getRecord("ENV", "CONTROL"),
    );
    if (
      !control.deployment ||
      !["rollback_promoting", "rolled_back"].includes(control.deployment.phase)
    )
      return;
    const snapshot = await options.storage.recheck(
      row.proof.snapshot,
      options.signal,
    );
    await write(
      "rollback_startup",
      "activating",
      (current, time) =>
        artifactSafetyRecordSchema.parse({
          ...liveBase(current, time),
          state: "idle",
          startup: { kind: "sealed", proof: proof(snapshot, time) },
        }),
      options.signal,
    );
  }
  async function refreshStartup(
    row: ArtifactSafetyRecord,
    role: RuntimeRecord["role"],
  ) {
    if (row.startup.kind !== "sealed") return;
    if (role === "serving") await activate(row);
    else if (role === "candidate" && row.startup.proof.expiresAt <= now() + 20)
      await publishStartup(
        await options.storage.recheck(
          row.startup.proof.snapshot,
          options.signal,
        ),
        false,
      );
  }
  async function refresh() {
    if (stopped) return;
    try {
      const row = await capability();
      const owner = await runtime();
      if (["requested", "draining"].includes(row.state) && "request" in row)
        beginPreparation(row.request);
      else if (row.state === "cancel_requested") await cancel(row.request);
      else if (owner.role === "serving" && row.state === "consumed")
        await prepareRollback(row);
      else if (row.state === "idle" && row.startup.kind === "sealed")
        await refreshStartup(row, owner.role);
      if (row.heartbeatAt <= now() - 10)
        await write("heartbeat", "runtime", (current, time) =>
          artifactSafetyRecordSchema.parse({
            ...current,
            ...liveBase(current, time),
          }),
        );
      unavailable = false;
    } catch {
      warnUnavailable();
    }
  }
  return {
    refresh,
    async authorizeReactivation() {
      const control = controlRecordSchema.parse(
        await options.control.getRecord("ENV", "CONTROL"),
      );
      const deployment = control.deployment;
      if (
        !deployment ||
        deployment.phase !== "warming" ||
        deployment.outgoing.instanceId === options.identity.instanceId
      )
        throw new Error("Reactivation requires a fresh protected handoff");
      if (
        options.identity.kind !== "ecs" ||
        options.identity.candidateId !== deployment.candidateId ||
        !deployment.image.endsWith("@" + options.identity.imageDigest) ||
        control.servingMembers[options.identity.instanceId]
      )
        throw new Error("Reactivation candidate identity is not authorized");
      const source = await options.repository.read(
        deployment.outgoing,
        options.signal,
      );
      if (
        source?.state !== "consumed" ||
        source.proof.expiresAt <= now() ||
        source.request.coordinatorToken !== control.coordinatorToken ||
        source.request.coordinatorEpoch !== control.coordinatorEpoch ||
        source.request.servingGeneration !== control.servingGeneration
      )
        throw new Error("Reactivation source preservation is unconfirmed");
    },
    async startupReady() {
      await capability();
      await options.admission.seal(options.signal);
      const snapshot = await options.storage.seal(options.signal);
      await publishStartup(snapshot, false);
    },
    async verifyRetirement(request?: RetirementRequest) {
      await options.admission.seal(options.signal);
      const row = await capability();
      const snapshot =
        row.state === "consumed"
          ? await options.storage.recheck(row.proof.snapshot, options.signal)
          : await options.storage.seal(options.signal);
      if (!request) return;
      await write(
        "retirement",
        { request },
        (current, time) => {
          const retirementVerification = {
            request,
            proof: proof(snapshot, time),
          };
          return artifactSafetyRecordSchema.parse(
            current.state === "consumed"
              ? {
                  ...current,
                  ...liveBase(current, time),
                  retirementVerification,
                }
              : {
                  ...liveBase(current, time),
                  state: "retirement_safe",
                  retirementVerification,
                },
          );
        },
        options.signal,
      );
    },
    stop() {
      stopped = true;
      if (operation) {
        operation.cancelled = true;
        operation.controller.abort();
      }
    },
  };
}
export type RuntimeArtifactSafety = ReturnType<
  typeof createRuntimeArtifactSafety
>;
