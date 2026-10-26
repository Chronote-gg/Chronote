import { readRenewalCoverageCandidate } from "./renewalRecoveryCoverageEvidence";
import { isDeepStrictEqual } from "node:util";
import { readLedgerWriterRuntime } from "./ledgerWriterRuntime";
import { RENEWAL_RECOVERY_WRITER_VERSION } from "../types/renewalRecovery";
import { cancelUnpaidRenewal } from "./renewalRecoveryProvider";
import { reconcileBillingChangeForWebhook } from "./billingChangeService";
import { reconcileSubscription } from "./subscriptionReconciliation";
import { assertStripePayer } from "./billingPayerService";
import { BillingActionError } from "./billingActionError";
import { randomUUID } from "node:crypto";
import type {
  StripeClient,
  StripeSubscription,
  StripeInvoice,
  StripeEffect,
} from "../types/stripe";
import type { GuildSubscription } from "../types/db";
import {
  renewalRecoverySchema,
  renewalGraceDeadline,
  isRenewalRecoveryBlocking,
  type RenewalRecovery,
} from "../types/renewalRecovery";
import { getRenewalRecoveryRepository } from "../repositories/renewalRecoveryRepository";
import { getSubscriptionRepository } from "../repositories/subscriptionRepository";
import {
  assertRenewalOwner,
  readRenewalPaidBasis,
  findRenewalInvoice,
  verifyRenewalInvoice,
} from "./renewalRecoveryEvidence";
import { config } from "./configService";
import { stripeId, changeUnavailable } from "./billingChangeProvider";
import { clearGuildSubscriptionCache } from "./subscriptionCache";

type Context = {
  stripe: StripeClient;
  guildId: string;
  now: number;
  signal?: AbortSignal;
  effect?: StripeEffect;
};
export async function trackPaidRenewalPeriod(
  input: Context & { subscriptionId: string; invoiceId: string },
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await registerPaidRenewalPeriod(input)) return;
  }
  throw changeUnavailable();
}
async function registerPaidRenewalPeriod(
  input: Context & { subscriptionId: string; invoiceId: string },
): Promise<boolean> {
  const saved = await getSubscriptionRepository().get(input.guildId);
  if (!saved || saved.stripeSubscriptionId !== input.subscriptionId)
    return true;
  const subscription = await input.stripe.subscriptions.retrieve(
    input.subscriptionId,
  );
  const customerId = stripeId(subscription.customer);
  if (!customerId) throw changeUnavailable();
  const mode = subscription.livemode ? "live" : "test";
  assertRenewalOwner(subscription, {
    guildId: input.guildId,
    subscriptionId: input.subscriptionId,
    customerId: saved.stripeCustomerId ?? customerId,
    mode: config.subscription.stripeMode === "live" ? "live" : "test",
  });
  const paid = await readRenewalPaidBasis(
    input.stripe,
    subscription,
    input.guildId,
    input.invoiceId,
  );
  const current = await getRenewalRecoveryRepository().getCurrent(
    input.guildId,
  );
  if (current?.subscriptionId === subscription.id) {
    if (isDeepStrictEqual(current.paid, paid)) return true;
    if (current.paid.periodStart > paid.periodStart) return true;
    if (
      current.state !== "watching" &&
      current.paid.periodEnd >= paid.periodEnd
    )
      return true;
  }
  const record = renewalRecoverySchema.parse({
    guildId: input.guildId,
    subscriptionId: subscription.id,
    customerId,
    payerId: subscription.metadata.discord_id,
    mode,
    paid,
    revision: randomUUID(),
    scheduledOperationId: null,
    enforcementAccepted: false,
    writerVersion: RENEWAL_RECOVERY_WRITER_VERSION,
    writerRuntime: await readLedgerWriterRuntime(
      process.env.ECS_CONTAINER_METADATA_URI_V4,
    ),
    state: "watching",
    nextCheckAt: paid.periodEnd,
  });
  return getRenewalRecoveryRepository().register({
    record,
    expectedSubscription: saved,
  });
}

async function catchUpPaidWatch(
  input: Context,
  record: RenewalRecovery,
  pointer: GuildSubscription,
): Promise<boolean> {
  let candidate;
  try {
    candidate = await readRenewalCoverageCandidate({
      stripe: input.stripe,
      saved: { ...pointer, stripeCustomerId: record.customerId },
      mode: record.mode,
    });
  } catch (error) {
    if (error instanceof BillingActionError) return false;
    throw error;
  }
  if (!candidate || candidate.paid.periodEnd <= record.paid.periodEnd)
    return false;
  const registered = await getRenewalRecoveryRepository().register({
    record: {
      ...candidate,
      writerVersion: record.writerVersion,
      writerRuntime: record.writerRuntime,
    },
    expectedSubscription: pointer,
  });
  if (!registered) throw changeUnavailable();
  clearGuildSubscriptionCache(record.guildId);
  return true;
}
async function saveRecovery(
  next: RenewalRecovery,
  previous: RenewalRecovery,
  pointer: GuildSubscription,
): Promise<RenewalRecovery> {
  if (
    !(await getRenewalRecoveryRepository().compareAndWrite({
      next,
      expectedRevision: previous.revision,
      expectedSubscription: pointer,
      blocking: isRenewalRecoveryBlocking(next),
    }))
  )
    throw changeUnavailable();
  clearGuildSubscriptionCache(next.guildId);
  return next;
}
function isRefreshableRecovery(
  record: RenewalRecovery | undefined,
): record is Extract<RenewalRecovery, { state: "watching" | "grace" }> {
  return record?.state === "watching" || record?.state === "grace";
}
export async function refreshRenewalRecovery(
  input: Context,
): Promise<RenewalRecovery | undefined> {
  const record = await getRenewalRecoveryRepository().getCurrent(input.guildId);
  if (!isRefreshableRecovery(record)) return record;
  const pointer = await getSubscriptionRepository().get(input.guildId);
  if (
    !pointer ||
    pointer.stripeSubscriptionId !== record.subscriptionId ||
    (pointer.stripeCustomerId && pointer.stripeCustomerId !== record.customerId)
  )
    return record;
  if (
    record.state === "watching" &&
    input.now < record.paid.periodEnd &&
    pointer.status !== "canceled"
  )
    return record;
  const subscription = await input.stripe.subscriptions.retrieve(
    record.subscriptionId,
  );
  assertRenewalOwner(subscription, record);
  if (record.state === "watching") {
    const advanced = await catchUpPaidWatch(input, record, pointer);
    if (advanced) return refreshRenewalRecovery(input);
  }
  const invoice = await findRenewalInvoice(input.stripe, record, subscription);
  if (!invoice) {
    if (subscription.status === "canceled" && record.state === "watching") {
      const { nextCheckAt, ...base } = record;
      void nextCheckAt;
      return saveRecovery(
        renewalRecoverySchema.parse({
          ...base,
          state: "ended",
          revision: randomUUID(),
        }),
        record,
        pointer,
      );
    }
    return postpone(input, record, pointer);
  }
  return observeRenewalInvoice(input, record, pointer, subscription, invoice);
}
async function observeRenewalInvoice(
  input: Context,
  record: Extract<RenewalRecovery, { state: "watching" | "grace" }>,
  pointer: GuildSubscription,
  subscription: StripeSubscription,
  invoice: StripeInvoice,
): Promise<RenewalRecovery> {
  const evidence = await verifyRenewalInvoice(invoice, record, subscription);
  const finalizedAt = invoice.status_transitions.finalized_at;
  if (!finalizedAt || invoice.status === "draft")
    return postpone(input, record, pointer);
  const bound = {
    invoice: {
      id: invoice.id,
      lineId: evidence.line.id,
      finalizedAt,
      periodStart: evidence.line.period.start,
      periodEnd: evidence.line.period.end,
    },
    endsAt: renewalGraceDeadline(finalizedAt),
  };
  if (invoice.status === "paid" && invoice.amount_remaining === 0) {
    const { nextCheckAt, ...base } = record;
    void nextCheckAt;
    return saveRecovery(
      renewalRecoverySchema.parse({
        ...base,
        ...bound,
        scheduledOperationId: evidence.scheduledOperationId,
        state: "paid",
        projection: { state: "pending", nextCheckAt: input.now },
        revision: randomUUID(),
      }),
      record,
      pointer,
    );
  }
  if (record.state === "grace") {
    if (record.enforcementAccepted) return record;
    if (!config.stripe.renewalGraceEnabled)
      return postpone(input, record, pointer);
    return saveRecovery(
      {
        ...record,
        enforcementAccepted: true,
        revision: randomUUID(),
        nextCheckAt: record.endsAt,
      },
      record,
      pointer,
    );
  }
  if (
    !invoice.attempted &&
    invoice.status !== "void" &&
    invoice.status !== "uncollectible"
  )
    return postpone(input, record, pointer);
  return saveRecovery(
    renewalRecoverySchema.parse({
      ...record,
      ...bound,
      scheduledOperationId: evidence.scheduledOperationId,
      state: "grace",
      enforcementAccepted: config.stripe.renewalGraceEnabled,
      revision: randomUUID(),
      nextCheckAt: Math.max(bound.endsAt, input.now + 60),
    }),
    record,
    pointer,
  );
}
function postpone(
  input: Context,
  record: RenewalRecovery,
  pointer: GuildSubscription,
): Promise<RenewalRecovery> {
  if (!("nextCheckAt" in record)) return Promise.resolve(record);
  return saveRecovery(
    { ...record, revision: randomUUID(), nextCheckAt: input.now + 60 },
    record,
    pointer,
  );
}

export async function completeRenewalPaidProjection(
  guildId: string,
  subscription: StripeSubscription,
  saved: GuildSubscription,
  stripe?: StripeClient,
): Promise<void> {
  const record = await getRenewalRecoveryRepository().getCurrent(guildId);
  if (
    !record ||
    (record.state !== "paid" && record.state !== "superseded") ||
    record.projection.state === "complete"
  )
    return;
  assertRenewalOwner(subscription, record);
  const item = subscription.items.data[0];
  let paidPeriod =
    record.state === "superseded" ? record.replacementPaid : record.invoice;
  if (stripe && item.current_period_start >= paidPeriod.periodEnd) {
    const candidate = await readRenewalCoverageCandidate({
      stripe,
      saved: { ...saved, stripeCustomerId: record.customerId },
      mode: record.mode,
    });
    if (!candidate || candidate.paid.periodEnd < paidPeriod.periodEnd)
      throw changeUnavailable();
    paidPeriod = candidate.paid;
  }
  const projectedPeriod = matchesProjectedPeriod(
    subscription,
    paidPeriod,
    Boolean(stripe),
  );
  if (
    !projectedPeriod ||
    saved.status !== subscription.status ||
    saved.stripeSubscriptionId !== record.subscriptionId ||
    saved.priceId !== item.price.id
  )
    throw changeUnavailable();
  await saveRecovery(
    { ...record, revision: randomUUID(), projection: { state: "complete" } },
    record,
    saved,
  );
}

function matchesProjectedPeriod(
  subscription: StripeSubscription,
  paidPeriod: { periodStart: number; periodEnd: number },
  verifiedHistory: boolean,
): boolean {
  const item = subscription.items.data[0];
  if (subscription.status === "active")
    return (
      item.current_period_start === paidPeriod.periodStart &&
      item.current_period_end === paidPeriod.periodEnd
    );
  return (
    verifiedHistory &&
    ["past_due", "unpaid"].includes(subscription.status) &&
    item.current_period_start >= paidPeriod.periodEnd
  );
}
async function beginRenewalCancellation(
  input: Context,
  record: Extract<RenewalRecovery, { state: "grace" }>,
  reason: "payer" | "expired",
): Promise<RenewalRecovery> {
  const pointer = await getSubscriptionRepository().get(input.guildId);
  if (!pointer || pointer.stripeSubscriptionId !== record.subscriptionId)
    throw changeUnavailable();
  return saveRecovery(
    renewalRecoverySchema.parse({
      ...record,
      state: "canceling",
      reason,
      revision: randomUUID(),
      nextCheckAt: input.now,
      receipts: {
        creditNoteId: null,
        refundIds: [],
        canceled: false,
        collectionRestored: false,
        unrelatedInvoices: [],
      },
    }),
    record,
    pointer,
  );
}
export async function cancelRenewalRecovery(
  input: Context & { payerId: string },
): Promise<void> {
  return cancelOwnedRecovery(input, null);
}
export async function cancelScheduledRenewalRecovery(
  input: Context & { payerId: string; operationId: string },
): Promise<void> {
  return cancelOwnedRecovery(input, input.operationId);
}
async function cancelOwnedRecovery(
  input: Context & { payerId: string },
  scheduledOperationId: string | null,
): Promise<void> {
  const record = await getRenewalRecoveryRepository().getCurrent(input.guildId);
  if (!record || record.mode !== config.subscription.stripeMode)
    throw changeUnavailable();
  if (record.payerId !== input.payerId)
    throw new BillingActionError(
      "FORBIDDEN",
      "Only the original payer can cancel this renewal.",
    );
  await assertStripePayer({
    stripe: input.stripe,
    customerId: record.customerId,
    payerId: input.payerId,
  });
  if (
    scheduledOperationId
      ? record.scheduledOperationId !== scheduledOperationId
      : !record.enforcementAccepted
  )
    throw changeUnavailable();
  // Explicit cancellation of an owned scheduled change also works during passive
  // rollout. It does not accept enforcement or grant courtesy access.

  if (record.state === "grace")
    await beginRenewalCancellation(input, record, "payer");
  else if (!["canceling", "paid", "canceled"].includes(record.state))
    throw changeUnavailable();
  await reconcileRenewalRecovery(input);
}
async function repairRenewalPaidAccess(
  input: Context,
  record: Extract<RenewalRecovery, { state: "paid" | "superseded" }>,
): Promise<void> {
  await reconcileBillingChangeForWebhook(
    input.stripe,
    input.guildId,
    input.effect,
  );
  await reconcileSubscription(
    input.stripe,
    input.guildId,
    record.subscriptionId,
  );
  const saved = await getSubscriptionRepository().get(input.guildId);
  if (!saved || saved.stripeSubscriptionId !== record.subscriptionId) return;
  const subscription = await input.stripe.subscriptions.retrieve(
    record.subscriptionId,
  );
  await completeRenewalPaidProjection(
    input.guildId,
    subscription,
    saved,
    input.stripe,
  );
  if (subscription.status === "active")
    await trackPaidRenewalPeriod({
      ...input,
      subscriptionId: record.subscriptionId,
      invoiceId: stripeId(subscription.latest_invoice) ?? "",
    });
  else {
    const candidate = await readRenewalCoverageCandidate({
      stripe: input.stripe,
      saved,
      mode: record.mode,
    });
    if (!candidate) throw changeUnavailable();
    if (
      !(await getRenewalRecoveryRepository().register({
        record: {
          ...candidate,
          writerVersion: record.writerVersion,
          writerRuntime: record.writerRuntime,
        },
        expectedSubscription: saved,
      }))
    )
      throw changeUnavailable();
    await reconcileRenewalRecovery(input);
  }
}
async function finishRenewalCancellation(
  input: Context,
  initial: Extract<RenewalRecovery, { state: "canceling" }>,
): Promise<void> {
  let record = initial;
  const result = await cancelUnpaidRenewal({
    ...input,
    recovery: initial,
    onReceipt: async (next) => {
      if (next.state !== "canceling") throw changeUnavailable();
      const pointer = await getSubscriptionRepository().get(input.guildId);
      if (!pointer) throw changeUnavailable();
      await saveRecovery(next, record, pointer);
      record = next;
    },
  });
  if (result === "pending") return;
  if (typeof result === "object") {
    const { nextCheckAt, reason, ...base } = record;
    void nextCheckAt;
    void reason;
    const next = renewalRecoverySchema.parse({
      ...base,
      state: "superseded",
      revision: randomUUID(),
      replacementPaid: result.paid,
      projection: { state: "pending", nextCheckAt: input.now },
    });
    const pointer = await getSubscriptionRepository().get(input.guildId);
    if (!pointer) throw changeUnavailable();
    await saveRecovery(next, record, pointer);
    if (next.state !== "superseded") throw changeUnavailable();
    return repairRenewalPaidAccess(input, next);
  }
  if (result === "paid") {
    const { nextCheckAt, reason, receipts, ...base } = record;
    void nextCheckAt;
    void reason;
    void receipts;
    const next = renewalRecoverySchema.parse({
      ...base,
      state: "paid",
      revision: randomUUID(),
      projection: { state: "pending", nextCheckAt: input.now },
    });
    const pointer = await getSubscriptionRepository().get(input.guildId);
    if (!pointer) throw changeUnavailable();
    await saveRecovery(next, record, pointer);
    if (next.state !== "paid") throw changeUnavailable();
    return repairRenewalPaidAccess(input, next);
  }
  await reconcileBillingChangeForWebhook(
    input.stripe,
    input.guildId,
    input.effect,
  );
  await reconcileSubscription(
    input.stripe,
    input.guildId,
    record.subscriptionId,
  );
  const pointer = await getSubscriptionRepository().get(input.guildId);
  if (
    !pointer ||
    pointer.stripeSubscriptionId !== record.subscriptionId ||
    pointer.status !== "canceled"
  )
    throw changeUnavailable();
  const { nextCheckAt, ...base } = record;
  void nextCheckAt;
  await saveRecovery(
    renewalRecoverySchema.parse({
      ...base,
      state: "canceled",
      revision: randomUUID(),
    }),
    record,
    pointer,
  );
}
export async function reconcileRenewalRecovery(
  input: Context & { signal?: AbortSignal },
): Promise<void> {
  input.signal?.throwIfAborted();
  let record = await refreshRenewalRecovery(input);
  if (!record) return;
  if (
    (record.state === "paid" || record.state === "superseded") &&
    record.projection.state === "pending"
  )
    return repairRenewalPaidAccess(input, record);
  if (
    record.state === "grace" &&
    record.enforcementAccepted &&
    input.now >= record.endsAt
  )
    record = await beginRenewalCancellation(input, record, "expired");
  if (record.state !== "canceling") return;
  input.signal?.throwIfAborted();
  await finishRenewalCancellation(input, record);
}
