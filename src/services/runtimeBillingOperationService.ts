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
}>;
const owners = new WeakSet<RuntimeBillingOwner>();
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
): Promise<T> {
  const pending = new Set<Promise<unknown>>();
  const owner: RuntimeBillingOwner = {
    signal,
    effect: async <V>(effect: () => Promise<V>): Promise<V> => {
      if (!owners.has(owner))
        throw new RuntimeAdmissionUnavailable(
          "Billing owner is no longer active",
        );
      const task = track(async () => {
        try {
          return { kind: "acknowledged" as const, value: await effect() };
        } catch (error) {
          if (
            knownRejection(error) ||
            (signal.aborted && error === signal.reason)
          )
            return { kind: "rejected" as const, error };
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
      }
    },
  };
  owners.add(owner);
  try {
    return await owner.effect(() => run(owner));
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
    lifetime(operation.signal, operation.mutate, run),
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
  return lifetime(signal, (effect) => work.trackBillingMutation(effect), run);
}
