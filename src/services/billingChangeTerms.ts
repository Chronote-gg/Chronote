import { formatIntroOfferTerms } from "../utils/introOfferCopy";
import { randomUUID } from "node:crypto";
import type {
  StripeClient,
  StripeInvoice,
  StripeSubscription,
  StripePrice,
} from "../types/stripe";
import {
  billingChangeTargetSchema,
  type BillingChangeSelection,
  type BillingChangeOperation,
  type BillingChangeTarget,
  type BillingChangeQuote,
} from "../types/billingChange";
import {
  offerUsageSchema,
  offerTermsSchema,
  type OfferUsageMutation,
} from "../types/offerUsage";
import { getOfferUsageRepository } from "../repositories/offerUsageRepository";
import { HISTORY_WRITER_VERSION } from "../types/historyWriterBoundary";
import { getPaidPlans } from "./pricingService";
import {
  getGuildBasicIntroOffer,
  selectedOfferDecision,
} from "./basicIntroOfferService";
import { config } from "./configService";
import {
  stripeId,
  changeUnavailable,
  type readBillingChangeSource,
} from "./billingChangeProvider";
import { BillingActionError } from "./billingActionError";

type Source = Awaited<ReturnType<typeof readBillingChangeSource>>;
export async function resolveBillingChangeTarget(
  stripe: StripeClient,
  guildId: string,
  payerId: string,
  selection: BillingChangeSelection,
  source: Source,
): Promise<BillingChangeTarget> {
  if (selection.tier === "free")
    return billingChangeTargetSchema.parse({
      selection,
      priceId: null,
      productId: null,
      unitAmount: 0,
      currency: source.subscription.currency,
      taxBehavior: source.subscription.items.data[0].price.tax_behavior,
      offer: null,
    });
  const plans = await getPaidPlans(stripe);
  const plan = plans.find(
    (candidate) =>
      candidate.tier === selection.tier &&
      candidate.interval === selection.interval,
  );
  if (!plan) throw changeUnavailable();
  const price = await stripe.prices.retrieve(plan.priceId);
  assertTargetPrice(price, plan, selection, source.subscription);
  let offer: BillingChangeTarget["offer"] = null;
  if (selection.expectedOffer !== "none") {
    const quoted = await getGuildBasicIntroOffer({
      stripe,
      guildId,
      payerId,
      plans,
      interval: selection.interval,
    });
    if (
      selection.tier !== "basic" ||
      quoted.status !== "available" ||
      quoted.id !== selection.expectedOffer
    )
      throw new BillingActionError(
        "BAD_REQUEST",
        "This offer has changed. Review the available price before continuing.",
        "offer_changed_terms",
      );
    const decision = await selectedOfferDecision(
      stripe,
      guildId,
      selection.interval,
    );
    if (decision.state !== "unused") throw changeUnavailable();
    const couponId =
      selection.interval === "year"
        ? config.stripe.basicIntroOffer.annualCouponId
        : config.stripe.basicIntroOffer.couponId;
    offer = {
      id: quoted.id,
      authority: decision.authority,
      terms: offerTermsSchema.parse({
        interval: selection.interval,
        currency: quoted.currency,
        priceId: quoted.priceId,
        couponId,
        regularUnitAmount: quoted.regularUnitAmount,
        discountedUnitAmount: quoted.discountedUnitAmount,
        durationMonths: quoted.durationMonths,
      }),
    };
  }
  return billingChangeTargetSchema.parse({
    selection,
    priceId: price.id,
    productId: stripeId(price.product),
    unitAmount: plan.unitAmount,
    currency: price.currency,
    taxBehavior: price.tax_behavior,
    offer,
  });
}
function nextChangeRate(
  target: BillingChangeTarget,
  timing: "immediate" | "renewal",
) {
  if (target.selection.tier === "free") return null;
  if (
    target.offer &&
    (timing === "renewal" || target.selection.interval === "month")
  )
    return target.offer.terms.discountedUnitAmount;
  return target.unitAmount;
}
export function billingChangeQuote(
  source: Source,
  target: BillingChangeTarget,
  timing: "immediate" | "renewal",
): BillingChangeQuote {
  const annual = target.selection.interval === "year";
  const effectiveAt =
    timing === "renewal" ? source.source.periodEnd : source.source.at;
  const name =
    target.selection.tier === "pro"
      ? "Pro"
      : target.selection.tier === "basic"
        ? "Basic"
        : "Free";
  const offerTerms = target.offer
    ? formatIntroOfferTerms(target.offer.terms)
    : null;
  return {
    targetTier: target.selection.tier,
    interval: target.selection.interval,
    timing,
    effectiveAt: new Date(effectiveAt * 1000).toISOString(),
    currency: target.currency,
    chargeLabel:
      timing === "immediate" &&
      source.source.interval === target.selection.interval
        ? name + " for the rest of this billing period"
        : name + (annual ? " for one year" : " for one month"),
    chargePeriod: null,
    creditLabel:
      "Unused paid " +
      (source.source.tier === "basic" ? "Basic" : "Pro") +
      " time",
    planCharge: target.unitAmount,
    offerSavings: target.offer
      ? target.unitAmount - target.offer.terms.discountedUnitAmount
      : 0,
    unusedCredit: 0,
    taxAmount: 0,
    taxTreatment: target.taxBehavior === "inclusive" ? "included" : "added",
    billingBalance: 0,
    balanceCarriedForward: 0,
    amountDue: 0,
    remainingCredit: 0,
    nextPlanRate: nextChangeRate(target, timing),
    nextAt:
      target.selection.tier === "free"
        ? null
        : new Date(source.source.periodEnd * 1000).toISOString(),
    offerTerms,
    endingOffer: knownEndingOffer(source.subscription),
  };
}
function knownEndingOffer(
  subscription: StripeSubscription,
): "monthly" | "annual" | null {
  const known = [
    subscription.metadata.chronote_change_coupon_id,
    subscription.metadata.intro_offer_coupon_id,
    config.stripe.basicIntroOffer.couponId,
    config.stripe.basicIntroOffer.annualCouponId,
  ].filter(Boolean);
  const introductory = subscription.discounts.some(
    (discount) =>
      typeof discount !== "string" &&
      known.includes(stripeId(discount.source.coupon) ?? ""),
  );
  return introductory
    ? subscription.items.data[0].price.recurring?.interval === "year"
      ? "annual"
      : "monthly"
    : null;
}
export async function reserveChangeOffer(
  operation: BillingChangeOperation,
): Promise<OfferUsageMutation | undefined> {
  const offer = operation.target.offer;
  if (!offer) return undefined;
  const expected = await getOfferUsageRepository().get(
    operation.guildId,
    offer.id,
    operation.mode,
  );
  if (expected && expected.state !== "unused") throw changeUnavailable();
  return {
    expected,
    authority: offer.authority,
    next: offerUsageSchema.parse({
      guildId: operation.guildId,
      mode: operation.mode,
      offerId: offer.id,
      revision: randomUUID(),
      state: "reserved",
      operationId: operation.operationId,
      writerVersion: HISTORY_WRITER_VERSION,
      reservedAt: operation.createdAt * 1000,
      terms: offer.terms,
    }),
  };
}
export async function settleChangeOffer(
  operation: BillingChangeOperation,
  invoice: StripeInvoice,
  now: number,
): Promise<OfferUsageMutation | undefined> {
  const offer = operation.target.offer;
  if (!offer) return undefined;
  const expected = await getOfferUsageRepository().get(
    operation.guildId,
    offer.id,
    operation.mode,
  );
  if (
    expected?.state !== "reserved" ||
    expected.operationId !== operation.operationId ||
    invoice.status !== "paid" ||
    invoice.amount_remaining !== 0
  )
    throw changeUnavailable();
  return {
    expected,
    next: offerUsageSchema.parse({
      ...expected,
      revision: randomUUID(),
      state: "used",
      usedAt: now * 1000,
      settlement: {
        customerId: operation.source.customerId,
        subscriptionId: operation.source.subscriptionId,
        subscriptionItemId:
          operation.timing === "renewal"
            ? (invoice.lines.data.find(
                (line) =>
                  line.pricing?.price_details?.price ===
                    operation.target.priceId &&
                  line.parent?.subscription_item_details?.subscription ===
                    operation.source.subscriptionId,
              )?.parent?.subscription_item_details?.subscription_item ?? "")
            : operation.source.itemId,
        invoiceId: invoice.id,
        priceId: offer.terms.priceId,
        status: "paid",
        amountPaid: invoice.amount_paid,
        amountRemaining: 0,
        settledAt: (invoice.status_transitions.paid_at ?? now) * 1000,
      },
    }),
  };
}
export async function releaseChangeOffer(
  operation: BillingChangeOperation,
  resourceId: string,
  now: number,
): Promise<OfferUsageMutation | undefined> {
  const offer = operation.target.offer;
  if (!offer) return undefined;
  const expected = await getOfferUsageRepository().get(
    operation.guildId,
    offer.id,
    operation.mode,
  );
  if (
    expected?.state !== "reserved" ||
    expected.operationId !== operation.operationId
  )
    throw changeUnavailable();
  return {
    expected,
    next: {
      guildId: operation.guildId,
      mode: operation.mode,
      offerId: offer.id,
      revision: randomUUID(),
      state: "unused",
      released: {
        operationId: operation.operationId,
        reason:
          operation.timing === "renewal"
            ? "schedule_canceled"
            : "change_canceled",
        resourceId,
        verifiedAt: now * 1000,
      },
    },
  };
}

function assertTargetPrice(
  price: StripePrice,
  plan: Awaited<ReturnType<typeof getPaidPlans>>[number],
  selection: BillingChangeSelection,
  subscription: StripeSubscription,
) {
  if (
    !price.active ||
    price.livemode !== subscription.livemode ||
    price.currency !== subscription.currency ||
    price.unit_amount !== plan.unitAmount ||
    price.recurring?.interval !== selection.interval ||
    price.recurring.interval_count !== 1 ||
    price.recurring.usage_type !== "licensed" ||
    price.billing_scheme !== "per_unit"
  )
    throw changeUnavailable();

  if (price.transform_quantity) throw changeUnavailable();
}
