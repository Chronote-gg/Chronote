import { runBillingWorkerOperation } from "./runtimeBillingOperationService";
import { getRenewalRecoveryRepository } from "../repositories/renewalRecoveryRepository";
import {
  renewalRecoveryKey,
  renewalRecoveryNextCheck,
} from "../types/renewalRecovery";
import type { StripeClient } from "../types/stripe";
import { config } from "./configService";
import { reconcileRenewalRecovery } from "./renewalRecoveryService";
import { operationSignal } from "./shutdownSignal";
import { getJobLeaseRepository } from "../repositories/jobLeaseRepository";
import { RENEWAL_RECOVERY_STALLED_LOG } from "../metrics";
import { getRuntimeInstanceId } from "./runtimeInstanceService";
import { LIFECYCLE } from "./lifecycleTiming";
import { isEligible } from "./workerRegistry";

let timer: ReturnType<typeof setInterval> | undefined;
let pending: Promise<void> | undefined;
let controller: AbortController | undefined;
type Poll = { stripe: StripeClient; now: number; signal: AbortSignal };
async function processRecovery(key: string, input: Poll): Promise<void> {
  const record = await getRenewalRecoveryRepository().get(key);
  const due = record ? renewalRecoveryNextCheck(record) : undefined;
  if (
    !record ||
    record.mode !== config.subscription.stripeMode ||
    due === undefined ||
    due > input.now
  )
    return;
  const current = await getRenewalRecoveryRepository().getCurrent(
    record.guildId,
  );
  if (!current || renewalRecoveryKey(current) !== key) return;
  const signal = operationSignal(input.signal);
  await runBillingWorkerOperation(signal, (owner) =>
    reconcileRenewalRecovery({
      stripe: input.stripe,
      guildId: record.guildId,
      now: input.now,
      signal,
      owner,
      effect: owner.effect,
    }),
  );
}
const RENEWAL_RECOVERY_JOB = "renewal-recovery";
const renewalRecoveryLease = () => ({
  name: RENEWAL_RECOVERY_JOB,
  owner: getRuntimeInstanceId(),
});
/**
 * Two overlapping polls can decide from a stale invoice read, so only the lease holder polls.
 * Taken at the start of a poll and again before every due record, so a poll that outlives its
 * lease stops at the next record instead of overlapping the next owner.
 */
async function holdsRenewalRecoveryLease(): Promise<boolean> {
  try {
    const held = await getJobLeaseRepository().tryAcquireJobLease({
      ...renewalRecoveryLease(),
      now: Math.floor(Date.now() / 1000),
      ttlSeconds: LIFECYCLE.renewalRecoveryLeaseSeconds,
    });
    if (!held) console.debug("Renewal recovery poll skipped: lease held");
    return held;
  } catch (error) {
    console.warn(
      RENEWAL_RECOVERY_STALLED_LOG,
      error instanceof Error ? error.name : "unknown",
    );
    return false;
  }
}
/** For orderly shutdown, after the worker has stopped, so the next worker need not wait out the lease. */
export function releaseRenewalRecoveryLease(): Promise<void> {
  return getJobLeaseRepository().releaseJobLease(renewalRecoveryLease());
}
export async function runRenewalRecoveryPoll(input: Poll): Promise<void> {
  input.signal.throwIfAborted();
  const mode = config.subscription.stripeMode;
  if (mode !== "test" && mode !== "live") return;
  if (!(await holdsRenewalRecoveryLease())) return;
  let cursor: string | undefined;
  do {
    input.signal.throwIfAborted();
    const page = await getRenewalRecoveryRepository().listDue({
      mode,
      now: input.now,
      limit: 25,
      cursor,
    });
    for (const key of page.keys) {
      input.signal.throwIfAborted();
      if (!(await holdsRenewalRecoveryLease())) return;
      try {
        await processRecovery(key, input);
      } catch (error) {
        console.warn("Renewal recovery remains pending", { key, error });
      }
    }
    cursor = page.cursor;
  } while (cursor);
}
export async function verifyRenewalRecoveryReadiness(
  stripe: StripeClient,
): Promise<void> {
  if (!config.stripe.renewalGraceEnabled) return;
  const mode = config.subscription.stripeMode;
  if (mode !== "test" && mode !== "live")
    throw new Error("Renewal grace requires an explicit provider mode");
  const balance = await stripe.balance.retrieve();
  if (balance.livemode !== (mode === "live"))
    throw new Error("Renewal grace provider mode mismatch");
  await getRenewalRecoveryRepository().listDue({
    mode,
    now: Math.floor(Date.now() / 1000),
    limit: 1,
  });
}
export function startRenewalRecoveryWorker(stripe: StripeClient): void {
  if (timer) return;
  controller = new AbortController();
  const signal = controller.signal;
  const poll = () => {
    if (pending || signal.aborted || !isEligible()) return;
    pending = runRenewalRecoveryPoll({
      stripe,
      now: Math.floor(Date.now() / 1000),
      signal,
    })
      .catch((error) => {
        if (!signal.aborted)
          console.warn("Renewal recovery poll failed", error);
      })
      .finally(() => {
        pending = undefined;
      });
  };
  timer = setInterval(poll, 60000);
  timer.unref();
  poll();
}
export async function stopRenewalRecoveryWorker(): Promise<void> {
  if (timer) clearInterval(timer);
  timer = undefined;
  controller?.abort();
  await pending;
}
