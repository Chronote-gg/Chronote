import type { StripeEffect } from "../types/stripe";
import { getRenewalRecoveryRepository } from "../repositories/renewalRecoveryRepository";
import {
  isRenewalCancellationComplete,
  renewalRecoveryKey,
} from "../types/renewalRecovery";
import { assertRecurringOfferInvoice } from "./firstOfferInvoiceEvidence";
import type Stripe from "stripe";
import type { StripeClient, StripeSubscription } from "../types/stripe";
import type { BillingChangeOperation } from "../types/billingChange";
import {
  isUnappliedChangeSourceInvalidated,
  changeSourceFingerprint,
  changeServiceFingerprint,
  stripeId,
  changeUnavailable,
} from "./billingChangeProvider";
import { changeIdempotency, changeMetadata } from "./billingChangeFunding";
type Accepted = Extract<BillingChangeOperation, { state: "accepted" }>;
type Scheduled = Extract<
  BillingChangeOperation,
  { state: "scheduled" | "canceling" }
>;
export function buildChangeSchedulePhases(
  subscription: StripeSubscription,
  operation: Accepted,
): Stripe.SubscriptionScheduleUpdateParams.Phase[] {
  const target = operation.target;
  if (!target.priceId) throw changeUnavailable();
  const taxRates = operation.source.taxRateIds;
  return [
    {
      start_date: operation.source.periodStart,
      end_date: operation.source.periodEnd,
      items: [
        { price: operation.source.priceId, quantity: 1, tax_rates: taxRates },
      ],
      discounts: subscription.discounts.length
        ? subscription.discounts.map((discount) => ({
            discount: stripeId(discount) ?? "",
          }))
        : "",
      default_tax_rates: taxRates,
      proration_behavior: "none",
      metadata: subscription.metadata,
    },
    {
      start_date: operation.source.periodEnd,
      items: [{ price: target.priceId, quantity: 1, tax_rates: taxRates }],
      discounts: target.offer ? [{ coupon: target.offer.terms.couponId }] : "",
      default_tax_rates: taxRates,
      proration_behavior: "none",
      billing_cycle_anchor: "phase_start",
      duration: {
        interval: target.selection.interval,
        interval_count: target.offer?.terms.interval === "month" ? 3 : 1,
      },
      metadata: {
        ...changeMetadata(operation),
        chronote_scheduled_change: operation.operationId,
      },
    },
  ];
}
function unchangedService(
  subscription: StripeSubscription,
  operation: BillingChangeOperation,
) {
  const item = subscription.items.data[0];
  return (
    subscription.id === operation.source.subscriptionId &&
    stripeId(subscription.customer) === operation.source.customerId &&
    subscription.metadata.guild_id === operation.guildId &&
    subscription.livemode === (operation.mode === "live") &&
    subscription.items.data.length === 1 &&
    !subscription.items.has_more &&
    item.id === operation.source.itemId &&
    item.price.id === operation.source.priceId &&
    item.quantity === 1 &&
    item.current_period_start === operation.source.periodStart &&
    item.current_period_end === operation.source.periodEnd
  );
}
async function readScheduleSource(stripe: StripeClient, operation: Accepted) {
  const subscription = await stripe.subscriptions.retrieve(
    operation.source.subscriptionId,
    { expand: ["discounts.source.coupon"] },
  );
  if (
    subscription.id !== operation.source.subscriptionId ||
    stripeId(subscription.customer) !== operation.source.customerId ||
    subscription.metadata.guild_id !== operation.guildId ||
    subscription.livemode !== (operation.mode === "live")
  )
    throw changeUnavailable();
  return subscription;
}
function assertScheduleSourceUnchanged(
  subscription: StripeSubscription,
  operation: Accepted,
) {
  if (
    !unchangedService(subscription, operation) ||
    subscription.pending_update ||
    changeServiceFingerprint(subscription) !==
      operation.source.invariantFingerprint
  )
    throw changeUnavailable();
  const ownedMarker =
    subscription.metadata.chronote_scheduled_change === operation.operationId;
  if (
    changeSourceFingerprint(subscription) !== operation.source.fingerprint &&
    !ownedMarker &&
    !subscription.schedule
  )
    throw changeUnavailable();
}
async function scheduleFreeChange(
  stripe: StripeClient,
  operation: Accepted,
  subscription: StripeSubscription,
) {
  const cancellation =
    operation.source.billingMode === "classic"
      ? { cancel_at_period_end: true }
      : { cancel_at: operation.source.periodEnd };
  if (subscription.schedule) throw changeUnavailable();
  subscription = await stripe.subscriptions.update(
    subscription.id,
    {
      ...cancellation,
      proration_behavior: "none",
      metadata: { chronote_scheduled_change: operation.operationId },
    },
    changeIdempotency(operation, "schedule-free"),
  );
  if (
    !unchangedService(subscription, operation) ||
    (subscription.cancel_at !== operation.source.periodEnd &&
      !subscription.cancel_at_period_end)
  )
    throw changeUnavailable();
  return null;
}
async function configurePaidSchedule(
  stripe: StripeClient,
  operation: Accepted,
  subscription: StripeSubscription,
  onCreated: (scheduleId: string) => Promise<void>,
) {
  const existingScheduleId = stripeId(subscription.schedule);
  const existingSchedule = existingScheduleId
    ? await stripe.subscriptionSchedules.retrieve(existingScheduleId)
    : null;
  if (
    existingSchedule?.metadata?.chronote_change_operation &&
    existingSchedule.metadata.chronote_change_operation !==
      operation.operationId
  )
    throw changeUnavailable();
  const schedule = await recoverCreatedSchedule(
    stripe,
    operation,
    existingSchedule,
  );
  await onCreated(schedule.id);
  const updated = await stripe.subscriptionSchedules.update(
    schedule.id,
    {
      end_behavior: "release",
      proration_behavior: "none",
      phases: buildChangeSchedulePhases(subscription, operation),
      metadata: changeMetadata(operation),
    },
    changeIdempotency(operation, "set-schedule-phases"),
  );
  if (
    updated.phases.length !== 2 ||
    updated.phases[1].start_date !== operation.source.periodEnd ||
    stripeId(updated.phases[1].items[0]?.price) !== operation.target.priceId
  )
    throw changeUnavailable();
  return updated.id;
}
export async function scheduleBillingChange(
  stripe: StripeClient,
  operation: Accepted,
  onCreated: (scheduleId: string) => Promise<void> = async () => {},
): Promise<string | null> {
  const subscription = await readScheduleSource(stripe, operation);
  const currentScheduleId = stripeId(subscription.schedule);
  if (!unchangedService(subscription, operation) && currentScheduleId) {
    const scheduled =
      await stripe.subscriptionSchedules.retrieve(currentScheduleId);
    assertOwnedSchedule(scheduled, operation);
    return scheduled.id;
  }
  if (
    operation.target.selection.tier === "free" &&
    subscription.status === "canceled" &&
    subscription.metadata.chronote_scheduled_change === operation.operationId
  )
    return null;
  assertScheduleSourceUnchanged(subscription, operation);
  if (operation.target.selection.tier === "free")
    return scheduleFreeChange(stripe, operation, subscription);
  return configurePaidSchedule(stripe, operation, subscription, onCreated);
}

export async function canceledBeforeSchedule(
  stripe: StripeClient,
  operation: Extract<
    BillingChangeOperation,
    { state: "accepted" | "canceling" }
  >,
  now: number,
): Promise<boolean> {
  const boundSchedule =
    operation.state === "accepted"
      ? operation.providerScheduleId
      : operation.scheduleId;
  if (boundSchedule) return false;
  const subscription = await stripe.subscriptions.retrieve(
    operation.source.subscriptionId,
  );
  return (
    isUnappliedChangeSourceInvalidated(subscription, operation, now) &&
    !subscription.schedule &&
    subscription.metadata.chronote_scheduled_change !== operation.operationId
  );
}
export async function cancelChangeSchedule(
  stripe: StripeClient,
  operation: BillingChangeOperation,
  scheduleId: string | null,
): Promise<boolean> {
  const recovery = await getRenewalRecoveryRepository().getCurrent(
    operation.guildId,
  );
  if (
    isRenewalCancellationComplete(recovery) &&
    recovery.scheduledOperationId === operation.operationId
  ) {
    const subscription = await stripe.subscriptions.retrieve(
      operation.source.subscriptionId,
    );
    return completedRecoveryOwnsCancellation(subscription, recovery);
  }
  if (scheduleId) {
    const released = await releaseOwnedSchedule(stripe, operation, scheduleId);
    if (!released) return false;
    const subscription = await stripe.subscriptions.retrieve(
      operation.source.subscriptionId,
    );
    if (
      !unchangedService(subscription, operation) ||
      changeServiceFingerprint(subscription) !==
        operation.source.invariantFingerprint
    )
      return false;
    return restoreOriginalCancellation(stripe, operation, subscription);
  }
  if (operation.target.selection.tier !== "free") return false;
  const subscription = await stripe.subscriptions.retrieve(
    operation.source.subscriptionId,
  );
  if (!unchangedService(subscription, operation)) return false;
  if (subscription.metadata.chronote_scheduled_change !== operation.operationId)
    return false;
  return restoreOriginalCancellation(stripe, operation, subscription, true);
}
function completedRecoveryOwnsCancellation(
  subscription: StripeSubscription,
  recovery: Extract<
    import("../types/renewalRecovery").RenewalRecovery,
    { state: "canceling" | "canceled" }
  >,
): boolean {
  return (
    subscription.status === "canceled" &&
    subscription.id === recovery.subscriptionId &&
    stripeId(subscription.customer) === recovery.customerId &&
    subscription.metadata.guild_id === recovery.guildId &&
    subscription.livemode === (recovery.mode === "live") &&
    (!subscription.metadata.chronote_renewal_recovery ||
      subscription.metadata.chronote_renewal_recovery ===
        renewalRecoveryKey(recovery))
  );
}
async function restoreOriginalCancellation(
  stripe: StripeClient,
  operation: BillingChangeOperation,
  subscription: StripeSubscription,
  clearOwnCancellation = false,
) {
  const original = operation.source.cancellation;
  if (!original?.at && !original?.atPeriodEnd && !clearOwnCancellation)
    return true;
  const cancellation = original?.atPeriodEnd
    ? { cancel_at_period_end: true }
    : { cancel_at: original?.at ?? ("" as const) };
  const restored = await stripe.subscriptions.update(
    subscription.id,
    {
      ...cancellation,
      proration_behavior: "none",
      metadata: { chronote_scheduled_change: "" },
    },
    changeIdempotency(operation, "restore-original-cancellation"),
  );
  const expected =
    original?.at ?? (original?.atPeriodEnd ? operation.source.periodEnd : null);
  return (
    unchangedService(restored, operation) &&
    (expected
      ? restored.cancel_at === expected
      : !restored.cancel_at && !restored.cancel_at_period_end)
  );
}
export async function readScheduledChangeSettlement(
  stripe: StripeClient,
  operation: Scheduled,
  write: StripeEffect = (run) => run(),
) {
  const subscription = await stripe.subscriptions.retrieve(
    operation.source.subscriptionId,
    { expand: ["discounts.source.coupon"] },
  );
  if (
    subscription.id !== operation.source.subscriptionId ||
    subscription.metadata.guild_id !== operation.guildId ||
    stripeId(subscription.customer) !== operation.source.customerId ||
    subscription.livemode !== (operation.mode === "live")
  )
    throw changeUnavailable();
  if (operation.target.selection.tier === "free")
    return subscription.status === "canceled" &&
      subscription.metadata.chronote_scheduled_change === operation.operationId
      ? { kind: "canceled" as const }
      : { kind: "waiting" as const };
  const invoice = await firstScheduledInvoice(stripe, operation, subscription);
  if (!invoice) return { kind: "waiting" as const };
  if (operation.scheduleId) {
    const released = await releaseOwnedSchedule(
      stripe,
      operation,
      operation.scheduleId,
      write,
    );
    if (!released) return { kind: "waiting" as const };
  }
  return { kind: "paid" as const, invoice, subscription };
}

function assertOwnedSchedule(
  schedule: Stripe.SubscriptionSchedule,
  operation: BillingChangeOperation,
) {
  const subscriptionId =
    stripeId(schedule.subscription) ?? stripeId(schedule.released_subscription);
  if (
    schedule.metadata?.chronote_change_operation !== operation.operationId ||
    subscriptionId !== operation.source.subscriptionId ||
    stripeId(schedule.customer) !== operation.source.customerId ||
    schedule.livemode !== (operation.mode === "live")
  )
    throw changeUnavailable();
}
export async function releaseOwnedSchedule(
  stripe: StripeClient,
  operation: BillingChangeOperation,
  scheduleId: string,
  write: StripeEffect = (run) => run(),
) {
  let schedule = await stripe.subscriptionSchedules.retrieve(scheduleId);
  assertOwnedSchedule(schedule, operation);
  if (schedule.status === "active" || schedule.status === "not_started")
    schedule = await write(() =>
      stripe.subscriptionSchedules.release(
        scheduleId,
        { preserve_cancel_date: true },
        changeIdempotency(operation, "release-schedule"),
      ),
    );
  return (
    schedule.status === "released" &&
    stripeId(schedule.released_subscription) === operation.source.subscriptionId
  );
}

async function firstScheduledInvoice(
  stripe: StripeClient,
  operation: Scheduled,
  subscription: StripeSubscription,
) {
  const recovery = await getRenewalRecoveryRepository().getCurrent(
    operation.guildId,
  );
  if (
    recovery?.state === "superseded" &&
    recovery.scheduledOperationId === operation.operationId
  ) {
    const invoice = await stripe.invoices.retrieve(
      recovery.replacementPaid.invoiceId,
      { expand: ["discounts.source.coupon"] },
    );
    return isScheduledInvoice(
      invoice,
      operation,
      recovery.replacementPaid.periodStart,
    )
      ? invoice
      : null;
  }
  const latest = stripeId(subscription.latest_invoice);
  if (latest) {
    const invoice = await stripe.invoices.retrieve(latest, {
      expand: ["discounts.source.coupon"],
    });
    if (isScheduledInvoice(invoice, operation)) return invoice;
  }
  let count = 0;
  for await (const invoice of stripe.invoices.list({
    subscription: operation.source.subscriptionId,
    created: { gte: operation.source.periodEnd },
    limit: 100,
  })) {
    if (++count > 10000) throw changeUnavailable();
    const expanded = await stripe.invoices.retrieve(invoice.id, {
      expand: ["discounts.source.coupon"],
    });
    if (isScheduledInvoice(expanded, operation)) return expanded;
  }
  return null;
}
export function isScheduledInvoice(
  invoice: import("../types/stripe").StripeInvoice,
  operation: ScheduledInvoiceOperation,
  periodStart = operation.source.periodEnd,
) {
  if (operation.target.offer) {
    const reason = invoice.billing_reason;
    if (reason !== "subscription_cycle" && reason !== "subscription_update")
      return false;
    try {
      assertRecurringOfferInvoice(
        invoice,
        operation.source.subscriptionId,
        operation.target.offer.terms,
        reason,
      );
    } catch {
      return false;
    }
  } else if (!isUndiscountedScheduledInvoice(invoice, operation)) {
    return false;
  }
  const details = invoice.parent?.subscription_details;
  return (
    invoice.status === "paid" &&
    invoice.amount_remaining === 0 &&
    invoice.pre_payment_credit_notes_amount === 0 &&
    invoice.post_payment_credit_notes_amount === 0 &&
    invoice.livemode === (operation.mode === "live") &&
    stripeId(invoice.customer) === operation.source.customerId &&
    stripeId(details?.subscription) === operation.source.subscriptionId &&
    details?.metadata?.chronote_change_operation === operation.operationId &&
    !invoice.lines.has_more &&
    invoice.lines.data.some(
      (line) =>
        line.parent?.subscription_item_details?.subscription ===
          operation.source.subscriptionId &&
        line.pricing?.price_details?.price === operation.target.priceId &&
        line.quantity === 1 &&
        line.amount === operation.target.unitAmount &&
        line.period.start === periodStart,
    )
  );
}

type ScheduledInvoiceOperation = Pick<
  BillingChangeOperation,
  "source" | "target" | "mode" | "operationId"
>;
function isUndiscountedScheduledInvoice(
  invoice: import("../types/stripe").StripeInvoice,
  operation: ScheduledInvoiceOperation,
): boolean {
  if (
    invoice.currency !== operation.target.currency ||
    invoice.discounts.length ||
    invoice.total_discount_amounts?.length
  )
    return false;
  let total = 0;
  let services = 0;
  for (const line of invoice.lines.data) {
    if (
      line.invoice !== invoice.id ||
      line.livemode !== invoice.livemode ||
      line.currency !== invoice.currency ||
      line.discounts?.length ||
      line.discount_amounts?.length
    )
      return false;
    const service = line.parent?.subscription_item_details;
    if (service) {
      if (
        service.subscription !== operation.source.subscriptionId ||
        service.proration ||
        line.pricing?.price_details?.price !== operation.target.priceId ||
        line.quantity !== 1 ||
        line.amount !== operation.target.unitAmount
      )
        return false;
      services++;
    } else if (line.parent?.type !== "invoice_item_details") return false;
    total +=
      line.amount +
      (line.taxes ?? []).reduce(
        (sum, tax) => sum + (tax.tax_behavior === "exclusive" ? tax.amount : 0),
        0,
      );
  }
  return (
    services === 1 &&
    invoice.total === total &&
    invoice.subtotal ===
      invoice.lines.data.reduce((sum, line) => sum + line.amount, 0)
  );
}

async function recoverCreatedSchedule(
  stripe: StripeClient,
  operation: Accepted,
  existing: Stripe.SubscriptionSchedule | null,
) {
  if (existing?.metadata?.chronote_change_operation === operation.operationId) {
    assertOwnedSchedule(existing, operation);
    return existing;
  }
  if (existing && operation.providerScheduleId === existing.id) {
    assertCreatedSchedule(existing, operation);
    return existing;
  }
  if (Math.floor(Date.now() / 1000) - operation.createdAt >= 23 * 3600) {
    if (
      !existing ||
      !(await hasScheduleCreationEvent(stripe, operation, existing.id))
    )
      throw changeUnavailable();
    assertCreatedSchedule(existing, operation);
    return existing;
  }
  // Stripe forbids metadata with from_subscription. A repeat of the same creation
  // key recovers our unmarked result; a foreign schedule cannot satisfy that call.
  const created = await stripe.subscriptionSchedules.create(
    { from_subscription: operation.source.subscriptionId },
    changeIdempotency(operation, "create-schedule"),
  );
  if (
    (existing && existing.id !== created.id) ||
    stripeId(created.subscription) !== operation.source.subscriptionId ||
    stripeId(created.customer) !== operation.source.customerId ||
    created.livemode !== (operation.mode === "live")
  )
    throw changeUnavailable();
  return created;
}
function assertCreatedSchedule(
  schedule: Stripe.SubscriptionSchedule,
  operation: Accepted,
) {
  if (
    stripeId(schedule.subscription) !== operation.source.subscriptionId ||
    stripeId(schedule.customer) !== operation.source.customerId ||
    schedule.livemode !== (operation.mode === "live")
  )
    throw changeUnavailable();
}
async function hasScheduleCreationEvent(
  stripe: StripeClient,
  operation: Accepted,
  scheduleId: string,
) {
  let count = 0;
  // shortcut: Stripe retains events for 30 days; an older lost acknowledgement needs operator reconciliation.
  for await (const event of stripe.events.list({
    type: "subscription_schedule.created",
    created: { gte: operation.createdAt },
    limit: 100,
  })) {
    if (++count > 10000) throw changeUnavailable();
    if (
      event.type === "subscription_schedule.created" &&
      event.data.object.id === scheduleId &&
      event.livemode === (operation.mode === "live") &&
      event.request?.idempotency_key ===
        changeIdempotency(operation, "create-schedule").idempotencyKey
    )
      return true;
  }
  return false;
}
