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
import type { StripeClient } from "../types/stripe";
import type { PublicEntitlementGrant } from "./entitlementService";

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
    const found = await stripe.customers.list({
      email: searchEmail,
      limit: 1,
    });
    if (found.data.length) return found.data[0].id;
  }
  const created = await stripe.customers.create({
    ...(searchEmail ? { email: searchEmail } : {}),
    metadata: {
      discord_id: user.id,
      discord_username: user.username ?? "",
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
  const customerId = await ensureStripeCustomer(stripe, user);
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
  const metadata = {
    discord_id: user.id,
    discord_username: user.username ?? "",
    guild_id: guildId,
    ...(promoValue ? { promo_code: promoValue } : {}),
  };
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: checkoutPriceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    customer: customerId,
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
  });
  if (!session.url) {
    throw new Error("Stripe did not return a checkout URL");
  }
  return session.url;
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
  let customerId =
    subscription?.stripeCustomerId ||
    (typeof subscription?.stripeSubscriptionId === "string"
      ? (
          await stripe.subscriptions.retrieve(subscription.stripeSubscriptionId)
        ).customer?.toString()
      : undefined);
  if (!customerId) {
    customerId = await ensureStripeCustomer(stripe, user);
  }
  if (!customerId) {
    throw new Error("No Stripe customer found for guild");
  }
  const portal = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: config.stripe.portalReturnUrl || config.stripe.successUrl,
  });
  if (!portal.url) {
    throw new Error("Stripe did not return a portal URL");
  }
  return portal.url;
}
