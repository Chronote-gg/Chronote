import { reconcileBillingChangeForWebhook } from "../services/billingChangeService";
import { refreshRenewalRecovery } from "../services/renewalRecoveryService";
import { captureBillingInvoiceOutcome } from "../services/billingLifecycleAnalytics";
import { checkoutInvoiceHint } from "../services/purchaseSession";
import type Stripe from "stripe";
import {
  expirePurchaseAttempt,
  isPurchaseAnalyticsOptedOut,
} from "../services/purchaseReconciliation";
import { reconcileSubscription } from "../services/subscriptionReconciliation";
import express from "express";
import { randomUUID } from "node:crypto";

import { recordPaymentTransaction } from "../services/billingService";

import { config } from "../services/configService";
import { resolveGuildSubscription } from "../services/subscriptionService";
import { captureEvent } from "../services/analyticsService";
import {
  resolvePurchaseSource,
  resolvePurchaseOffer,
  recordingLimitAnalytics,
} from "../utils/purchaseAnalytics";
import { resolveTierFromPrice } from "../services/pricingService";
import { getStripeWebhookRepository } from "../repositories/stripeWebhookRepository";
import type {
  StripeCheckoutSession,
  StripeClient,
  StripeEvent,
  StripeInvoice,
  StripeMetadata,
  StripeSubscription,
} from "../types/stripe";

const WEBHOOK_PROCESSING_LEASE_MS = 60_000;

type WebhookHandler = (options: {
  stripe: StripeClient;
  event: StripeEvent;
}) => Promise<void>;

const readMetadataValue = (
  metadata: Record<string, string> | null | undefined,
  key: string,
): string => {
  const value = metadata?.[key];
  return typeof value === "string" ? value : "";
};

const resolveInvoiceSubscription = (
  invoice: StripeInvoice,
): string | StripeSubscription | null =>
  invoice.parent?.subscription_details?.subscription ?? null;

const resolveInvoiceMetadata = (
  invoice: StripeInvoice,
): StripeMetadata | null | undefined =>
  invoice.parent?.subscription_details?.metadata ?? invoice.metadata;

const resolveInvoiceDiscountCode = (
  invoice: StripeInvoice,
): string | undefined => {
  const discount = invoice.discounts?.[0];
  if (!discount || typeof discount === "string") return undefined;
  if ("deleted" in discount && discount.deleted) return undefined;
  const coupon = discount.source?.coupon;
  if (!coupon) return undefined;
  return typeof coupon === "string" ? coupon : coupon.id;
};

const resolveGuildIdFromInvoice = async (
  stripe: StripeClient,
  invoice: StripeInvoice,
): Promise<string> => {
  const fromDetails = readMetadataValue(
    resolveInvoiceMetadata(invoice),
    "guild_id",
  );
  if (fromDetails) return fromDetails;

  const invoiceSubscription = resolveInvoiceSubscription(invoice);
  if (invoiceSubscription && typeof invoiceSubscription !== "string") {
    const fromSubscription = readMetadataValue(
      invoiceSubscription.metadata,
      "guild_id",
    );
    if (fromSubscription) return fromSubscription;
  }

  if (typeof invoiceSubscription === "string") {
    const subscription =
      await stripe.subscriptions.retrieve(invoiceSubscription);
    return readMetadataValue(subscription.metadata, "guild_id");
  }

  return "";
};

const handleCheckoutSessionCompleted: WebhookHandler = async ({
  stripe,
  event,
}) => {
  const session = event.data.object as StripeCheckoutSession;
  if (!session.subscription) return;
  const subscriptionId =
    typeof session.subscription === "string"
      ? session.subscription
      : session.subscription.id;
  let guildId = readMetadataValue(session.metadata, "guild_id");
  if (!guildId) {
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    guildId = readMetadataValue(subscription.metadata, "guild_id");
  }
  if (!guildId) {
    console.warn(
      "Stripe checkout session missing guild_id metadata",
      session.id,
    );
    return;
  }
  await reconcileSubscription(
    stripe,
    guildId,
    subscriptionId,
    checkoutInvoiceHint(session),
  );
};

const handleInvoicePaymentFailed: WebhookHandler = async ({
  stripe,
  event,
}) => {
  const invoice = event.data.object as StripeInvoice;
  const guildId = await resolveGuildIdFromInvoice(stripe, invoice);
  const subscription = resolveInvoiceSubscription(invoice);
  if (!guildId) return;
  await refreshRenewalRecovery({
    stripe,
    guildId,
    now: Math.floor(Date.now() / 1000),
  });
  await reconcileBillingChangeForWebhook(stripe, guildId);
  if (!subscription) return;
  await reconcileSubscription(
    stripe,
    guildId,
    typeof subscription === "string" ? subscription : subscription.id,
  );
  await captureBillingInvoiceOutcome({ stripe, invoice, outcome: "failed" });
};

const handleSubscriptionUpsert: WebhookHandler = async ({ stripe, event }) => {
  const subscription = event.data.object as StripeSubscription;
  const guildId = readMetadataValue(subscription.metadata, "guild_id");
  if (!guildId) {
    console.warn(
      "Stripe subscription missing guild_id metadata",
      subscription.id,
    );
    return;
  }
  await reconcileBillingChangeForWebhook(stripe, guildId);
  await reconcileSubscription(stripe, guildId, subscription.id);
  // A deletion may have ended an unexpired review. Recover after persisting it
  // so a replacement purchase never waits for a browser visit or quote expiry.
  await reconcileBillingChangeForWebhook(stripe, guildId);
};

const handleInvoicePaymentSucceeded: WebhookHandler = async ({
  stripe,
  event,
}) => {
  const invoice = event.data.object as StripeInvoice;
  const guildId = await resolveGuildIdFromInvoice(stripe, invoice);
  if (!guildId) {
    console.warn("Stripe invoice missing guild_id metadata", invoice.id);
    return;
  }
  const invoiceSubscription = resolveInvoiceSubscription(invoice);
  await recordPaymentTransaction({
    transactionID: invoice.id,
    userID: guildId,
    amount: (invoice.amount_paid || 0) / 100,
    currency: invoice.currency,
    status: invoice.status || "paid",
    paymentDate: new Date(invoice.created * 1000).toISOString(),
    paymentMethod: invoice.default_payment_method ? "card" : "unknown",
    discountCode: resolveInvoiceDiscountCode(invoice),
    subscriptionID: invoiceSubscription
      ? typeof invoiceSubscription === "string"
        ? invoiceSubscription
        : invoiceSubscription.id
      : "",
    customerId:
      typeof invoice.customer === "string" ? invoice.customer : undefined,
  });
  await reconcileBillingChangeForWebhook(stripe, guildId);
  if (invoice.metadata?.chronote_invoice_role === "funding") return;
  const reconciled = invoiceSubscription
    ? await reconcileSubscription(
        stripe,
        guildId,
        typeof invoiceSubscription === "string"
          ? invoiceSubscription
          : invoiceSubscription.id,
        { invoiceId: invoice.id },
      )
    : undefined;
  await captureBillingInvoiceOutcome({ stripe, invoice, outcome: "settled" });
  if (
    invoice.status === "paid" &&
    invoice.amount_paid > 0 &&
    reconciled?.subscription.status === "active" &&
    reconciled.tier !== "free"
  )
    await capturePaidInvoiceOnce(
      invoice,
      guildId,
      reconciled.subscription,
      stripe,
    );
};

async function resolveInvoicePlan(
  stripe: StripeClient,
  invoice: StripeInvoice,
) {
  const invoicePrice = invoice.lines?.data.find(
    (line) => line.amount > 0 && line.pricing?.price_details?.price,
  )?.pricing?.price_details?.price;
  const price =
    typeof invoicePrice === "string"
      ? await stripe.prices.retrieve(invoicePrice).catch(() => undefined)
      : invoicePrice;
  return {
    price,
    tier: price
      ? (resolveTierFromPrice({
          priceId: price.id,
          lookupKey: price.lookup_key,
        }) ?? undefined)
      : undefined,
    interval: price?.recurring?.interval,
  };
}

async function capturePaidInvoiceOnce(
  invoice: StripeInvoice,
  guildId: string,
  subscription: StripeSubscription,
  stripe: StripeClient,
) {
  const billingKinds: Record<string, string> = {
    subscription_create: "initial_purchase",
    subscription_cycle: "renewal",
    subscription_update: "plan_change",
  };
  const billingKind = billingKinds[invoice.billing_reason ?? ""] ?? "unknown";
  try {
    const { tier, interval, price } = await resolveInvoicePlan(stripe, invoice);
    // Qualification is analytics-only; a lookup outage must not retry paid billing.
    const effective = await resolveGuildSubscription(guildId);
    if (effective.billingSource !== "stripe" || effective.status !== "active")
      return;
    if (await isPurchaseAnalyticsOptedOut(guildId, subscription)) return;
    const invoicePrice = await classifyInvoicePrice({
      stripe,
      invoice,
      subscription,
      price,
    });
    // Reuse webhook receipts for one canonical outcome per invoice, including
    // retries delivered under a different Stripe event id (30-day retention).
    const now = Date.now();
    if (
      !(await getStripeWebhookRepository().tryCreate({
        eventId: `paid_invoice:${invoice.id}`,
        receivedAt: new Date(now).toISOString(),
        expiresAt: Math.floor(now / 1000) + 60 * 60 * 24 * 30,
      }))
    )
      return;
    captureEvent("billing_entitlement_saved", {
      userId:
        readMetadataValue(subscription.metadata, "discord_id") || undefined,
      guildId,
      properties: {
        surface: "stripe_webhook",
        event_version: 1,
        tier,
        billing_kind: billingKind,
        offer: resolvePurchaseOffer(subscription.metadata.intro_offer_id),
        invoice_price: invoicePrice,
        ...recordingLimitAnalytics({
          limitType:
            readMetadataValue(subscription.metadata, "recording_limit_type") ||
            undefined,
          limitSurface:
            readMetadataValue(
              subscription.metadata,
              "recording_limit_surface",
            ) || undefined,
        }),
        source: resolvePurchaseSource(
          readMetadataValue(subscription.metadata, "purchase_source") ||
            "unknown",
        ),
        interval: ["month", "year"].includes(interval ?? "")
          ? interval
          : "unknown",
        promo_present:
          subscription.metadata.purchase_promo_present === "true" ||
          Boolean(readMetadataValue(subscription.metadata, "promo_code")),
      },
    });
  } catch {
    console.warn("Paid outcome analytics unavailable");
  }
}

// Keep the native invoice identity, settlement and line evidence together so
// reviewers can audit the complete rejection contract without provider reads.
function hasUnsupportedInvoiceEvidence(
  invoice: StripeInvoice,
  eventInvoice: StripeInvoice,
  subscription: StripeSubscription,
  price: NonNullable<Awaited<ReturnType<typeof resolveInvoicePlan>>["price"]>,
): boolean {
  const reference = resolveInvoiceSubscription(invoice);
  const owner =
    typeof invoice.customer === "string"
      ? invoice.customer
      : invoice.customer?.id;
  const subscriptionOwner =
    typeof subscription.customer === "string"
      ? subscription.customer
      : subscription.customer.id;
  const line = invoice.lines?.data[0];
  const linePrice = line?.pricing?.price_details?.price;
  const linePriceId = typeof linePrice === "string" ? linePrice : linePrice?.id;
  const parent = line?.parent?.subscription_item_details;
  const discounts = invoice.total_discount_amounts;
  return Boolean(
    invoice.id !== eventInvoice.id ||
    invoice.amount_paid !== eventInvoice.amount_paid ||
    invoice.subtotal !== eventInvoice.subtotal ||
    invoice.total_excluding_tax !== eventInvoice.total_excluding_tax ||
    (typeof reference === "string" ? reference : reference?.id) !==
      subscription.id ||
    owner !== subscriptionOwner ||
    invoice.livemode !== subscription.livemode ||
    invoice.status !== "paid" ||
    invoice.amount_paid !== invoice.total ||
    invoice.amount_remaining !== 0 ||
    invoice.starting_balance !== 0 ||
    invoice.ending_balance !== 0 ||
    invoice.pre_payment_credit_notes_amount !== 0 ||
    invoice.post_payment_credit_notes_amount !== 0 ||
    !Number.isSafeInteger(invoice.subtotal) ||
    !Number.isSafeInteger(invoice.total_excluding_tax) ||
    invoice.lines.has_more ||
    invoice.lines.data.length !== 1 ||
    !line ||
    line.invoice !== invoice.id ||
    linePriceId !== price.id ||
    line.quantity !== 1 ||
    parent?.subscription !== subscription.id ||
    parent.proration !== false ||
    line.currency !== invoice.currency ||
    invoice.currency !== price.currency ||
    line.subtotal !== price.unit_amount ||
    invoice.subtotal !== line.subtotal ||
    price.type !== "recurring" ||
    price.billing_scheme !== "per_unit" ||
    price.transform_quantity ||
    !Array.isArray(invoice.discounts) ||
    !Array.isArray(discounts) ||
    !Array.isArray(line.discount_amounts) ||
    line.pretax_credit_amounts?.some((credit) => credit.type !== "discount"),
  );
}

function hasUnsupportedDiscountAccounting(
  invoice: StripeInvoice,
  discount: Stripe.Discount,
  totalDiscount: NonNullable<StripeInvoice["total_discount_amounts"]>[number],
  lineDiscount: NonNullable<
    StripeInvoice["lines"]["data"][number]["discount_amounts"]
  >[number],
): boolean {
  const totalId =
    typeof totalDiscount.discount === "string"
      ? totalDiscount.discount
      : totalDiscount.discount.id;
  const lineId =
    typeof lineDiscount.discount === "string"
      ? lineDiscount.discount
      : lineDiscount.discount.id;
  return Boolean(
    totalId !== discount.id ||
    lineId !== discount.id ||
    !Number.isSafeInteger(totalDiscount.amount) ||
    totalDiscount.amount <= 0 ||
    totalDiscount.amount !== lineDiscount.amount ||
    invoice.total_excluding_tax !== invoice.subtotal - totalDiscount.amount,
  );
}

function matchesIntroCouponTerms(
  coupon: Stripe.Coupon,
  annual: boolean,
): boolean {
  return (
    coupon.percent_off === 40 &&
    coupon.amount_off === null &&
    coupon.currency === null &&
    coupon.duration === (annual ? "once" : "repeating") &&
    coupon.duration_in_months === (annual ? null : 3)
  );
}

function matchesIntroductoryInvoiceTerms(
  invoice: StripeInvoice,
  price: NonNullable<Awaited<ReturnType<typeof resolveInvoicePlan>>["price"]>,
  coupon: Stripe.Coupon,
  offer: ReturnType<typeof resolvePurchaseOffer>,
  totalDiscount: NonNullable<StripeInvoice["total_discount_amounts"]>[number],
): boolean {
  const annual = offer === "basic_annual_intro_v1";
  return (
    resolveTierFromPrice({
      priceId: price.id,
      lookupKey: price.lookup_key,
    }) === "basic" &&
    price.currency === "usd" &&
    price.unit_amount === (annual ? 10000 : 1000) &&
    price.recurring?.interval === (annual ? "year" : "month") &&
    price.recurring.interval_count === 1 &&
    matchesIntroCouponTerms(coupon, annual) &&
    totalDiscount.amount === (annual ? 4000 : 400) &&
    (!annual || invoice.billing_reason === "subscription_create")
  );
}

function classifyInvoiceDiscountShape(
  invoice: StripeInvoice,
  discounts: NonNullable<StripeInvoice["total_discount_amounts"]>,
  lineDiscounts: NonNullable<
    StripeInvoice["lines"]["data"][number]["discount_amounts"]
  >,
): "regular_price" | "unknown" | null {
  if (!invoice.discounts.length && !discounts.length && !lineDiscounts.length)
    return invoice.total_excluding_tax === invoice.subtotal
      ? "regular_price"
      : "unknown";
  if (
    invoice.discounts.length !== 1 ||
    discounts.length !== 1 ||
    lineDiscounts.length !== 1
  )
    return "unknown";
  return null;
}

async function classifyInvoiceCoupon(
  stripe: StripeClient,
  invoice: StripeInvoice,
  subscription: StripeSubscription,
  discount: Stripe.Discount,
  price: NonNullable<Awaited<ReturnType<typeof resolveInvoicePlan>>["price"]>,
  totalDiscount: NonNullable<StripeInvoice["total_discount_amounts"]>[number],
): Promise<"intro_discounted" | "other_discount" | "unknown"> {
  const couponReference = discount.source.coupon;
  if (!couponReference) return "unknown";
  const coupon =
    typeof couponReference === "string"
      ? await stripe.coupons.retrieve(couponReference)
      : couponReference;
  if (coupon.deleted || coupon.livemode !== invoice.livemode) return "unknown";
  const offer = resolvePurchaseOffer(subscription.metadata.intro_offer_id);
  if (
    offer === "none" ||
    coupon.id !== subscription.metadata.intro_offer_coupon_id ||
    discount.promotion_code
  )
    return "other_discount";
  return matchesIntroductoryInvoiceTerms(
    invoice,
    price,
    coupon,
    offer,
    totalDiscount,
  )
    ? "intro_discounted"
    : "unknown";
}

// Classify the event's invoice, never the subscription's latest/current period.
// Unsupported native evidence is an analytics category, not a billing failure.
async function classifyInvoicePrice({
  stripe,
  invoice: eventInvoice,
  subscription,
  price,
}: {
  stripe: StripeClient;
  invoice: StripeInvoice;
  subscription: StripeSubscription;
  price: Awaited<ReturnType<typeof resolveInvoicePlan>>["price"];
}): Promise<
  "intro_discounted" | "regular_price" | "other_discount" | "unknown"
> {
  try {
    const invoice = eventInvoice.discounts?.some(
      (discount) => typeof discount === "string",
    )
      ? await stripe.invoices.retrieve(eventInvoice.id, {
          expand: ["discounts.source.coupon"],
        })
      : eventInvoice;
    if (
      !price ||
      !price.unit_amount ||
      hasUnsupportedInvoiceEvidence(invoice, eventInvoice, subscription, price)
    )
      return "unknown";
    const line = invoice.lines.data[0];
    const discounts = invoice.total_discount_amounts;
    if (!Array.isArray(discounts) || !Array.isArray(line.discount_amounts))
      return "unknown";
    const shape = classifyInvoiceDiscountShape(
      invoice,
      discounts,
      line.discount_amounts,
    );
    if (shape !== null) return shape;
    const discount = invoice.discounts[0];
    if (typeof discount === "string" || !discount || discount.deleted)
      return "unknown";
    const totalDiscount = discounts[0];
    const lineDiscount = line.discount_amounts[0];
    if (
      hasUnsupportedDiscountAccounting(
        invoice,
        discount,
        totalDiscount,
        lineDiscount,
      )
    )
      return "unknown";
    return await classifyInvoiceCoupon(
      stripe,
      invoice,
      subscription,
      discount,
      price,
      totalDiscount,
    );
  } catch {
    return "unknown";
  }
}

const handlersByEvent: Record<string, WebhookHandler> = {
  "checkout.session.expired": async ({ stripe, event }) =>
    expirePurchaseAttempt(stripe, event.data.object as StripeCheckoutSession),
  "checkout.session.completed": handleCheckoutSessionCompleted,
  "invoice.payment_failed": handleInvoicePaymentFailed,
  "invoice.payment_succeeded": handleInvoicePaymentSucceeded,
  "invoice.paid": handleInvoicePaymentSucceeded,
  "customer.subscription.created": handleSubscriptionUpsert,
  "customer.subscription.updated": handleSubscriptionUpsert,
  "customer.subscription.deleted": handleSubscriptionUpsert,
};

export function registerBillingRoutes(
  app: express.Express,
  stripe: StripeClient | null,
) {
  app.post("/api/billing/webhook", async (req, res): Promise<void> => {
    if (!stripe || !config.stripe.webhookSecret) {
      res.status(500).send("Stripe webhook not configured");
      return;
    }
    const sig = req.headers["stripe-signature"] as string;
    let event: StripeEvent;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        config.stripe.webhookSecret,
      );
    } catch (err) {
      console.error("Stripe webhook signature error", err);
      res.status(400).send("Bad signature");
      return;
    }

    try {
      const webhookRepo = getStripeWebhookRepository();
      const ttlSeconds = 60 * 60 * 24 * 30;
      const leaseToken = randomUUID();
      const claimed = await webhookRepo.claim({
        state: "processing",
        leaseToken,
        leaseUntil: Date.now() + WEBHOOK_PROCESSING_LEASE_MS,
        eventId: event.id,
        receivedAt: new Date().toISOString(),
        expiresAt: Math.floor(Date.now() / 1000) + ttlSeconds,
      });
      if (!claimed) {
        const receipt = await webhookRepo.get(event.id);
        if (!receipt || receipt.state === "processing") {
          res.status(503).send("Webhook processing; retry");
          return;
        }
        res.json({ received: true });
        return;
      }

      try {
        const handler = handlersByEvent[event.type];
        if (handler) {
          await handler({ stripe, event });
        }
      } catch (handlerError) {
        await webhookRepo.finish(event.id, leaseToken, true);
        throw handlerError;
      }
      if (!(await webhookRepo.finish(event.id, leaseToken))) {
        res.status(503).send("Webhook lease lost; retry");
        return;
      }
      res.json({ received: true });
    } catch (err) {
      console.error("Stripe webhook handler error", err);
      res.status(500).send("Webhook handler failure");
    }
  });
}
