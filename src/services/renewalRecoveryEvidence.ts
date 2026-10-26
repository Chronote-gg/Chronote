import type {
  StripeClient,
  StripeInvoice,
  StripeSubscription,
} from "../types/stripe";
import type { RenewalRecovery } from "../types/renewalRecovery";
import {
  stripeId,
  changeUnavailable,
  readPaidSourceInvoice,
} from "./billingChangeProvider";
import { resolveTierFromPrice } from "./pricingService";
import { getBillingChangeRepository } from "../repositories/billingChangeRepository";
import { isScheduledInvoice } from "./billingChangeSchedule";

export function assertRenewalOwner(
  subscription: StripeSubscription,
  recovery: Pick<
    RenewalRecovery,
    "guildId" | "subscriptionId" | "customerId" | "mode"
  >,
): void {
  if (
    subscription.id !== recovery.subscriptionId ||
    subscription.metadata.guild_id !== recovery.guildId ||
    stripeId(subscription.customer) !== recovery.customerId ||
    subscription.livemode !== (recovery.mode === "live")
  )
    throw changeUnavailable();
}
export async function readRenewalPaidBasis(
  stripe: StripeClient,
  subscription: StripeSubscription,
  guildId: string,
  invoiceId: string,
): Promise<RenewalRecovery["paid"]> {
  const item = subscription.items.data[0];
  if (
    subscription.items.has_more ||
    subscription.items.data.length !== 1 ||
    item.quantity !== 1
  )
    throw changeUnavailable();
  const tier = resolveTierFromPrice({
    priceId: item.price.id,
    lookupKey: item.price.lookup_key,
  });
  const interval = item.price.recurring?.interval;
  if (
    !tier ||
    (interval !== "month" && interval !== "year") ||
    item.price.recurring?.interval_count !== 1
  )
    throw changeUnavailable();
  const invoice = await readPaidSourceInvoice(
    stripe,
    subscription,
    guildId,
    invoiceId,
  );
  const customerId = stripeId(subscription.customer);
  if (!customerId) throw changeUnavailable();
  await scheduledRenewalOperation(
    invoice,
    {
      guildId,
      subscriptionId: subscription.id,
      customerId,
      mode: subscription.livemode ? "live" : "test",
      paid: { periodEnd: item.current_period_start },
    },
    item.price.id,
  );
  return {
    invoiceId: invoice.id,
    priceId: item.price.id,
    tier,
    interval: interval === "year" ? "year" : "month",
    periodStart: item.current_period_start,
    periodEnd: item.current_period_end,
  };
}
function serviceLine(
  invoice: StripeInvoice,
  recovery: RenewalRecovery,
  subscription: StripeSubscription,
) {
  const item = subscription.items.data[0];
  const lines = invoice.lines.data.filter(
    (line) =>
      line.parent?.subscription_item_details?.subscription ===
        recovery.subscriptionId &&
      !line.parent.subscription_item_details.proration &&
      line.quantity === 1 &&
      line.period.start === recovery.paid.periodEnd,
  );
  if (
    invoice.lines.has_more ||
    lines.length !== 1 ||
    subscription.items.has_more ||
    subscription.items.data.length !== 1 ||
    lines[0].period.end > item.current_period_end ||
    lines[0].period.start > item.current_period_start ||
    lines[0].period.end <= lines[0].period.start
  )
    throw changeUnavailable();
  return lines[0];
}
function assertRenewalInvoiceOwner(
  invoice: StripeInvoice,
  recovery: RenewalRecovery,
): void {
  if (
    stripeId(invoice.customer) !== recovery.customerId ||
    invoice.livemode !== (recovery.mode === "live") ||
    stripeId(invoice.parent?.subscription_details?.subscription) !==
      recovery.subscriptionId ||
    invoice.metadata?.chronote_invoice_role === "funding" ||
    (invoice.billing_reason !== "subscription_cycle" &&
      invoice.billing_reason !== "subscription_update") ||
    invoice.pre_payment_credit_notes_amount !== 0 ||
    invoice.post_payment_credit_notes_amount !== 0
  )
    throw changeUnavailable();
}
type ScheduledRenewalBoundary = Pick<
  RenewalRecovery,
  "guildId" | "subscriptionId" | "customerId" | "mode"
> & { paid: Pick<RenewalRecovery["paid"], "periodEnd"> };
async function scheduledRenewalOperation(
  invoice: StripeInvoice,
  recovery: ScheduledRenewalBoundary,
  priceId: string | undefined,
): Promise<string | null> {
  const operationId =
    invoice.parent?.subscription_details?.metadata?.chronote_change_operation;
  if (!operationId) return null;
  const operation = await getBillingChangeRepository().getOperation(
    recovery.guildId,
    operationId,
  );
  if (
    !operation ||
    operation.timing !== "renewal" ||
    operation.source.periodEnd !== recovery.paid.periodEnd
  )
    return null;
  if (
    operation.source.subscriptionId !== recovery.subscriptionId ||
    operation.source.customerId !== recovery.customerId ||
    operation.mode !== recovery.mode ||
    operation.target.priceId !== priceId ||
    !["scheduled", "canceling", "succeeded"].includes(operation.state) ||
    !("consent" in operation) ||
    !operation.consent
  )
    throw changeUnavailable();
  if (invoice.status === "paid" && !isScheduledInvoice(invoice, operation))
    throw changeUnavailable();
  return operationId;
}
export async function verifyRenewalInvoice(
  invoice: StripeInvoice,
  recovery: RenewalRecovery,
  subscription: StripeSubscription,
) {
  assertRenewalInvoiceOwner(invoice, recovery);
  const line = serviceLine(invoice, recovery, subscription);
  if (
    invoice.currency !== subscription.items.data[0].price.currency ||
    line.currency !== invoice.currency ||
    line.livemode !== invoice.livemode
  )
    throw changeUnavailable();
  const scheduledOperationId = await scheduledRenewalOperation(
    invoice,
    recovery,
    stripeId(line.pricing?.price_details?.price),
  );
  if (
    !scheduledOperationId &&
    stripeId(line.pricing?.price_details?.price) !== recovery.paid.priceId
  )
    throw changeUnavailable();
  return { line, scheduledOperationId };
}
export async function findRenewalInvoice(
  stripe: StripeClient,
  recovery: RenewalRecovery,
  subscription: StripeSubscription,
): Promise<StripeInvoice | undefined> {
  if (recovery.state === "ended") return undefined;
  if (recovery.state !== "watching")
    return stripe.invoices.retrieve(recovery.invoice.id, {
      expand: ["discounts.source.coupon"],
    });
  const latest = stripeId(subscription.latest_invoice);
  if (latest && latest !== recovery.paid.invoiceId) {
    const candidate = await stripe.invoices.retrieve(latest, {
      expand: ["discounts.source.coupon"],
    });
    if (
      candidate.lines.data.some(
        (line) =>
          line.parent?.subscription_item_details?.subscription ===
            recovery.subscriptionId &&
          line.period.start === recovery.paid.periodEnd,
      )
    )
      return candidate;
  }
  let count = 0;
  for await (const candidate of stripe.invoices.list({
    subscription: recovery.subscriptionId,
    created: { gte: recovery.paid.periodEnd },
    limit: 100,
  })) {
    if (++count > 10000) throw changeUnavailable();
    if (
      candidate.lines.data.some(
        (line) =>
          line.parent?.subscription_item_details?.subscription ===
            recovery.subscriptionId &&
          line.period.start === recovery.paid.periodEnd,
      )
    )
      return stripe.invoices.retrieve(candidate.id, {
        expand: ["discounts.source.coupon"],
      });
  }
  return undefined;
}
