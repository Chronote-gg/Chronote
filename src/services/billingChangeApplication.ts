import Stripe from "stripe";
import { assertOfferServiceLine } from "./firstOfferInvoiceEvidence";
import type {
  StripeClient,
  StripeInvoice,
  StripeSubscription,
} from "../types/stripe";
import type { BillingChangeOperation } from "../types/billingChange";
import {
  isUnappliedChangeSourceInvalidated,
  changeSourceFingerprint,
  changeUpdateParams,
  stripeId,
  changeUnavailable,
} from "./billingChangeProvider";
import {
  changeIdempotency,
  changeMetadata,
  verifyChangeFunding,
} from "./billingChangeFunding";

type Applying = Extract<BillingChangeOperation, { state: "applying" }>;
export function buildChangeApplicationRequest(
  operation: Applying,
): Stripe.SubscriptionUpdateParams {
  const reset =
    operation.source.interval !== operation.target.selection.interval;
  const offset = reset
    ? (operation.funding.targetServiceValue ??
      operation.quote.planCharge - operation.quote.offerSavings)
    : operation.funding.serviceValue;
  if (
    !operation.target.productId ||
    (reset &&
      operation.target.taxBehavior === "exclusive" &&
      operation.funding.targetServiceValue == null)
  )
    throw changeUnavailable();
  return {
    ...changeUpdateParams(operation.source, operation.target, "apply"),
    ...(operation.source.billingMode === "classic"
      ? { cancel_at_period_end: false }
      : { cancel_at: "" }),
    metadata: {
      ...changeMetadata(operation),
      chronote_change_funding: operation.funding.invoiceId,
    },
    add_invoice_items: [
      {
        discountable: false,
        price_data: {
          currency: operation.target.currency,
          product: operation.target.productId,
          unit_amount: -offset,
          tax_behavior: "inclusive",
        },
        metadata: {
          ...changeMetadata(operation),
          chronote_invoice_role: "application-offset",
        },
      },
    ],
    expand: ["latest_invoice", "discounts.source.coupon"],
  };
}
function consumedAnnualOfferMatches(
  subscription: StripeSubscription,
  invoice: StripeInvoice,
  operation: Applying,
) {
  const offer = operation.target.offer;
  if (
    offer?.terms.interval !== "year" ||
    invoice.billing_reason !== "subscription_update"
  )
    return false;
  try {
    const line = assertOfferServiceLine(invoice, subscription.id, offer.terms);
    const item = subscription.items.data[0];
    return (
      line.parent?.subscription_item_details?.subscription_item === item.id &&
      line.period.start === item.current_period_start &&
      line.period.end === item.current_period_end
    );
  } catch {
    return false;
  }
}
function targetDiscountMatches(
  subscription: StripeSubscription,
  operation: Applying,
  invoice: StripeInvoice,
) {
  if (!operation.target.offer) return subscription.discounts.length === 0;
  // Stripe consumes annual once-coupons on the zero application invoice.
  if (subscription.discounts.length === 0)
    return consumedAnnualOfferMatches(subscription, invoice, operation);
  return (
    subscription.discounts.length === 1 &&
    subscription.discounts.every(
      (discount) =>
        typeof discount !== "string" &&
        stripeId(discount.source.coupon) ===
          operation.target.offer?.terms.couponId,
    )
  );
}
export function inspectChangeApplication(
  subscription: StripeSubscription,
  invoice: StripeInvoice,
  operation: Applying,
): "applied" | "residual_balance" | "unknown" {
  if (
    !targetSubscriptionMatches(subscription, operation, invoice) ||
    !zeroApplicationInvoice(invoice, subscription, operation)
  )
    return "unknown";
  if (!applicationPeriodMatches(subscription, operation)) return "unknown";
  if (settledApplication(subscription, invoice)) return "applied";
  return residualApplicationBalance(invoice) ? "residual_balance" : "unknown";
}
export async function applyFundedBillingChange(input: {
  stripe: StripeClient;
  operation: Applying;
  now?: number;
}): Promise<
  | "unknown"
  | "rejected"
  | {
      kind: "applied";
      invoice: StripeInvoice;
      subscription: StripeSubscription;
    }
> {
  const { stripe, operation } = input;
  const funding = await stripe.invoices.retrieve(operation.funding.invoiceId);
  if (!verifyChangeFunding(funding, operation, operation.funding))
    return "unknown";
  let subscription: StripeSubscription = await stripe.subscriptions.retrieve(
    operation.source.subscriptionId,
    { expand: ["latest_invoice", "discounts.source.coupon"] },
  );
  if (
    isUnappliedChangeSourceInvalidated(
      subscription,
      operation,
      input.now ?? Math.floor(Date.now() / 1000),
    )
  )
    return "rejected";
  if (
    subscription.metadata.chronote_change_operation !== operation.operationId
  ) {
    if (
      changeSourceFingerprint(subscription) !== operation.source.fingerprint ||
      (input.now ?? Math.floor(Date.now() / 1000)) >= operation.source.periodEnd
    )
      return "unknown";
    const submitted = await submitChangeApplication(stripe, operation);
    if (submitted.kind !== "updated") return submitted.kind;
    subscription = submitted.subscription;
  }
  const invoiceId = stripeId(subscription.latest_invoice);
  if (!invoiceId || invoiceId === operation.funding.invoiceId) return "unknown";
  let invoice = await stripe.invoices.retrieve(invoiceId, {
    expand: ["discounts.source.coupon"],
  });
  let result = inspectChangeApplication(subscription, invoice, operation);
  if (result === "residual_balance") {
    await stripe.invoices.voidInvoice(
      invoice.id,
      {},
      changeIdempotency(operation, "void-application-balance"),
    );
    subscription = await stripe.subscriptions.retrieve(subscription.id, {
      expand: ["discounts.source.coupon"],
    });
    invoice = await stripe.invoices.retrieve(invoiceId, {
      expand: ["discounts.source.coupon"],
    });
    result = inspectChangeApplication(subscription, invoice, operation);
  }
  return result === "applied"
    ? { kind: "applied", invoice, subscription }
    : "unknown";
}

function targetSubscriptionMatches(
  subscription: StripeSubscription,
  operation: Applying,
  invoice: StripeInvoice,
) {
  const item = subscription.items.data[0];
  return (
    subscription.id === operation.source.subscriptionId &&
    stripeId(subscription.customer) === operation.source.customerId &&
    subscription.livemode === (operation.mode === "live") &&
    subscription.metadata.guild_id === operation.guildId &&
    subscription.metadata.chronote_change_operation === operation.operationId &&
    !subscription.items.has_more &&
    subscription.items.data.length === 1 &&
    item.id === operation.source.itemId &&
    item.price.id === operation.target.priceId &&
    item.quantity === 1 &&
    subscription.billing_mode.type === operation.source.billingMode &&
    targetDiscountMatches(subscription, operation, invoice)
  );
}
function zeroApplicationInvoice(
  invoice: StripeInvoice,
  subscription: StripeSubscription,
  operation: Applying,
) {
  return (
    stripeId(invoice.customer) === operation.source.customerId &&
    invoice.livemode === subscription.livemode &&
    invoice.currency === operation.target.currency &&
    stripeId(invoice.parent?.subscription_details?.subscription) ===
      subscription.id &&
    invoice.total === 0 &&
    invoice.amount_paid === 0 &&
    !invoice.lines.has_more
  );
}

function applicationPeriodMatches(
  subscription: StripeSubscription,
  operation: Applying,
) {
  const item = subscription.items.data[0];
  if (operation.source.interval === operation.target.selection.interval)
    return (
      item.current_period_start === operation.source.periodStart &&
      item.current_period_end === operation.source.periodEnd
    );
  const start = item.current_period_start;
  return (
    start >= operation.consent.at &&
    start < operation.source.periodEnd &&
    item.current_period_end ===
      nextCalendarPeriod(start, operation.target.selection.interval)
  );
}
function nextCalendarPeriod(start: number, interval: "month" | "year") {
  const date = new Date(start * 1000);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  if (interval === "year") date.setUTCFullYear(date.getUTCFullYear() + 1);
  else date.setUTCMonth(date.getUTCMonth() + 1);
  const lastDay = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0),
  ).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return Math.floor(date.getTime() / 1000);
}
function settledApplication(
  subscription: StripeSubscription,
  invoice: StripeInvoice,
) {
  return (
    ((invoice.status === "paid" && invoice.amount_remaining === 0) ||
      invoice.status === "void") &&
    subscription.status === "active" &&
    !subscription.pending_update
  );
}
function residualApplicationBalance(invoice: StripeInvoice) {
  return (
    invoice.status === "open" &&
    invoice.starting_balance > 0 &&
    invoice.amount_due === invoice.starting_balance &&
    invoice.amount_remaining === invoice.amount_due &&
    !invoice.auto_advance &&
    invoice.attempt_count === 0 &&
    invoice.next_payment_attempt === null
  );
}

async function submitChangeApplication(
  stripe: StripeClient,
  operation: Applying,
): Promise<
  | { kind: "updated"; subscription: StripeSubscription }
  | { kind: "unknown" | "rejected" }
> {
  try {
    return {
      kind: "updated",
      subscription: await stripe.subscriptions.update(
        operation.source.subscriptionId,
        buildChangeApplicationRequest(operation),
        changeIdempotency(operation, "apply"),
      ),
    };
  } catch (error) {
    if (
      !(error instanceof Stripe.errors.StripeInvalidRequestError) ||
      error.statusCode !== 400
    )
      throw error;
    const current = await stripe.subscriptions.retrieve(
      operation.source.subscriptionId,
      { expand: ["discounts.source.coupon"] },
    );
    return {
      kind:
        changeSourceFingerprint(current) === operation.source.fingerprint
          ? "rejected"
          : "unknown",
    };
  }
}
