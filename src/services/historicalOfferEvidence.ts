import type Stripe from "stripe";
import { z } from "zod";
import type { StripeInvoice, StripePrice } from "../types/stripe";
import {
  BASIC_INTRO_OFFERS,
  introOfferIdSchema,
} from "../types/basicIntroOffers";
import {
  providerModeSchema,
  offerTermsSchema,
  type OfferUsage,
  type IntroOfferId,
} from "../types/offerUsage";
import { assertFirstOfferInvoice } from "./firstOfferInvoiceEvidence";

export const historicalOfferScopeSchema = z.object({
  guildId: z.string().regex(/^\d{17,20}$/),
  mode: providerModeSchema,
  accountId: z.string().min(1),
  createdBefore: z.number().int().nonnegative(),
});
export type HistoricalOfferScope = z.infer<typeof historicalOfferScopeSchema>;
const originalSchema = z.object({
  guild_id: z.string().regex(/^\d{17,20}$/),
  discord_id: z.string().min(1),
  purchase_attempt_id: z.string().min(1),
  intro_offer_id: introOfferIdSchema,
  intro_offer_coupon_id: z.string().min(1),
});
type Terms = Extract<OfferUsage, { state: "reserved" }>["terms"];
type Origin = {
  offerId: IntroOfferId;
  originalOperationId: string;
  originalPayerId: string;
  productId: string;
  customerId: string;
  subscriptionId: string;
  invoiceId: string;
  createdAt: number;
  terms: Terms;
};
export type HistoricalOfferEvidence =
  | { kind: "ordinary" }
  | {
      kind: "covered_cycle";
      invoiceId: string;
      offerId: IntroOfferId;
      originalInvoiceId: string;
    }
  | {
      kind: "unresolved";
      invoiceId: string;
      offerId: IntroOfferId | null;
      reason:
        | "missing_snapshot"
        | "unsupported_identity"
        | "unsettled"
        | "missing_campaign";
    }
  | (Origin & { kind: "unpaid_void"; voidedAt: number })
  | (Origin & {
      kind: "settled";
      settlement: Extract<OfferUsage, { state: "used" }>["settlement"];
    });
const id = (reference: string | { id: string } | null | undefined) =>
  typeof reference === "string" ? reference : reference?.id;
const invalid = () =>
  new Error(
    "Historical offer invoice evidence does not match its scope or terms",
  );

// Assessment only. Account verification, complete scan coverage and conditional
// import ownership are separate requirements before this evidence is persisted.
export function classifyHistoricalOfferInvoice(
  invoice: StripeInvoice,
  price: StripePrice | undefined,
  input: HistoricalOfferScope,
): HistoricalOfferEvidence {
  const scope = historicalOfferScopeSchema.parse(input);
  const details = invoice.parent?.subscription_details;
  const metadata = details?.metadata;
  assertHistoryScope(invoice, metadata, scope);
  if (!metadata)
    return {
      kind: "unresolved",
      invoiceId: invoice.id,
      offerId: null,
      reason: "missing_snapshot",
    };
  if (!metadata.intro_offer_id && !metadata.intro_offer_coupon_id) {
    if (
      invoice.status === "draft" ||
      invoice.lines.has_more ||
      hasUnidentifiedDiscounts(invoice)
    )
      return {
        kind: "unresolved",
        invoiceId: invoice.id,
        offerId: null,
        reason: "unsupported_identity",
      };
    return { kind: "ordinary" };
  }
  const original = originalSchema.safeParse(metadata);
  if (!original.success)
    return {
      kind: "unresolved",
      invoiceId: invoice.id,
      offerId: null,
      reason: "unsupported_identity",
    };
  if (!price)
    return {
      kind: "unresolved",
      invoiceId: invoice.id,
      offerId: original.data.intro_offer_id,
      reason: "unsupported_identity",
    };
  const customerId = id(invoice.customer);
  const subscriptionId = id(details?.subscription);
  if (!customerId || !subscriptionId) throw invalid();
  const descriptor = BASIC_INTRO_OFFERS[original.data.intro_offer_id];
  const terms = offerTermsSchema.parse({
    priceId: price.id,
    couponId: original.data.intro_offer_coupon_id,
    currency: descriptor.terms.currency,
    interval: descriptor.interval,
    regularUnitAmount: descriptor.terms.regularUnitAmount,
    discountedUnitAmount: descriptor.terms.discountedUnitAmount,
    durationMonths: descriptor.terms.durationMonths,
  });
  if (invoice.currency !== terms.currency) throw invalid();
  assertHistoricalPrice(price, terms, scope);
  if (!verifyHistoricalCampaign(invoice, price, original.data.intro_offer_id))
    return {
      kind: "unresolved",
      invoiceId: invoice.id,
      offerId: original.data.intro_offer_id,
      reason: "missing_campaign",
    };
  assertFirstOfferInvoice(invoice, subscriptionId, terms);
  const origin: Origin = {
    offerId: original.data.intro_offer_id,
    originalOperationId: original.data.purchase_attempt_id,
    originalPayerId: original.data.discord_id,
    productId: id(price.product)!,
    customerId,
    subscriptionId,
    invoiceId: invoice.id,
    createdAt: invoice.created * 1000,
    terms,
  };
  return historicalPayment(invoice, origin);
}
function assertHistoryScope(
  invoice: StripeInvoice,
  metadata: StripeInvoice["metadata"] | null | undefined,
  scope: HistoricalOfferScope,
) {
  if (
    !invoice.id ||
    invoice.livemode !== (scope.mode === "live") ||
    !Number.isInteger(invoice.created) ||
    invoice.created < 0 ||
    invoice.created > scope.createdBefore ||
    (metadata && metadata.guild_id !== scope.guildId)
  )
    throw invalid();
}
function assertHistoricalPrice(
  price: StripePrice,
  terms: Terms,
  scope: HistoricalOfferScope,
) {
  if (
    price.livemode !== (scope.mode === "live") ||
    price.currency !== terms.currency ||
    price.type !== "recurring" ||
    price.billing_scheme !== "per_unit" ||
    price.transform_quantity ||
    price.unit_amount !== terms.regularUnitAmount ||
    price.recurring?.interval !== terms.interval ||
    price.recurring.interval_count !== 1 ||
    price.recurring.usage_type !== "licensed"
  )
    throw invalid();
}
function historicalPayment(
  invoice: StripeInvoice,
  origin: Origin,
): HistoricalOfferEvidence {
  if (invoice.status === "paid") {
    const paidAt = invoice.status_transitions.paid_at;
    if (
      paidAt === null ||
      !Number.isInteger(paidAt) ||
      paidAt < invoice.created ||
      !Number.isInteger(invoice.amount_paid) ||
      invoice.amount_paid < 0 ||
      invoice.amount_remaining !== 0
    )
      throw invalid();
    const parent = invoice.lines.data[0].parent?.subscription_item_details;
    if (!parent?.subscription_item) throw invalid();
    return {
      ...origin,
      kind: "settled",
      settlement: {
        customerId: origin.customerId,
        subscriptionId: origin.subscriptionId,
        subscriptionItemId: parent.subscription_item,
        invoiceId: invoice.id,
        priceId: origin.terms.priceId,
        status: "paid",
        amountPaid: invoice.amount_paid,
        amountRemaining: 0,
        settledAt: paidAt * 1000,
      },
    };
  }
  if (invoice.status === "void") {
    const voidedAt = invoice.status_transitions.voided_at;
    if (
      voidedAt === null ||
      !Number.isInteger(voidedAt) ||
      voidedAt < invoice.created ||
      invoice.status_transitions.paid_at !== null ||
      invoice.amount_paid !== 0
    )
      throw invalid();
    return { ...origin, kind: "unpaid_void", voidedAt: voidedAt * 1000 };
  }
  return {
    kind: "unresolved",
    invoiceId: invoice.id,
    offerId: origin.offerId,
    reason: "unsettled",
  };
}

function hasUnidentifiedDiscounts(invoice: StripeInvoice): boolean {
  return (
    invoice.discounts.length > 0 ||
    Boolean(
      invoice.total_discount_amounts?.some((discount) => discount.amount > 0),
    ) ||
    invoice.lines.data.some((line) =>
      line.discount_amounts?.some((discount) => discount.amount > 0),
    )
  );
}
function verifyHistoricalCampaign(
  invoice: StripeInvoice,
  price: StripePrice,
  offerId: IntroOfferId,
): boolean {
  if (invoice.discounts.length !== 1) throw invalid();
  const discount = invoice.discounts[0];
  if (typeof discount === "string") throw invalid();
  const coupon = discount.source.coupon;
  if (coupon === null || typeof coupon === "string" || coupon.deleted)
    return false;
  const descriptor = BASIC_INTRO_OFFERS[offerId];
  assertHistoricalCouponTerms(coupon, descriptor, invoice.livemode);
  const productId = id(price.product);
  if (
    !productId ||
    (coupon.applies_to && !coupon.applies_to.products.includes(productId))
  )
    throw invalid();
  return true;
}
function assertHistoricalCouponTerms(
  coupon: Stripe.Coupon,
  descriptor: (typeof BASIC_INTRO_OFFERS)[IntroOfferId],
  live: boolean,
) {
  if (
    coupon.livemode !== live ||
    coupon.percent_off !== descriptor.terms.percentOff ||
    coupon.amount_off !== null ||
    coupon.currency !== null ||
    coupon.duration !==
      (descriptor.interval === "year" ? "once" : "repeating") ||
    coupon.duration_in_months !==
      (descriptor.interval === "year" ? null : descriptor.terms.durationMonths)
  )
    throw invalid();
}

export function coverHistoricalOfferCycle(
  invoice: StripeInvoice,
  scope: HistoricalOfferScope,
  origins: Extract<HistoricalOfferEvidence, { kind: "settled" }>[],
): Extract<HistoricalOfferEvidence, { kind: "covered_cycle" }> | undefined {
  const details = invoice.parent?.subscription_details;
  const metadata = details?.metadata;
  assertHistoryScope(invoice, metadata, scope);
  if (!isSettledHistoricalCycle(invoice)) return undefined;
  const origin = origins.find(
    (candidate) =>
      candidate.subscriptionId === id(details?.subscription) &&
      candidate.customerId === id(invoice.customer) &&
      candidate.offerId === metadata?.intro_offer_id &&
      candidate.originalOperationId === metadata?.purchase_attempt_id &&
      candidate.originalPayerId === metadata?.discord_id &&
      candidate.terms.couponId === metadata?.intro_offer_coupon_id &&
      invoice.created * 1000 >= candidate.settlement.settledAt,
  );
  if (!origin || invoice.currency !== origin.terms.currency) return undefined;
  const covered =
    invoice.discounts.length > 0
      ? matchesDiscountedCycle(invoice, origin)
      : matchesRegularCycle(invoice, origin);
  if (!covered) return undefined;
  return {
    kind: "covered_cycle",
    invoiceId: invoice.id,
    offerId: origin.offerId,
    originalInvoiceId: origin.invoiceId,
  };
}

type SettledOrigin = Extract<HistoricalOfferEvidence, { kind: "settled" }>;
function isSettledHistoricalCycle(invoice: StripeInvoice): boolean {
  return (
    invoice.billing_reason === "subscription_cycle" &&
    invoice.status === "paid" &&
    invoice.amount_remaining === 0 &&
    Number.isInteger(invoice.amount_paid) &&
    invoice.amount_paid >= 0 &&
    invoice.status_transitions.paid_at !== null &&
    Number.isInteger(invoice.status_transitions.paid_at) &&
    invoice.status_transitions.paid_at >= invoice.created
  );
}
function matchesDiscountedCycle(
  invoice: StripeInvoice,
  origin: SettledOrigin,
): boolean {
  try {
    if (origin.terms.interval !== "month") return false;
    const discount = invoice.discounts[0];
    if (typeof discount === "string") return false;
    const coupon = discount.source.coupon;
    if (!coupon || typeof coupon === "string" || coupon.deleted) return false;
    if (
      coupon.applies_to &&
      !coupon.applies_to.products.includes(origin.productId)
    )
      return false;
    if (
      invoice.lines.data[0]?.parent?.subscription_item_details
        ?.subscription_item !== origin.settlement.subscriptionItemId
    )
      return false;
    assertHistoricalCouponTerms(
      coupon,
      BASIC_INTRO_OFFERS[origin.offerId],
      invoice.livemode,
    );
    assertFirstOfferInvoice(
      invoice,
      origin.subscriptionId,
      origin.terms,
      "subscription_cycle",
    );

    return true;
  } catch {
    return false;
  }
}
function matchesRegularCycle(
  invoice: StripeInvoice,
  origin: SettledOrigin,
): boolean {
  const line = invoice.lines.data[0];
  if (
    invoice.lines.has_more ||
    invoice.lines.data.length !== 1 ||
    hasUnidentifiedDiscounts(invoice) ||
    invoice.subtotal !== origin.terms.regularUnitAmount
  )
    return false;
  return (
    matchesRegularCycleLine(invoice, line, origin) &&
    matchesCycleParent(line, origin)
  );
}
function matchesRegularCycleLine(
  invoice: StripeInvoice,
  line: StripeInvoice["lines"]["data"][number],
  origin: SettledOrigin,
): boolean {
  return (
    line.invoice === invoice.id &&
    line.currency === origin.terms.currency &&
    line.livemode === invoice.livemode &&
    line.quantity === 1 &&
    line.amount === origin.terms.regularUnitAmount &&
    id(line.pricing?.price_details?.price) === origin.terms.priceId
  );
}
function matchesCycleParent(
  line: StripeInvoice["lines"]["data"][number],
  origin: SettledOrigin,
): boolean {
  const parent = line.parent?.subscription_item_details;
  return (
    parent?.subscription === origin.subscriptionId &&
    parent.subscription_item === origin.settlement.subscriptionItemId &&
    !parent.proration &&
    Number.isInteger(line.period.start) &&
    Number.isInteger(line.period.end) &&
    line.period.end > line.period.start
  );
}
