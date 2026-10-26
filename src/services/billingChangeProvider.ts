import type { GuildSubscription } from "../types/db";
import { verifyChangeFunding } from "./billingChangeFunding";
import { createHash } from "node:crypto";
import type Stripe from "stripe";
import type {
  StripeClient,
  StripeInvoice,
  StripeSubscription,
} from "../types/stripe";
import {
  billingChangeSourceSchema,
  type BillingChangeOperation,
  type BillingChangeSource,
  type BillingChangeTarget,
} from "../types/billingChange";
import { getSubscriptionRepository } from "../repositories/subscriptionRepository";
import { getBillingChangeRepository } from "../repositories/billingChangeRepository";
import { resolveTierFromPrice } from "./pricingService";
import { config } from "./configService";
import { BillingActionError } from "./billingActionError";

export const stripeId = (value: string | { id: string } | null | undefined) =>
  typeof value === "string" ? value : value?.id;
export function isUnappliedChangeSourceInvalidated(
  subscription: StripeSubscription,
  operation: BillingChangeOperation,
  now: number,
): boolean {
  if (
    subscription.id !== operation.source.subscriptionId ||
    stripeId(subscription.customer) !== operation.source.customerId ||
    subscription.metadata.guild_id !== operation.guildId ||
    subscription.livemode !== (operation.mode === "live") ||
    subscription.metadata.chronote_change_operation === operation.operationId
  )
    return false;
  if (["canceled", "incomplete_expired"].includes(subscription.status))
    return true;
  return (
    sourceStillUnapplied(subscription, operation) &&
    (now >= operation.source.periodEnd ||
      hasSourceCancellationChanged(subscription, operation))
  );
}
function hasSourceCancellationChanged(
  subscription: StripeSubscription,
  operation: BillingChangeOperation,
): boolean {
  const original = operation.source.cancellation;
  return (
    (subscription.cancel_at ?? null) !== (original?.at ?? null) ||
    subscription.cancel_at_period_end !== (original?.atPeriodEnd ?? false)
  );
}
function sourceStillUnapplied(
  subscription: StripeSubscription,
  operation: BillingChangeOperation,
): boolean {
  const item = subscription.items.data[0];
  return (
    !subscription.schedule &&
    !subscription.pending_update &&
    subscription.metadata.chronote_scheduled_change !== operation.operationId &&
    !subscription.items.has_more &&
    subscription.items.data.length === 1 &&
    item.id === operation.source.itemId &&
    item.price.id === operation.source.priceId &&
    item.quantity === 1 &&
    ((item.current_period_start === operation.source.periodStart &&
      item.current_period_end === operation.source.periodEnd) ||
      item.current_period_start >= operation.source.periodEnd)
  );
}
export const changePending = () =>
  new BillingActionError(
    "BAD_REQUEST",
    "Your previous payment is still being settled. Please come back later.",
    "purchase_pending",
  );
export const changeUnavailable = () =>
  new BillingActionError(
    "BAD_REQUEST",
    "We could not verify this plan change. Refresh billing and try again.",
  );
export function changeSourceFingerprint(subscription: StripeSubscription) {
  const item = subscription.items.data[0];
  const discounts = subscription.discounts.map((discount) =>
    typeof discount === "string"
      ? discount
      : {
          id: discount.id,
          start: discount.start,
          end: discount.end,
          coupon: stripeId(discount.source.coupon),
          promotionCode: stripeId(discount.promotion_code),
        },
  );
  return createHash("sha256")
    .update(
      JSON.stringify({
        id: subscription.id,
        guildId: subscription.metadata.guild_id,
        customer: stripeId(subscription.customer),
        status: subscription.status,
        mode: subscription.livemode,
        billingMode: subscription.billing_mode,
        schedule: stripeId(subscription.schedule),
        pending: subscription.pending_update,
        cancelAt: subscription.cancel_at,
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
        item: {
          id: item.id,
          price: item.price.id,
          amount: item.price.unit_amount,
          currency: item.price.currency,
          tax: item.price.tax_behavior,
          quantity: item.quantity,
          taxRates: (item.tax_rates ?? []).map((rate) => rate.id),
          discounts: item.discounts,
          start: item.current_period_start,
          end: item.current_period_end,
        },
        discounts,
        anchor: subscription.billing_cycle_anchor,
        invoice: stripeId(subscription.latest_invoice),
        automaticTax: subscription.automatic_tax,
        taxRates: (subscription.default_tax_rates ?? []).map((rate) => rate.id),
      }),
    )
    .digest("hex");
}
export function changeServiceFingerprint(subscription: StripeSubscription) {
  return changeSourceFingerprint({
    ...subscription,
    schedule: null,
    cancel_at: null,
    cancel_at_period_end: false,
  });
}
export async function readBillingChangeSource(input: {
  stripe: StripeClient;
  guildId: string;
  payerId: string;
  at?: number;
}) {
  const saved = await getSubscriptionRepository().get(input.guildId);
  if (!saved?.stripeSubscriptionId) throw changeUnavailable();
  const subscription = await input.stripe.subscriptions.retrieve(
    saved.stripeSubscriptionId,
    { expand: ["discounts.source.coupon"] },
  );
  const customerId = stripeId(subscription.customer);
  assertSourceIdentity(subscription, saved, input.guildId);
  if (!customerId) throw changeUnavailable();
  const customer = await input.stripe.customers.retrieve(customerId);
  if (customer.deleted || customer.livemode !== subscription.livemode)
    throw changeUnavailable();
  if (customer.metadata.discord_id !== input.payerId)
    throw new BillingActionError(
      "FORBIDDEN",
      "Only the original payer can change this subscription.",
    );
  assertChangeableSubscription(subscription);
  const item = subscription.items.data[0];
  const { tier, interval } = sourcePrice(item.price);
  const invoice = await readPaidSourceInvoice(
    input.stripe,
    subscription,
    input.guildId,
  );
  const source = billingChangeSourceSchema.parse({
    subscriptionId: subscription.id,
    customerId,
    itemId: item.id,
    priceId: item.price.id,
    tier,
    interval,
    periodStart: item.current_period_start,
    periodEnd: item.current_period_end,
    billingMode: subscription.billing_mode.type,
    revision: saved.stripeSyncRevision ?? null,
    at: input.at ?? Math.floor(Date.now() / 1000),
    fingerprint: changeSourceFingerprint(subscription),
    invariantFingerprint: changeServiceFingerprint(subscription),
    cancellation: {
      at: subscription.cancel_at,
      atPeriodEnd: subscription.cancel_at_period_end,
    },
    productId: stripeId(item.price.product),
    taxBehavior: item.price.tax_behavior,
    taxRateIds: (item.tax_rates?.length
      ? item.tax_rates
      : (subscription.default_tax_rates ?? [])
    ).map((rate) => rate.id),
  });
  if (source.at < source.periodStart || source.at >= source.periodEnd)
    throw changePending();
  return { source, subscription, customer, saved, invoice };
}
export function readChangePreview(
  invoice: StripeInvoice,
  source: BillingChangeSource,
  target: BillingChangeTarget,
) {
  if (
    invoice.lines.has_more ||
    !invoice.lines.data.length ||
    invoice.currency !== target.currency
  )
    throw changeUnavailable();
  let planCharge = 0;
  let offerSavings = 0;
  let unusedCredit = 0;
  for (const line of invoice.lines.data) {
    assertPreviewLine(line, source, target);
    const savings = (line.discount_amounts ?? []).reduce(
      (sum, discount) => sum + discount.amount,
      0,
    );
    if (line.amount < 0) unusedCredit -= line.amount - savings;
    else {
      planCharge += line.amount;
      offerSavings += savings;
    }
  }
  const taxAmount = (invoice.total_taxes ?? []).reduce(
    (sum, tax) => sum + tax.amount,
    0,
  );
  const addedTax = (invoice.total_taxes ?? [])
    .filter((tax) => tax.tax_behavior === "exclusive")
    .reduce((sum, tax) => sum + tax.amount, 0);
  if (planCharge - offerSavings - unusedCredit + addedTax !== invoice.total)
    throw changeUnavailable();
  return {
    planCharge,
    offerSavings,
    unusedCredit,
    taxAmount,
    serviceTotal: invoice.total,
  };
}
export function changeUpdateParams(
  source: BillingChangeSource,
  target: BillingChangeTarget,
  timing: "preview" | "apply",
): Stripe.SubscriptionUpdateParams {
  if (!target.priceId) throw changeUnavailable();
  const reset = source.interval !== target.selection.interval;
  return {
    items: [{ id: source.itemId, price: target.priceId, quantity: 1 }],
    discounts: target.offer ? [{ coupon: target.offer.terms.couponId }] : "",
    proration_behavior: reset ? "none" : "always_invoice",
    ...(reset
      ? ({
          billing_cycle_anchor: { type: "now" },
        } satisfies Stripe.SubscriptionUpdateParams)
      : { proration_date: source.at }),
    ...(timing === "apply" ? { payment_behavior: "default_incomplete" } : {}),
  };
}
export async function previewBillingChange(input: {
  stripe: StripeClient;
  subscription: StripeSubscription;
  source: BillingChangeSource;
  target: BillingChangeTarget;
}) {
  const request = changeUpdateParams(input.source, input.target, "preview");
  // Preview both source credit and a full new target period when the cadence changes.
  const reset = input.source.interval !== input.target.selection.interval;
  const invoice = await input.stripe.invoices.createPreview({
    subscription: input.source.subscriptionId,
    discounts: request.discounts,
    subscription_details: {
      items: request.items,
      proration_behavior: "always_invoice",
      ...(reset
        ? ({
            billing_cycle_anchor: { type: "now" },
          } satisfies Stripe.SubscriptionUpdateParams)
        : { proration_date: input.source.at }),
    },
  });
  return {
    invoice,
    amounts: readChangePreview(invoice, input.source, input.target),
  };
}

function assertSourceIdentity(
  subscription: StripeSubscription,
  saved: GuildSubscription,
  guildId: string,
) {
  const customerId = stripeId(subscription.customer);
  if (
    !customerId ||
    subscription.id !== saved.stripeSubscriptionId ||
    subscription.metadata.guild_id !== guildId ||
    (saved.stripeCustomerId && saved.stripeCustomerId !== customerId) ||
    subscription.livemode !== (config.subscription.stripeMode === "live")
  )
    throw changeUnavailable();
}
function assertChangeableSubscription(subscription: StripeSubscription) {
  // A zero application invoice can create a SetupIntent for future payments.
  // Paid service is verified separately; its presence is not unsettled payment.
  if (
    subscription.status !== "active" ||
    subscription.pending_update ||
    subscription.pause_collection
  )
    throw changePending();
  const item = subscription.items.data[0];
  if (
    subscription.items.has_more ||
    subscription.items.data.length !== 1 ||
    !item ||
    item.quantity !== 1 ||
    item.discounts.length ||
    subscription.collection_method !== "charge_automatically" ||
    subscription.trial_end
  )
    throw changeUnavailable();
}
function sourcePrice(price: Stripe.Price) {
  const tier = resolveTierFromPrice({
    priceId: price.id,
    lookupKey: price.lookup_key,
  });
  const interval = price.recurring?.interval;
  if (
    !tier ||
    (interval !== "month" && interval !== "year") ||
    price.recurring?.interval_count !== 1 ||
    price.recurring.usage_type !== "licensed" ||
    price.currency !== "usd" ||
    price.billing_scheme !== "per_unit" ||
    (price.tax_behavior !== "inclusive" && price.tax_behavior !== "exclusive")
  )
    throw changeUnavailable();
  return { tier, interval };
}
export async function readPaidSourceInvoice(
  stripe: StripeClient,
  subscription: StripeSubscription,
  guildId: string,
  invoiceId = stripeId(subscription.latest_invoice),
) {
  if (!invoiceId) throw changePending();
  const invoice = await stripe.invoices.retrieve(invoiceId, {
    expand: ["discounts.source.coupon"],
  });
  assertUnreversedSourceInvoice(invoice, subscription);
  if (invoice.lines.has_more || !hasCurrentServiceLine(invoice, subscription))
    throw changeUnavailable();
  if (invoice.total > 0 && invoice.status === "paid") return invoice;
  if (
    invoice.total !== 0 ||
    (invoice.status !== "paid" && invoice.status !== "void")
  )
    throw changePending();
  if (fullyDiscountedNativePeriod(invoice, subscription)) return invoice;
  await assertPreviouslyFundedService(stripe, subscription, invoice, guildId);
  return invoice;
}
function assertUnreversedSourceInvoice(
  invoice: StripeInvoice,
  subscription: StripeSubscription,
) {
  if (
    invoice.amount_remaining !== 0 ||
    invoice.pre_payment_credit_notes_amount !== 0 ||
    invoice.post_payment_credit_notes_amount !== 0 ||
    stripeId(invoice.customer) !== stripeId(subscription.customer) ||
    invoice.livemode !== subscription.livemode ||
    stripeId(invoice.parent?.subscription_details?.subscription) !==
      subscription.id
  )
    throw changePending();
}
async function assertPreviouslyFundedService(
  stripe: StripeClient,
  subscription: StripeSubscription,
  invoice: StripeInvoice,
  guildId: string,
) {
  const previousId = subscription.metadata.chronote_change_operation;
  if (!previousId) throw changePending();
  const operation = await getBillingChangeRepository().getOperation(
    guildId,
    previousId,
  );
  const item = subscription.items.data[0];
  if (
    !operation ||
    operation.state !== "succeeded" ||
    operation.source.subscriptionId !== subscription.id ||
    operation.target.priceId !== item.price.id ||
    !operation.funding ||
    operation.service?.invoiceId !== invoice.id ||
    operation.service.periodStart !== item.current_period_start ||
    operation.service.periodEnd !== item.current_period_end
  )
    throw changePending();
  const funded = await stripe.invoices.retrieve(operation.funding.invoiceId);
  if (!verifyChangeFunding(funded, operation, operation.funding))
    throw changePending();
}

function assertPreviewLine(
  line: StripeInvoice["lines"]["data"][number],
  source: BillingChangeSource,
  target: BillingChangeTarget,
) {
  const parent = line.parent?.subscription_item_details;
  const priceId = line.pricing?.price_details?.price;
  if (
    !parent ||
    parent.subscription_item !== source.itemId ||
    (line.amount < 0 ? priceId !== source.priceId : priceId !== target.priceId)
  )
    throw changeUnavailable();
}

function fullyDiscountedNativePeriod(
  invoice: StripeInvoice,
  subscription: StripeSubscription,
) {
  if (invoice.status !== "paid" || invoice.lines.data.length !== 1)
    return false;
  const line = invoice.lines.data[0];
  const item = subscription.items.data[0];
  const savings = (line.discount_amounts ?? []).reduce(
    (sum, discount) => sum + discount.amount,
    0,
  );
  return (
    !line.parent?.subscription_item_details?.proration &&
    line.period.start === item.current_period_start &&
    line.period.end === item.current_period_end &&
    line.amount > 0 &&
    line.amount === savings
  );
}

function hasCurrentServiceLine(
  invoice: StripeInvoice,
  subscription: StripeSubscription,
) {
  const item = subscription.items.data[0];
  return invoice.lines.data.some(
    (line) =>
      line.parent?.subscription_item_details?.subscription_item === item.id &&
      line.pricing?.price_details?.price === item.price.id &&
      line.amount > 0 &&
      line.period.end === item.current_period_end &&
      line.period.start >= item.current_period_start,
  );
}
