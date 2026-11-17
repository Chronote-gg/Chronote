import Stripe from "stripe";
import type { StripeEffect } from "../types/stripe";
import { BillingActionError } from "./billingActionError";
import { RuntimeAdmissionUnavailable } from "./runtimeAdmissionError";
import { operationSignal } from "./shutdownSignal";

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
const activeLifetimes = new Set<Promise<unknown>>();
function track<T>(settled: Promise<T>): Promise<T> {
  activeLifetimes.add(settled);
  const forget = () => activeLifetimes.delete(settled);
  void settled.then(forget, forget);
  return settled;
}
function lifetime<T>(
  outer: AbortSignal,
  run: (owner: RuntimeBillingOwner) => Promise<T>,
): Promise<T> {
  return track(ownedLifetime(outer, run));
}
/**
 * Resolves once every billing lifetime active at the call has settled, or when `signal` aborts.
 * Never rejects: a lifetime's own failure belongs to its caller.
 */
export function drainBillingOperations(signal: AbortSignal): Promise<void> {
  const active = [...activeLifetimes];
  if (signal.aborted || !active.length) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = () => {
      signal.removeEventListener("abort", done);
      resolve();
    };
    signal.addEventListener("abort", done, { once: true });
    void Promise.allSettled(active).then(done);
  });
}
async function ownedLifetime<T>(
  outer: AbortSignal,
  run: (owner: RuntimeBillingOwner) => Promise<T>,
): Promise<T> {
  // An unknown outcome fences this operation: no later mutation in it is dispatched.
  const fence = new AbortController();
  const signal = AbortSignal.any([outer, fence.signal]);
  const unresolved = () => fence.abort();
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
      const task = (async () => {
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
      })();
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
/** A missing owner starts one lifetime; a supplied stale or fabricated owner never remints. */
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
  return lifetime(operationSignal(), run);
}
export function runBillingWorkerOperation<T>(
  signal: AbortSignal,
  run: (owner: RuntimeBillingOwner) => Promise<T>,
): Promise<T> {
  return lifetime(signal, run);
}
/** The receipt's own conditional admission is the only gate before its handler runs. */
export function runBillingReceiptOperation<T>(
  admit: () => Promise<boolean>,
  run: (owner: RuntimeBillingOwner) => Promise<T>,
): Promise<T> {
  // Tracked from before the admission write, so a shutdown drain cannot miss a receipt it admits.
  return track(
    (async () => {
      if (!(await admit()))
        throw new RuntimeAdmissionUnavailable("Runtime is not accepting work");
      return lifetime(operationSignal(), run);
    })(),
  );
}
