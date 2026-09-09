import { getSubscriptionRepository } from "../repositories/subscriptionRepository";
import { getPaymentTransactionRepository } from "../repositories/paymentTransactionRepository";
import { config } from "./configService";
import {
  clearGuildSubscriptionCache,
  getLimitsForTier,
  resolveGuildSubscription,
} from "./subscriptionService";
import { autoRevokeCoveredCompGrants } from "./entitlementService";
import { getRollingUsageForGuild } from "./meetingUsageService";
import { nowIso } from "../utils/time";
import type { BillingInterval, PaidTier } from "../types/pricing";
import type { GuildSubscription, PaymentTransaction } from "../types/db";
import type { StripeClient, StripeSubscription } from "../types/stripe";
import type { PublicEntitlementGrant } from "./entitlementService";

import { BillingActionError } from "./billingActionError";
export { BillingActionError } from "./billingActionError";
import { createInitialPurchase } from "./initialPurchaseService";
export type BillingSnapshot = {
  billingEnabled: boolean;
  stripeMode: string;
  tier: "free" | "basic" | "pro";
  status: string;
  billingSource: "free" | "stripe" | "manual_comp" | "forced";
  stripeTier: "free" | "basic" | "pro" | null;
  grantTier: "basic" | "pro" | null;
  activeGrant: PublicEntitlementGrant | null;
  nextBillingDate: string | null;
  subscriptionId: string | null;
  customerId: string | null;
  hasStripeBilling: boolean;
  canManageBillingPortal: boolean;
  upgradeUrl: string | null;
  portalUrl: string | null;
  usage: {
    usedMinutes: number;
    limitMinutes: number | null;
    windowStartIso: string;
    windowEndIso: string;
  } | null;
};

type StripeUser = {
  id: string;
  email?: string;
  username?: string;
};

export function buildBillingDisabledSnapshot(): BillingSnapshot {
  return {
    tier: "free",
    status: "free",
    billingSource: "free",
    stripeTier: null,
    grantTier: null,
    activeGrant: null,
    nextBillingDate: null,
    subscriptionId: null,
    customerId: null,
    hasStripeBilling: false,
    canManageBillingPortal: false,
    upgradeUrl: config.stripe.billingLandingUrl || null,
    portalUrl: null,
    billingEnabled: false,
    stripeMode: config.subscription.stripeMode || "disabled",
    usage: null,
  };
}

export async function getBillingSnapshot(params: {
  stripe: StripeClient | null;
  guildId: string;
}): Promise<BillingSnapshot> {
  const { stripe, guildId } = params;
  if (!stripe || !config.stripe.secretKey) {
    return buildBillingDisabledSnapshot();
  }

  const [subscription, resolvedSubscription] = await Promise.all([
    getSubscriptionRepository().get(guildId),
    resolveGuildSubscription(guildId),
  ]);

  const limits = getLimitsForTier(resolvedSubscription.tier);
  const usage = await getRollingUsageForGuild(guildId);
  const usedMinutes = Math.ceil(usage.usedSeconds / 60);
  const limitMinutes = limits.maxMeetingMinutesRolling ?? null;
  const hasStripeBilling = Boolean(
    subscription?.stripeSubscriptionId || subscription?.stripeCustomerId,
  );

  return {
    tier: resolvedSubscription.tier,
    status: resolvedSubscription.status,
    billingSource: resolvedSubscription.billingSource,
    stripeTier: resolvedSubscription.stripeTier,
    grantTier: resolvedSubscription.grantTier,
    activeGrant: resolvedSubscription.activeGrant,
    nextBillingDate:
      resolvedSubscription.billingSource === "stripe"
        ? subscription?.nextBillingDate || null
        : null,
    subscriptionId: subscription?.stripeSubscriptionId || null,
    customerId: subscription?.stripeCustomerId || null,
    hasStripeBilling,
    canManageBillingPortal: hasStripeBilling,
    upgradeUrl: config.stripe.billingLandingUrl || null,
    portalUrl: null,
    billingEnabled: true,
    stripeMode: config.subscription.stripeMode || "live",
    usage: {
      usedMinutes,
      limitMinutes,
      windowStartIso: usage.windowStartIso,
      windowEndIso: usage.windowEndIso,
    },
  };
}

export async function getMockBillingSnapshot(
  guildId: string,
): Promise<BillingSnapshot> {
  const [subscription, resolvedSubscription] = await Promise.all([
    getSubscriptionRepository().get(guildId),
    resolveGuildSubscription(guildId),
  ]);
  const limits = getLimitsForTier(resolvedSubscription.tier);
  const usage = await getRollingUsageForGuild(guildId);
  const usedMinutes = Math.ceil(usage.usedSeconds / 60);
  const limitMinutes = limits.maxMeetingMinutesRolling ?? null;
  const hasStripeBilling = Boolean(
    subscription?.stripeSubscriptionId || subscription?.stripeCustomerId,
  );

  return {
    tier: resolvedSubscription.tier,
    status: resolvedSubscription.status,
    billingSource: resolvedSubscription.billingSource,
    stripeTier: resolvedSubscription.stripeTier,
    grantTier: resolvedSubscription.grantTier,
    activeGrant: resolvedSubscription.activeGrant,
    nextBillingDate:
      resolvedSubscription.billingSource === "stripe"
        ? subscription?.nextBillingDate || null
        : null,
    subscriptionId: subscription?.stripeSubscriptionId || null,
    customerId: subscription?.stripeCustomerId || null,
    hasStripeBilling,
    canManageBillingPortal: hasStripeBilling,
    upgradeUrl: `/portal/server/${guildId}/billing?mock=checkout`,
    portalUrl: null,
    billingEnabled: true,
    stripeMode: "mock",
    usage: {
      usedMinutes,
      limitMinutes,
      windowStartIso: usage.windowStartIso,
      windowEndIso: usage.windowEndIso,
    },
  };
}

export async function seedMockSubscription(guildId: string) {
  const repo = getSubscriptionRepository();
  const existing = await repo.get(guildId);
  await repo.write({
    guildId,
    status: "active",
    tier: "basic",
    subscriptionType: "mock",
    startDate: existing?.startDate ?? nowIso(),
    nextBillingDate:
      existing?.nextBillingDate ??
      new Date(Date.now() + 1000 * 60 * 60 * 24 * 25).toISOString(),
    stripeCustomerId: existing?.stripeCustomerId ?? "cus_mock_basic",
    stripeSubscriptionId: existing?.stripeSubscriptionId ?? "sub_mock_basic",
    mode: "test",
  });
  clearGuildSubscriptionCache(guildId);
  await autoRevokeCoveredCompGrants({
    guildId,
    paidTier: "basic",
    stripeSubscriptionId: "sub_mock_basic",
  });
  clearGuildSubscriptionCache(guildId);
}

export async function saveGuildSubscription(subscription: GuildSubscription) {
  await getSubscriptionRepository().write(subscription);
  clearGuildSubscriptionCache(subscription.guildId);
}

export async function recordPaymentTransaction(
  transaction: PaymentTransaction,
) {
  await getPaymentTransactionRepository().write(transaction);
}

export async function ensureStripeCustomer(
  stripe: StripeClient,
  user: StripeUser,
): Promise<string> {
  const searchEmail = user.email;
  if (searchEmail) {
    let startingAfter: string | undefined;
    do {
      const found = await stripe.customers.list({
        email: searchEmail,
        limit: 100,
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      });
      const owned = found.data.find(
        (customer) => customer.metadata.discord_id === user.id,
      );
      if (owned) return owned.id;
      startingAfter = found.has_more ? found.data.at(-1)?.id : undefined;
    } while (startingAfter);
  }
  const created = await stripe.customers.create({
    ...(searchEmail ? { email: searchEmail } : {}),
    metadata: {
      discord_id: user.id,
      discord_username: user.username ?? "",
      // Lets PostHog revenue analytics join this Stripe customer to the
      // PostHog person. Must match the distinct id used by the portal and the
      // bot, which is the Discord user id.
      posthog_person_distinct_id: user.id,
    },
  });
  return created.id;
}

export async function resolvePromotionCodeId(
  stripe: Pick<StripeClient, "promotionCodes">,
  code: string,
): Promise<string | null> {
  const normalized = code.trim();
  if (!normalized) return null;
  const matches = await stripe.promotionCodes.list({
    code: normalized,
    active: true,
    limit: 1,
  });
  return matches.data[0]?.id ?? null;
}

function appendQueryParams(
  baseUrl: string,
  params: Record<string, string | undefined>,
): string {
  const entries = Object.entries(params).filter(([, value]) => value?.length);
  if (!entries.length) return baseUrl;
  try {
    const url = new URL(baseUrl);
    entries.forEach(([key, value]) => {
      if (value) url.searchParams.set(key, value);
    });
    return url.toString();
  } catch {
    const [path, query = ""] = baseUrl.split("?");
    const searchParams = new URLSearchParams(query);
    entries.forEach(([key, value]) => {
      if (value) searchParams.set(key, value);
    });
    const next = searchParams.toString();
    return next ? `${path}?${next}` : path;
  }
}

export async function createCheckoutSession(params: {
  stripe: StripeClient;
  user: StripeUser;
  guildId: string;
  priceId?: string | null;
  promotionCodeId?: string | null;
  promotionCode?: string | null;
  allowPromotionCodes?: boolean;
  tier?: PaidTier;
  interval?: BillingInterval;
}): Promise<string> {
  const {
    stripe,
    user,
    guildId,
    priceId,
    promotionCodeId,
    promotionCode,
    allowPromotionCodes,
    tier,
    interval,
  } = params;
  const checkoutPriceId = priceId || config.stripe.priceBasic;
  if (!checkoutPriceId?.startsWith("price_")) {
    throw new Error("Stripe price not configured");
  }
  const promoValue = promotionCode?.trim();
  const successUrl = appendQueryParams(config.stripe.successUrl, {
    promo: promoValue || undefined,
    serverId: guildId,
    plan: tier,
    interval,
  });
  const cancelUrl = appendQueryParams(config.stripe.cancelUrl, {
    promo: promoValue || undefined,
    serverId: guildId,
    plan: tier,
    interval,
  });
  const expected = await getSubscriptionRepository().get(guildId);
  const confirmationUrl = await createExistingSubscriptionConfirmation({
    stripe,
    user,
    guildId,
    checkoutPriceId,
    promotionCodeId,
    successUrl,
    cancelUrl,
  });
  if (confirmationUrl) return confirmationUrl;

  const metadata = {
    discord_id: user.id,
    discord_username: user.username ?? "",
    guild_id: guildId,
    ...(promoValue ? { promo_code: promoValue } : {}),
  };
  return createInitialPurchase({
    stripe,
    user,
    guildId,
    expected,
    mode: config.subscription.stripeMode === "live" ? "live" : "test",
    checkout: {
      mode: "subscription",
      line_items: [{ price: checkoutPriceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,

      client_reference_id: user.id,
      allow_promotion_codes: promotionCodeId
        ? undefined
        : (allowPromotionCodes ?? true),
      discounts: promotionCodeId
        ? [{ promotion_code: promotionCodeId }]
        : undefined,
      subscription_data: {
        metadata,
      },
      metadata,
    },
  });
}

function assertUpdatableSubscription(subscription: StripeSubscription): void {
  if (
    !["active", "trialing"].includes(subscription.status) ||
    subscription.items.data.length !== 1 ||
    subscription.schedule ||
    subscription.pending_update ||
    subscription.pause_collection ||
    subscription.cancel_at_period_end ||
    subscription.cancel_at
  ) {
    throw new BillingActionError(
      "BAD_REQUEST",
      "Resolve the existing subscription in billing management before changing plans",
    );
  }
}

async function createExistingSubscriptionConfirmation(params: {
  stripe: StripeClient;
  user: StripeUser;
  guildId: string;
  checkoutPriceId: string;
  promotionCodeId?: string | null;
  successUrl: string;
  cancelUrl: string;
}): Promise<string | null> {
  const {
    stripe,
    user,
    guildId,
    checkoutPriceId,
    promotionCodeId,
    successUrl,
    cancelUrl,
  } = params;
  const existing = await getSubscriptionRepository().get(guildId);
  if (existing?.stripeSubscriptionId) {
    if (!config.stripe.subscriptionTransitionsEnabled) {
      throw new BillingActionError(
        "BAD_REQUEST",
        "Plan changes are not available yet. Your current subscription is unchanged; contact support for help.",
      );
    }
    const subscription = await stripe.subscriptions.retrieve(
      existing.stripeSubscriptionId,
    );
    const customerId =
      typeof subscription.customer === "string"
        ? subscription.customer
        : subscription.customer.id;
    if (
      subscription.metadata.guild_id !== guildId ||
      (existing.stripeCustomerId && existing.stripeCustomerId !== customerId)
    ) {
      throw new BillingActionError(
        "BAD_REQUEST",
        "Server billing information does not match Stripe; contact support",
      );
    }
    // Only provider-confirmed terminal subscriptions can start a new purchase.
    // A failed read or unsupported state must never fall through to Checkout.
    if (
      subscription.status !== "canceled" &&
      subscription.status !== "incomplete_expired"
    ) {
      await assertStripePayer(stripe, customerId, user.id);
      assertUpdatableSubscription(subscription);
      const item = subscription.items.data[0];
      const portal = await stripe.billingPortal.sessions.create({
        customer: customerId,

        return_url: cancelUrl,
        flow_data: {
          type: "subscription_update_confirm",
          subscription_update_confirm: {
            subscription: subscription.id,
            items: [
              { id: item.id, price: checkoutPriceId, quantity: item.quantity },
            ],
            ...(promotionCodeId
              ? { discounts: [{ promotion_code: promotionCodeId }] }
              : {}),
          },
          after_completion: {
            type: "redirect",
            redirect: { return_url: successUrl },
          },
        },
      });
      if (!portal.url)
        throw new Error("Stripe did not return a confirmation URL");
      return portal.url;
    }
  } else if (existing?.stripeCustomerId) {
    throw new BillingActionError(
      "BAD_REQUEST",
      "Server subscription information is missing; contact support before purchasing again",
    );
  }
  return null;
}

async function assertStripePayer(
  stripe: StripeClient,
  customerId: string,
  userId: string,
): Promise<void> {
  const customer = await stripe.customers.retrieve(customerId);
  if (customer.deleted || customer.metadata.discord_id !== userId) {
    throw new BillingActionError(
      "FORBIDDEN",
      "Only the original payer can manage this server's Stripe billing",
    );
  }
}

export async function createPortalSession(params: {
  stripe: StripeClient;
  user: StripeUser;
  guildId: string;
}): Promise<string> {
  const { stripe, user, guildId } = params;
  const subscription = await getSubscriptionRepository().get(guildId);
  if (!subscription?.stripeCustomerId && !subscription?.stripeSubscriptionId) {
    throw new Error("No Stripe billing found for guild");
  }
  const customerId =
    subscription?.stripeCustomerId ||
    (typeof subscription?.stripeSubscriptionId === "string"
      ? (
          await stripe.subscriptions.retrieve(subscription.stripeSubscriptionId)
        ).customer?.toString()
      : undefined);
  if (!customerId) {
    throw new Error("No Stripe customer found for guild");
  }
  await assertStripePayer(stripe, customerId, user.id);
  const portal = await stripe.billingPortal.sessions.create({
    customer: customerId,

    return_url: config.stripe.portalReturnUrl || config.stripe.successUrl,
  });
  if (!portal.url) {
    throw new Error("Stripe did not return a portal URL");
  }
  return portal.url;
}
