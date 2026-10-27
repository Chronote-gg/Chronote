import { runBillingWorkerOperation } from "./runtimeBillingOperationService";
import { getRenewalRecoveryRepository } from "../repositories/renewalRecoveryRepository";
import {
  renewalRecoveryKey,
  renewalRecoveryNextCheck,
} from "../types/renewalRecovery";
import type { StripeClient } from "../types/stripe";
import { config } from "./configService";
import { reconcileRenewalRecovery } from "./renewalRecoveryService";
import { beginRuntimeWorkClaim } from "./runtimeWorkAdmissionService";
import { getRuntimeAdmissionContext } from "./runtimeLifecycleService";

let timer: ReturnType<typeof setInterval> | undefined;
let pending: Promise<void> | undefined;
let controller: AbortController | undefined;
type Poll = { stripe: StripeClient; now: number; signal: AbortSignal };
async function processRecovery(key: string, input: Poll): Promise<void> {
  let work;
  try {
    work = beginRuntimeWorkClaim("billing", key);
  } catch {
    return;
  }
  await work.trackPromise(async () => {
    try {
      await work.authority();
      const record = await work.trackEffect(() =>
        getRenewalRecoveryRepository().get(key),
      );
      const due = record ? renewalRecoveryNextCheck(record) : undefined;
      if (
        !record ||
        record.mode !== config.subscription.stripeMode ||
        due === undefined ||
        due > input.now
      )
        return;
      const current = await work.trackEffect(() =>
        getRenewalRecoveryRepository().getCurrent(record.guildId),
      );
      if (!current || renewalRecoveryKey(current) !== key) return;
      const signal = AbortSignal.any([input.signal, work.signal]);
      await runBillingWorkerOperation(work, signal, async (owner) => {
        work.acknowledgeDurableBillingRecovery(key);
        await reconcileRenewalRecovery({
          stripe: input.stripe,
          guildId: record.guildId,
          now: input.now,
          signal,
          owner,
          effect: owner.effect,
        });
      });
    } finally {
      work.acknowledgeReadOnlyRecoveryPoll();
      await work.settle();
    }
  });
}
export async function runRenewalRecoveryPoll(input: Poll): Promise<void> {
  input.signal.throwIfAborted();
  await getRuntimeAdmissionContext();
  const mode = config.subscription.stripeMode;
  if (mode !== "test" && mode !== "live") return;
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
    if (pending || signal.aborted) return;
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
