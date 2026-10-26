import type {
  RuntimeWorkHandle,
  WorkAdmissionAuthority,
  SessionOwnership,
  SessionReservation,
} from "../types/deploymentControl";
import {
  beginRuntimeWork,
  getRuntimeAdmissionContext,
} from "./runtimeLifecycleService";
import {
  getOwnedSessionReservations,
  getReservationSignal,
  isReservationControlEligible,
} from "./activeMeetingLeaseService";

type Domain =
  | "control"
  | "personal"
  | "recovery"
  | "interaction"
  | "ancillary"
  | "api_correction"
  | "billing";
type ClaimCheckpoint = {
  claimId: string;
  instanceId: string;
  attempt?: number;
  expiresAt: number;
};
type Checkpoint = {
  id: string;
  domain: Domain;
  stage: "pending" | "owned" | "unresolved";
  controller: AbortController;
  handle: RuntimeWorkHandle;
  claim?: ClaimCheckpoint;
  session?: SessionOwnership;
  localSettled: boolean;
  ownedPromise?: Promise<unknown>;
  ownedSettled?: boolean;
  effects: Set<Promise<unknown>>;
  terminalAcknowledged?: ClaimCheckpoint;
  terminalAcknowledgedDomain?: Domain;
  apiOutcomeKnown?: boolean;
  recoveryPollAcknowledged?: boolean;
  billingMutationStarted?: boolean;
  billingRecoveryAcknowledged?: boolean;
  interactionReceiptAcknowledged?: boolean;
  interactionDeferAcknowledged?: boolean;
  interactionStopAcknowledged?: boolean;
};
const work = new Map<string, Checkpoint>();
const closingSessions = new WeakSet<SessionReservation>();

function resolveParentSession(
  domain: Domain,
  session?: { guildId: string; meetingId?: string },
) {
  const owned = session
    ? getOwnedSessionReservations().find(
        ({ reservation }) =>
          reservation.guildId === session.guildId &&
          (!session.meetingId || reservation.meetingId === session.meetingId),
      )
    : undefined;
  if (session && (!owned || !["control", "interaction"].includes(domain)))
    throw new Error("Session control is not locally owned");
  if (owned) getReservationSignal(owned.reservation).throwIfAborted();
  const parent = owned?.reservation;
  if (
    parent &&
    (closingSessions.has(parent) || !isReservationControlEligible(parent))
  )
    throw new Error("Session control ownership is closing");
  return parent;
}

/** Counts before admission I/O. Unknown writes stay counted for R3 reconciliation. */
export function beginRuntimeWorkClaim(
  domain: Domain,
  id: string,
  session?: { guildId: string; meetingId?: string },
) {
  if (work.has(id)) throw new Error("Runtime work is already registered");
  const parent = resolveParentSession(domain, session);
  const registration = parent
    ? undefined
    : beginRuntimeWork("pending_admission");
  const handle = parent ? parent.workHandle.beginOwnedControl() : registration!;
  const checkpoint: Checkpoint = {
    id,
    domain,
    stage: "pending",
    controller: new AbortController(),
    handle,
    session: parent
      ? {
          guildId: parent.guildId,
          meetingId: parent.meetingId,
          ownerInstanceId: parent.ownerInstanceId,
          executionVersion: parent.executionVersion,
          voiceOperationAttemptId: parent.voiceOperationAttemptId,
        }
      : undefined,
    localSettled: false,
    apiOutcomeKnown: domain === "api_correction" ? true : undefined,
    effects: new Set(),
  };
  const parentSignal = parent ? getReservationSignal(parent) : undefined;
  const onParentFence = () => {
    checkpoint.stage = "unresolved";
    checkpoint.controller.abort();
  };
  parentSignal?.addEventListener("abort", onParentFence, { once: true });
  work.set(id, checkpoint);
  let acceptingEffects = true;
  function ownEffect<T>(
    run: () => Promise<T>,
    assertAllowed: () => void,
  ): Promise<T> {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (error: unknown) => void;
    const effect = new Promise<T>((done, failed) => {
      resolve = done;
      reject = failed;
    });
    checkpoint.effects.add(effect);
    void effect.then(
      () => checkpoint.effects.delete(effect),
      () => checkpoint.effects.delete(effect),
    );
    try {
      if (!acceptingEffects)
        throw new Error("Runtime work effects are closing");
      assertAllowed();
      resolve(run());
    } catch (error) {
      reject(error);
    }
    return effect;
  }
  function releaseLocalIfSettled() {
    if (
      work.get(id) !== checkpoint ||
      !checkpoint.localSettled ||
      checkpoint.effects.size ||
      (checkpoint.ownedPromise && !checkpoint.ownedSettled)
    )
      return;
    if (checkpoint.controller.signal.aborted) {
      releaseAcknowledgedRuntimeWork(id);
      return;
    }
    handle.settle();
    work.delete(id);
  }
  function completeOwnedPromise() {
    checkpoint.ownedSettled = true;
    releaseLocalIfSettled();
  }
  return {
    signal: checkpoint.controller.signal,
    trackPromise<T>(run: () => Promise<T>): Promise<T> {
      let resolve!: (value: T | PromiseLike<T>) => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<T>((done, failed) => {
        resolve = done;
        reject = failed;
      });
      checkpoint.ownedPromise = promise;
      checkpoint.ownedSettled = false;
      void promise.then(completeOwnedPromise, completeOwnedPromise);
      try {
        resolve(run());
      } catch (error) {
        reject(error);
      }
      return promise;
    },
    trackEffect<T>(run: () => Promise<T>): Promise<T> {
      return ownEffect(run, () =>
        checkpoint.controller.signal.throwIfAborted(),
      );
    },
    trackApiMutation<T>(run: () => Promise<T>): Promise<T> {
      if (checkpoint.domain !== "api_correction")
        throw new Error("API mutation requires API operation ownership");
      return ownEffect(
        async () => {
          try {
            return await run();
          } catch (error) {
            checkpoint.apiOutcomeKnown = false;
            checkpoint.stage = "unresolved";
            checkpoint.controller.abort();
            throw error;
          }
        },
        () => checkpoint.controller.signal.throwIfAborted(),
      );
    },
    trackTerminalEffect<T>(
      run: () => Promise<T>,
      original: ClaimCheckpoint,
      signal: AbortSignal,
    ): Promise<T> {
      return ownEffect(run, () => {
        signal.throwIfAborted();
        const claim = checkpoint.claim;
        if (
          !claim ||
          claim.claimId !== original.claimId ||
          claim.instanceId !== original.instanceId ||
          claim.attempt !== original.attempt ||
          claim.expiresAt !== original.expiresAt
        )
          throw new Error("Terminal effect requires the exact original claim");
      });
    },
    acknowledgeInteractionReceipt() {
      if (checkpoint.domain !== "interaction")
        throw new Error("Interaction receipt requires interaction ownership");
      checkpoint.interactionReceiptAcknowledged = true;
    },
    acknowledgeInteractionDefer() {
      if (
        checkpoint.domain !== "interaction" ||
        !checkpoint.interactionReceiptAcknowledged
      )
        throw new Error(
          "Interaction defer requires its original acknowledged receipt",
        );
      checkpoint.interactionDeferAcknowledged = true;
    },
    acknowledgeInteractionStop(
      original: SessionOwnership,
      signal: AbortSignal,
      deadline: number,
    ) {
      if (
        checkpoint.domain !== "interaction" ||
        !checkpoint.interactionReceiptAcknowledged ||
        !checkpoint.interactionDeferAcknowledged ||
        !sameSession(checkpoint.session, original) ||
        signal.aborted ||
        Date.now() >= deadline
      )
        return false;
      checkpoint.interactionStopAcknowledged = true;
      return true;
    },
    trackBillingMutation<T>(run: () => Promise<T>): Promise<T> {
      if (checkpoint.domain !== "billing")
        throw new Error("Billing mutation requires billing ownership");
      return ownEffect(
        () => {
          checkpoint.billingMutationStarted = true;
          return run();
        },
        () => checkpoint.controller.signal.throwIfAborted(),
      );
    },
    acknowledgeDurableBillingRecovery(key: string) {
      if (checkpoint.domain !== "billing" || checkpoint.id !== key)
        throw new Error(
          "Billing recovery acknowledgment requires its exact durable cycle",
        );
      checkpoint.billingRecoveryAcknowledged = true;
    },
    acknowledgeReadOnlyRecoveryPoll() {
      if (checkpoint.domain === "billing") {
        if (!checkpoint.billingMutationStarted)
          checkpoint.recoveryPollAcknowledged = true;
        return;
      }
      if (checkpoint.domain !== "recovery" || checkpoint.claim)
        throw new Error("Recovery poll cannot acknowledge a processing claim");
      checkpoint.recoveryPollAcknowledged = true;
    },
    acknowledgeTerminal() {
      if (!checkpoint.claim)
        throw new Error("Terminal acknowledgment requires the original claim");
      checkpoint.terminalAcknowledged = { ...checkpoint.claim };
      checkpoint.terminalAcknowledgedDomain = checkpoint.domain;
    },
    recordClaim(claim: ClaimCheckpoint) {
      checkpoint.claim = claim;
    },
    async authority(): Promise<WorkAdmissionAuthority> {
      checkpoint.controller.signal.throwIfAborted();
      if (parent)
        return {
          kind: "session",
          ownership: parent,
          now: Math.floor(Date.now() / 1000),
        };
      const context = await getRuntimeAdmissionContext();
      checkpoint.controller.signal.throwIfAborted();
      return { kind: "serving", context };
    },
    claimed() {
      checkpoint.controller.signal.throwIfAborted();
      checkpoint.stage = "owned";
      registration?.transition(
        domain === "personal"
          ? "personal_processing"
          : domain === "recovery"
            ? "recovery_processing"
            : "ancillary_delivery",
      );
    },
    delivering() {
      checkpoint.controller.signal.throwIfAborted();
      registration?.transition("ancillary_delivery");
      checkpoint.domain = "ancillary";
    },
    fence() {
      checkpoint.stage = "unresolved";
      checkpoint.controller.abort();
    },
    async settle() {
      acceptingEffects = false;
      while (checkpoint.effects.size)
        await Promise.allSettled([...checkpoint.effects]);
      checkpoint.localSettled = true;
      parentSignal?.removeEventListener("abort", onParentFence);
      releaseLocalIfSettled();
    },
  };
}
export type RuntimeWorkClaim = ReturnType<typeof beginRuntimeWorkClaim>;
export function getRuntimeWorkAdmissionCheckpoints() {
  return [...work.values()].map(
    ({
      id,
      domain,
      stage,
      controller,
      claim,
      session,
      localSettled,
      ownedPromise,
      effects,
      terminalAcknowledged,
    }) => ({
      id,
      domain,
      stage,
      claim,
      session: session
        ? {
            guildId: session.guildId,
            meetingId: session.meetingId,
            ownerInstanceId: session.ownerInstanceId,
            executionVersion: session.executionVersion,
            voiceOperationAttemptId: session.voiceOperationAttemptId,
          }
        : undefined,
      localSettled,
      ownedPromise,
      effects: [...effects],
      terminalAcknowledged,
      signal: controller.signal,
      fenced: controller.signal.aborted,
    }),
  );
}
export function fenceRuntimeWorkAdmissions() {
  for (const entry of work.values()) {
    entry.stage = "unresolved";
    entry.controller.abort();
  }
}
export function fenceRuntimeWorkAdmission(id: string): void {
  const entry = work.get(id);
  if (!entry) return;
  entry.stage = "unresolved";
  entry.controller.abort();
}

function localLifetimeSettled(entry: Checkpoint): boolean {
  return (
    entry.localSettled &&
    entry.ownedSettled === true &&
    entry.effects.size === 0
  );
}
function sameClaim(left: ClaimCheckpoint, right: ClaimCheckpoint): boolean {
  return (
    left.claimId === right.claimId &&
    left.instanceId === right.instanceId &&
    left.attempt === right.attempt &&
    left.expiresAt === right.expiresAt
  );
}
function acknowledgedWithoutClaim(entry: Checkpoint) {
  if (entry.domain === "billing")
    return (
      entry.billingRecoveryAcknowledged ||
      (!entry.billingMutationStarted && entry.recoveryPollAcknowledged)
    );
  if (entry.domain === "api_correction") return entry.apiOutcomeKnown;
  if (entry.domain === "interaction") return entry.interactionStopAcknowledged;
  return entry.domain === "recovery" && entry.recoveryPollAcknowledged;
}
/** A terminal acknowledgment permits release only after its exact owner's complete local lifetime. */
export function releaseAcknowledgedRuntimeWork(id: string): boolean {
  const entry = work.get(id);
  if (!entry) return true;
  if (acknowledgedWithoutClaim(entry)) {
    if (!localLifetimeSettled(entry)) return false;
    entry.handle.settle();
    work.delete(id);
    return true;
  }
  const acknowledged = entry.terminalAcknowledged;
  const claim = entry.claim;
  if (
    !localLifetimeSettled(entry) ||
    !acknowledged ||
    entry.terminalAcknowledgedDomain !== entry.domain ||
    !claim ||
    !sameClaim(acknowledged, claim)
  )
    return false;
  entry.handle.settle();
  work.delete(id);
  return true;
}
function sameSession(
  left: SessionOwnership | undefined,
  right: SessionOwnership,
) {
  return (
    left?.guildId === right.guildId &&
    left.meetingId === right.meetingId &&
    left.ownerInstanceId === right.ownerInstanceId &&
    left.executionVersion === right.executionVersion &&
    left.voiceOperationAttemptId === right.voiceOperationAttemptId
  );
}
export async function fenceAndSettleSessionWork(
  session: SessionOwnership,
): Promise<boolean> {
  for (const { reservation } of getOwnedSessionReservations()) {
    if (sameSession(reservation, session)) closingSessions.add(reservation);
  }
  const children = [...work.values()].filter((entry) =>
    sameSession(entry.session, session),
  );
  for (const child of children) {
    child.stage = "unresolved";
    child.controller.abort();
  }
  await Promise.allSettled(children.map((child) => child.ownedPromise));
  for (const child of children)
    while (child.effects.size) await Promise.allSettled([...child.effects]);
  return children
    .map((child) => releaseAcknowledgedRuntimeWork(child.id))
    .every(Boolean);
}
