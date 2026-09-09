import express from "express";
import { randomUUID } from "node:crypto";
import type { GuildSubscription } from "../types/db";
import { recordPaymentTransaction } from "../services/billingService";
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
}): GuildSubscription => ({
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

const isTerminalSubscription = (subscription: StripeSubscription) =>
  subscription.status === "canceled" ||
  subscription.status === "incomplete_expired";

// Read the row before fetching Stripe. If another webhook commits during the
// fetch, retry both reads so an older response cannot undo its newer state.
const reconcileSubscription = async (
  stripe: StripeClient,
  guildId: string,
  subscriptionId: string,
) => {
  const repo = getSubscriptionRepository();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const existing = await repo.get(guildId);
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    if (readMetadataValue(subscription.metadata, "guild_id") !== guildId) {
      throw new Error("Stripe subscription guild metadata does not match");
    }
    if (
      existing?.stripeSubscriptionId &&
      existing.stripeSubscriptionId !== subscription.id
    ) {
      // Old terminal events cannot adopt a guild that now points elsewhere.
      if (isTerminalSubscription(subscription)) return;
      const previous = await stripe.subscriptions.retrieve(
        existing.stripeSubscriptionId,
      );
      if (readMetadataValue(previous.metadata, "guild_id") !== guildId) {
        throw new Error(
          "Stored Stripe subscription guild metadata does not match",
        );
      }
      // A new purchase can replace a canceled subscription, but historical
      // duplicates must not resurrect themselves after the newer one ends.
      if (
        !isTerminalSubscription(previous) ||
        subscription.created <= previous.created
      )
        return;
    }
    const tier = isTerminalSubscription(subscription)
      ? "free"
      : resolveTierFromSubscription(subscription);
    const updatedBy =
      readMetadataValue(subscription.metadata, "discord_id") || undefined;
    const accepted = await repo.compareAndWrite(
      {
        ...buildSubscriptionPayload({
          guildId,
          status: subscription.status,
          tier,
          startDate: toIso(subscription.start_date),
          endDate: toIso(subscription.ended_at),
          nextBillingDate: toIso(resolveSubscriptionPeriodEnd(subscription)),
          paymentMethod: subscription.default_payment_method
            ? "card"
            : "unknown",
          stripeCustomerId:
            typeof subscription.customer === "string"
              ? subscription.customer
              : subscription.customer.id,
          stripeSubscriptionId: subscription.id,
          updatedBy,
          priceId: subscription.items.data[0]?.price.id,
          mode: subscription.livemode ? "live" : "test",
        }),
        stripeSyncRevision: randomUUID(),
      },
      existing,
    );
    if (!accepted) continue;
    clearGuildSubscriptionCache(guildId);
    await maybeAutoRevokeCoveredCompGrants({
      guildId,
      tier,
      status: subscription.status,
      stripeSubscriptionId: subscription.id,
      updatedBy,
    });
    return;
  }
  throw new Error("Stripe subscription changed concurrently; retry webhook");
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
  await reconcileSubscription(stripe, guildId, subscriptionId);
};

const handleInvoicePaymentFailed: WebhookHandler = async ({
  stripe,
  event,
}) => {
  const invoice = event.data.object as StripeInvoice;
  const guildId = await resolveGuildIdFromInvoice(stripe, invoice);
  const subscription = resolveInvoiceSubscription(invoice);
  if (!guildId || !subscription) return;
  await reconcileSubscription(
    stripe,
    guildId,
    typeof subscription === "string" ? subscription : subscription.id,
  );
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
  await reconcileSubscription(stripe, guildId, subscription.id);
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
      const claimed = await webhookRepo.tryCreate({
        eventId: event.id,
        receivedAt: new Date().toISOString(),
        expiresAt: Math.floor(Date.now() / 1000) + ttlSeconds,
      });
      if (!claimed) {
        res.json({ received: true });
        return;
      }

      try {
        const handler = handlersByEvent[event.type];
        if (handler) {
          await handler({ stripe, event });
        }
      } catch (handlerError) {
        await webhookRepo.delete(event.id);
        throw handlerError;
      }
      res.json({ received: true });
    } catch (err) {
      console.error("Stripe webhook handler error", err);
      res.status(500).send("Webhook handler failure");
    }
  });
}
