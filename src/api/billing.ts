import express from "express";
import {
  recordPaymentTransaction,
  saveGuildSubscription,
} from "../services/billingService";
import { getSubscriptionRepository } from "../repositories/subscriptionRepository";
import { config } from "../services/configService";
import { autoRevokeCoveredCompGrants } from "../services/entitlementService";
import { resolveTierFromPrice } from "../services/pricingService";
import { clearGuildSubscriptionCache } from "../services/subscriptionService";
import { getStripeWebhookRepository } from "../repositories/stripeWebhookRepository";
import type {
  StripeCheckoutSession,
  StripeClient,
  StripeEvent,
  StripeInvoice,
  StripeMetadata,
  StripePrice,
  StripeSubscription,
} from "../types/stripe";

type KnownTier = "free" | "basic" | "pro";

type WebhookHandler = (options: {
  stripe: StripeClient;
  event: StripeEvent;
}) => Promise<void>;

const normalizeTier = (tier?: string | null): KnownTier | null => {
  if (tier === "free" || tier === "basic" || tier === "pro") {
    return tier;
  }
  return null;
};

const readMetadataValue = (
  metadata: Record<string, string> | null | undefined,
  key: string,
): string => {
  const value = metadata?.[key];
  return typeof value === "string" ? value : "";
};

const resolvePriceInfo = (
  price: string | StripePrice | null | undefined,
): { priceId?: string; lookupKey?: string } => {
  if (!price) {
    return {};
  }
  if (typeof price === "string") {
    return { priceId: price };
  }
  return { priceId: price.id, lookupKey: price.lookup_key ?? undefined };
};

const resolveSubscriptionPeriodEnd = (
  subscription: StripeSubscription,
): number | undefined => {
  const items = subscription.items?.data ?? [];
  if (!items.length) return undefined;
  return Math.max(...items.map((item) => item.current_period_end));
};

const resolveInvoicePriceInfo = (
  invoice: StripeInvoice,
): { priceId?: string; lookupKey?: string } => {
  const lineItem = invoice.lines?.data?.find(
    (item) => item.pricing?.price_details?.price,
  );
  return resolvePriceInfo(lineItem?.pricing?.price_details?.price);
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

const resolveTierFromSubscription = (
  subscription: StripeSubscription,
): KnownTier => {
  const price = subscription.items?.data?.[0]?.price;
  const { priceId, lookupKey } = resolvePriceInfo(price);
  const tier =
    resolveTierFromPrice({
      priceId,
      lookupKey,
    }) ?? null;
  return tier ?? "basic";
};

const resolveTierFromInvoice = (invoice: StripeInvoice): KnownTier | null => {
  const { priceId, lookupKey } = resolveInvoicePriceInfo(invoice);
  const tier =
    resolveTierFromPrice({
      priceId,
      lookupKey,
    }) ?? null;
  return tier;
};

const toIso = (seconds?: number | null): string | undefined =>
  seconds ? new Date(seconds * 1000).toISOString() : undefined;

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

const buildSubscriptionPayload = (params: {
  guildId: string;
  status: string;
  tier: KnownTier;
  startDate?: string;
  endDate?: string;
  nextBillingDate?: string;
  paymentMethod?: string;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  updatedBy?: string;
  priceId?: string;
  mode: "live" | "test";
}): Parameters<typeof saveGuildSubscription>[0] => ({
  guildId: params.guildId,
  status: params.status,
  tier: params.tier,
  startDate: params.startDate ?? new Date().toISOString(),
  endDate: params.endDate,
  nextBillingDate: params.nextBillingDate,
  paymentMethod: params.paymentMethod,
  subscriptionType: "stripe",
  stripeCustomerId: params.stripeCustomerId,
  stripeSubscriptionId: params.stripeSubscriptionId,
  updatedAt: new Date().toISOString(),
  updatedBy: params.updatedBy,
  priceId: params.priceId,
  mode: params.mode,
});

const maybeAutoRevokeCoveredCompGrants = async (params: {
  guildId: string;
  tier: KnownTier;
  status: string;
  stripeSubscriptionId?: string;
  updatedBy?: string;
}) => {
  if (params.tier !== "basic" && params.tier !== "pro") return;
  if (params.status !== "active" && params.status !== "trialing") return;
  await autoRevokeCoveredCompGrants({
    guildId: params.guildId,
    paidTier: params.tier,
    stripeSubscriptionId: params.stripeSubscriptionId,
    revokedBy: params.updatedBy ?? "stripe",
  });
  clearGuildSubscriptionCache(params.guildId);
};

const handleCheckoutSessionCompleted: WebhookHandler = async ({
  stripe,
  event,
}) => {
  const session = event.data.object as StripeCheckoutSession;
  if (!session.subscription) return;
  const sub = await stripe.subscriptions.retrieve(
    session.subscription as string,
  );
  const guildId =
    readMetadataValue(session.metadata, "guild_id") ||
    readMetadataValue(sub.metadata, "guild_id");
  if (!guildId) {
    console.warn(
      "Stripe checkout session missing guild_id metadata",
      session.id,
    );
    return;
  }
  const tier = resolveTierFromSubscription(sub);
  const stripeSubscriptionId =
    typeof session.subscription === "string" ? session.subscription : undefined;
  const updatedBy =
    readMetadataValue(session.metadata, "discord_id") ||
    readMetadataValue(sub.metadata, "discord_id") ||
    undefined;
  await saveGuildSubscription(
    buildSubscriptionPayload({
      guildId,
      status: sub.status,
      tier,
      startDate: toIso(sub.start_date),
      endDate: toIso(sub.ended_at),
      nextBillingDate: toIso(resolveSubscriptionPeriodEnd(sub)),
      paymentMethod: session.payment_method_types?.[0],
      stripeCustomerId:
        typeof session.customer === "string" ? session.customer : undefined,
      stripeSubscriptionId,
      updatedBy,
      priceId:
        typeof sub.items?.data?.[0]?.price?.id === "string"
          ? sub.items?.data?.[0]?.price?.id
          : undefined,
      mode: sub.livemode ? "live" : "test",
    }),
  );
  await maybeAutoRevokeCoveredCompGrants({
    guildId,
    tier,
    status: sub.status,
    stripeSubscriptionId,
    updatedBy,
  });
};

const handleInvoicePaymentFailed: WebhookHandler = async ({
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
  const existing = await getSubscriptionRepository().get(guildId);
  const existingTier = normalizeTier(existing?.tier);
  const tierFromInvoice = resolveTierFromInvoice(invoice);
  const priceInfo = resolveInvoicePriceInfo(invoice);
  const stripeSubscriptionId =
    typeof invoiceSubscription === "string"
      ? invoiceSubscription
      : invoiceSubscription?.id;
  const tier =
    tierFromInvoice ??
    (existingTier && existingTier !== "free" ? existingTier : "basic");
  await saveGuildSubscription(
    buildSubscriptionPayload({
      guildId,
      status: "past_due",
      tier,
      startDate:
        existing?.startDate ?? new Date(invoice.created * 1000).toISOString(),
      nextBillingDate: invoice.next_payment_attempt
        ? toIso(invoice.next_payment_attempt)
        : existing?.nextBillingDate,
      paymentMethod: invoice.default_payment_method ? "card" : "unknown",
      stripeCustomerId:
        typeof invoice.customer === "string" ? invoice.customer : undefined,
      stripeSubscriptionId,
      priceId: priceInfo.priceId ?? existing?.priceId,
      mode: invoice.livemode ? "live" : "test",
    }),
  );
};

const handleSubscriptionUpsert: WebhookHandler = async ({ event }) => {
  const subscription = event.data.object as StripeSubscription;
  const guildId = readMetadataValue(subscription.metadata, "guild_id");
  if (!guildId) {
    console.warn(
      "Stripe subscription missing guild_id metadata",
      subscription.id,
    );
    return;
  }
  const tier = resolveTierFromSubscription(subscription);
  const updatedBy =
    readMetadataValue(subscription.metadata, "discord_id") || undefined;
  await saveGuildSubscription(
    buildSubscriptionPayload({
      guildId,
      status: subscription.status,
      tier,
      startDate: toIso(subscription.start_date),
      endDate: toIso(subscription.ended_at),
      nextBillingDate: toIso(resolveSubscriptionPeriodEnd(subscription)),
      paymentMethod: subscription.default_payment_method ? "card" : "unknown",
      stripeCustomerId:
        typeof subscription.customer === "string"
          ? subscription.customer
          : undefined,
      stripeSubscriptionId: subscription.id,
      updatedBy,
      priceId:
        typeof subscription.items?.data?.[0]?.price?.id === "string"
          ? subscription.items?.data?.[0]?.price?.id
          : undefined,
      mode: subscription.livemode ? "live" : "test",
    }),
  );
  await maybeAutoRevokeCoveredCompGrants({
    guildId,
    tier,
    status: subscription.status,
    stripeSubscriptionId: subscription.id,
    updatedBy,
  });
};

const handleSubscriptionDeleted: WebhookHandler = async ({ event }) => {
  const subscription = event.data.object as StripeSubscription;
  const guildId = readMetadataValue(subscription.metadata, "guild_id");
  if (!guildId) return;
  await saveGuildSubscription(
    buildSubscriptionPayload({
      guildId,
      status: "canceled",
      tier: "free",
      startDate: toIso(subscription.start_date),
      endDate: toIso(subscription.ended_at) ?? new Date().toISOString(),
      paymentMethod: undefined,
      stripeCustomerId:
        typeof subscription.customer === "string"
          ? subscription.customer
          : undefined,
      stripeSubscriptionId: subscription.id,
      mode: subscription.livemode ? "live" : "test",
    }),
  );
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
};

const handlersByEvent: Record<string, WebhookHandler> = {
  "checkout.session.completed": handleCheckoutSessionCompleted,
  "invoice.payment_failed": handleInvoicePaymentFailed,
  "invoice.payment_succeeded": handleInvoicePaymentSucceeded,
  "customer.subscription.created": handleSubscriptionUpsert,
  "customer.subscription.updated": handleSubscriptionUpsert,
  "customer.subscription.deleted": handleSubscriptionDeleted,
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
      const existing = await webhookRepo.get(event.id);
      if (existing) {
        res.json({ received: true });
        return;
      }
      const handler = handlersByEvent[event.type];
      if (handler) {
        await handler({ stripe, event });
      }

      const ttlSeconds = 60 * 60 * 24 * 30;
      await webhookRepo.write({
        eventId: event.id,
        receivedAt: new Date().toISOString(),
        expiresAt: Math.floor(Date.now() / 1000) + ttlSeconds,
      });
      res.json({ received: true });
    } catch (err) {
      console.error("Stripe webhook handler error", err);
      res.status(500).send("Webhook handler failure");
    }
  });
}
