import { randomUUID } from "node:crypto";
import Stripe from "stripe";
import { getDeploymentControlRepository } from "../db";
import type { StripeEffect } from "../types/stripe";
import { BillingActionError } from "./billingActionError";
import { RuntimeAdmissionUnavailable } from "./runtimeAdmissionError";
import { runRuntimeApiOperation } from "./runtimeApiOperationService";
import type { RuntimeWorkClaim } from "./runtimeWorkAdmissionService";

export type RuntimeBillingOwner = Readonly<{
  signal: AbortSignal;
  effect: StripeEffect;
  mutationStarted(): boolean;
  settleEffects(): Promise<void>;
}>;
const owners = new WeakMap<RuntimeBillingOwner, StripeEffect>();
export class UnresolvedBillingMutation extends Error {
  constructor(cause: unknown) {
    super(
      cause instanceof Error
        ? cause.message
        : "Billing mutation outcome is unresolved",
      { cause },
    );
  }
}
/** Receipt failure after a provider ACK is uncertainty, even when a domain CAS reports BAD_REQUEST. */
export function persistBillingAcknowledgment<T>(
  owner: RuntimeBillingOwner,
  write: () => Promise<T>,
): Promise<T> {
  const persist = owners.get(owner);
  if (!persist)
    return Promise.reject(
      new RuntimeAdmissionUnavailable("Billing owner is not registered"),
    );
  return persist(write);
}
function knownRejection(error: unknown): boolean {
  return (
    error instanceof BillingActionError ||
    ((error instanceof Stripe.errors.StripeInvalidRequestError ||
      error instanceof Stripe.errors.StripeCardError) &&
      error.statusCode !== undefined &&
      error.statusCode >= 400 &&
      error.statusCode < 500)
  );
}
/** A matching later read does not acknowledge a dispatched request whose response was lost. */
export function assertBillingDispatchOutcomeKnown(error: unknown): void {
  if (!knownRejection(error)) throw new UnresolvedBillingMutation(error);
}
async function lifetime<T>(
  signal: AbortSignal,
  track: StripeEffect,
  run: (owner: RuntimeBillingOwner) => Promise<T>,
  unresolved: () => void,
): Promise<T> {
  const pending = new Set<Promise<unknown>>();
  let pendingMutations = 0;
  let mutationUnknown = false;
  let mutationAcknowledged = false;
  const owner: RuntimeBillingOwner = {
    signal,
    mutationStarted: () =>
      mutationAcknowledged || mutationUnknown || pendingMutations > 0,
    async settleEffects() {
      while (pending.size) await Promise.allSettled([...pending]);
      if (mutationUnknown)
        throw new UnresolvedBillingMutation(
          "Nested billing outcome unresolved",
        );
    },
    effect: async <V>(effect: () => Promise<V>): Promise<V> => {
      if (!owners.has(owner))
        throw new RuntimeAdmissionUnavailable(
          "Billing owner is no longer active",
        );
      signal.throwIfAborted();
      pendingMutations++;
      const task = track(async () => {
        try {
          const value = await effect();
          // Repository CAS false is an acknowledged no-write result.
          if (value !== false) mutationAcknowledged = true;
          return { kind: "acknowledged" as const, value };
        } catch (error) {
          if (
            knownRejection(error) ||
            (signal.aborted && error === signal.reason)
          )
            return { kind: "rejected" as const, error };
          mutationUnknown = true;
          unresolved();
          throw error instanceof UnresolvedBillingMutation
            ? error
            : new UnresolvedBillingMutation(error);
        }
      });
      pending.add(task);
      try {
        const result = await task;
        if (result.kind === "rejected") throw result.error;
        return result.value;
      } finally {
        pending.delete(task);
        pendingMutations--;
      }
    },
  };
  owners.set(owner, async <V>(write: () => Promise<V>): Promise<V> => {
    // Only explicit ACK persistence may finish after cancellation, under this same lifetime.
    const task = Promise.resolve().then(write);
    pending.add(task);
    try {
      const result = await task;
      if (result === false)
        throw new Error("Billing acknowledgment receipt was not persisted");
      mutationAcknowledged = true;
      return result;
    } catch (error) {
      mutationUnknown = true;
      unresolved();
      throw new UnresolvedBillingMutation(error);
    } finally {
      pending.delete(task);
    }
  });
  try {
    const result = await run(owner);
    await owner.settleEffects();
    return result;
  } catch (error) {
    while (pending.size) await Promise.allSettled([...pending]);
    if (
      error instanceof UnresolvedBillingMutation ||
      mutationAcknowledged ||
      mutationUnknown
    ) {
      unresolved();
      throw error instanceof UnresolvedBillingMutation
        ? error
        : new UnresolvedBillingMutation(error);
    }
    throw error;
  } finally {
    while (pending.size) await Promise.allSettled([...pending]);
    owners.delete(owner);
  }
}
/** Missing owner starts one admission; a supplied stale or fabricated owner never remints. */
export function runBillingOperation<T>(
  owner: RuntimeBillingOwner | undefined,
  run: (owner: RuntimeBillingOwner) => Promise<T>,
): Promise<T> {
  if (owner) {
    if (!owners.has(owner))
      return Promise.reject(
        new RuntimeAdmissionUnavailable("Billing owner is not registered"),
      );
    return run(owner);
  }
  return runRuntimeApiOperation(`billing:${randomUUID()}`, (operation) =>
    lifetime(operation.signal, operation.mutate, run, operation.unresolved),
  );
}
/** The worker's only registration seam checks admission and claims before creating its owner. */
export async function runBillingWorkerOperation<T>(
  work: RuntimeWorkClaim,
  signal: AbortSignal,
  run: (owner: RuntimeBillingOwner) => Promise<T>,
): Promise<T> {
  const authority = await work.authority();
  if (authority.kind !== "serving")
    throw new RuntimeAdmissionUnavailable(
      "Billing worker requires serving authority",
    );
  const admission = await getDeploymentControlRepository().checkAdmission(
    authority.context,
  );
  if (admission.kind !== "admitted")
    throw new RuntimeAdmissionUnavailable(
      "Runtime is not accepting billing work",
    );
  work.claimed();
  return lifetime(
    signal,
    (effect) => work.trackBillingMutation(effect),
    run,
    work.markBillingOutcomeUnknown,
  );
}

export function runBillingReceiptOperation<T>(
  id: string,
  admit: (
    context: import("../types/deploymentControl").AdmissionContext,
  ) => Promise<boolean>,
  run: (owner: RuntimeBillingOwner) => Promise<T>,
): Promise<T> {
  return runRuntimeApiOperation(
    id,
    (operation) =>
      lifetime(operation.signal, operation.mutate, run, operation.unresolved),
    admit,
  );
}
