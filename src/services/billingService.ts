import {
  runBillingOperation,
  type RuntimeBillingOwner,
} from "./runtimeBillingOperationService";
import { getRenewalRecoveryView } from "./renewalRecoveryView";
import type { RenewalRecoveryView } from "../types/renewalRecovery";
import { assertStripePayer } from "./billingPayerService";
import { resolveSubscriptionCancellationAt } from "../utils/stripeCancellation";
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
import type {
  BillingInterval,
  PaidTier,
  ExpectedIntroOffer,
  IntroOfferChoice,
  BasicIntroOffer,
  ProviderSubscriptionDetails,
} from "../types/pricing";
import type { GuildSubscription, PaymentTransaction } from "../types/db";
import type { StripeClient, StripeSubscription } from "../types/stripe";
import type { PublicEntitlementGrant } from "./entitlementService";
import {
  resolvePurchaseSource,
  resolveRecordingLimitContext,
  type RecordingLimitContext,
  type PurchaseSource,
} from "../utils/purchaseAnalytics";

import { BillingActionError } from "./billingActionError";
export { BillingActionError } from "./billingActionError";
import {
  createInitialPurchase,
  recoverAcceptedPurchase,
} from "./initialPurchaseService";
import {
  getGuildBasicIntroOffer,
  getProviderSubscriptionDetails,
  SUBSCRIPTION_DISCOUNT_EXPANSIONS,
  verifyBasicIntroPortalConfiguration,
} from "./basicIntroOfferService";
export type BillingSnapshot = {
  renewalRecovery: RenewalRecoveryView;
  introOffer?: BasicIntroOffer;
  annualIntroOffer?: BasicIntroOffer;
  subscriptionDetails?: ProviderSubscriptionDetails | null;
  billingEnabled: boolean;
  stripeMode: string;
  tier: "free" | "basic" | "pro";
  status: string;
  stripeStatus: string | null;
  billingSource: "free" | "stripe" | "manual_comp" | "forced";
  stripeTier: "free" | "basic" | "pro" | null;
  grantTier: "basic" | "pro" | null;
  activeGrant: PublicEntitlementGrant | null;
  nextBillingDate: string | null;
  cancellationAt: string | null;
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
    renewalRecovery: { status: "none" },
    introOffer: { status: "inactive" },
    annualIntroOffer: { status: "inactive" },
    subscriptionDetails: null,
    tier: "free",
    status: "free",
    stripeStatus: null,
    billingSource: "free",
    stripeTier: null,
    grantTier: null,
    activeGrant: null,
    nextBillingDate: null,
    cancellationAt: null,
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
  payerId?: string;
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

  const [introOffer, annualIntroOffer, providerState, renewalRecovery] =
    await Promise.all([
      getGuildBasicIntroOffer({ stripe, guildId, payerId: params.payerId }),
      getGuildBasicIntroOffer({
        stripe,
        guildId,
        payerId: params.payerId,
        interval: "year",
      }),
      loadProviderBillingState(stripe, guildId, subscription),
      getRenewalRecoveryView({
        stripe,
        guildId,
        payerId: params.payerId,
        now: Math.floor(Date.now() / 1000),
      }),
    ]);
  return {
    renewalRecovery,
    introOffer,
    annualIntroOffer,
    subscriptionDetails: providerState.details,
    cancellationAt:
      resolvedSubscription.billingSource === "stripe"
        ? providerState.cancellationAt
        : null,
    tier: resolvedSubscription.tier,
    status: resolvedSubscription.status,
    stripeStatus: subscription?.stripeSubscriptionId
      ? subscription.status
      : null,
    billingSource: resolvedSubscription.billingSource,
    stripeTier: resolvedSubscription.stripeTier,
    grantTier: resolvedSubscription.grantTier,
    activeGrant: resolvedSubscription.activeGrant,
    nextBillingDate:
      resolvedSubscription.billingSource === "stripe" &&
      !providerState.cancellationAt
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
    renewalRecovery: { status: "none" },
    introOffer: { status: "inactive" },
    annualIntroOffer: { status: "inactive" },
    subscriptionDetails: null,
    cancellationAt:
      resolvedSubscription.billingSource === "stripe"
        ? (subscription?.cancellationAt ?? null)
        : null,
    tier: resolvedSubscription.tier,
    status: resolvedSubscription.status,
    stripeStatus: subscription?.stripeSubscriptionId
      ? subscription.status
      : null,
    billingSource: resolvedSubscription.billingSource,
    stripeTier: resolvedSubscription.stripeTier,
    grantTier: resolvedSubscription.grantTier,
    activeGrant: resolvedSubscription.activeGrant,
    nextBillingDate:
      resolvedSubscription.billingSource === "stripe" &&
      !subscription?.cancellationAt
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

type CheckoutSessionInput = {
  stripe: StripeClient;
  user: StripeUser;
  guildId: string;
  priceId?: string | null;
  promotionCodeId?: string | null;
  promotionCode?: string | null;
  savedPromotionCode?: string;
  allowPromotionCodes?: boolean;
  tier?: PaidTier;
  interval?: BillingInterval;
  source?: PurchaseSource;
  limitType?: RecordingLimitContext["limitType"];
  limitSurface?: RecordingLimitContext["limitSurface"];
  analyticsAllowed?: boolean;
  expectedOffer?: ExpectedIntroOffer;
  offerChoice?: IntroOfferChoice;
};

async function checkoutPromotion(params: CheckoutSessionInput) {
  const {
    stripe,
    promotionCode,
    promotionCodeId: suppliedPromotionCodeId,
  } = params;
  const promoValue = promotionCode?.trim();
  const savedPromo = params.savedPromotionCode?.trim();
  if (savedPromo && promoValue && savedPromo !== promoValue)
    throw new BillingActionError(
      "BAD_REQUEST",
      "Saved and selected promotion codes do not match.",
    );
  const promotionCodeId =
    suppliedPromotionCodeId ||
    (promoValue ? await resolvePromotionCodeId(stripe, promoValue) : null);
  if (promoValue && !promotionCodeId) {
    throw new BillingActionError("BAD_REQUEST", "Invalid promotion code");
  }
  return { promoValue, savedPromo, promotionCodeId };
}

function checkoutMetadata(
  user: StripeUser,
  guildId: string,
  source: PurchaseSource,
  limitContext: RecordingLimitContext | undefined,
  analyticsAllowed: boolean,
  tier: PaidTier | undefined,
  interval: BillingInterval | undefined,
  promoValue: string | undefined,
  savedPromo: string | undefined,
) {
  const metadata = {
    discord_id: user.id,
    discord_username: user.username ?? "",
    guild_id: guildId,
    purchase_source: source,
    ...(limitContext
      ? {
          recording_limit_type: limitContext.limitType,
          recording_limit_surface: limitContext.limitSurface,
        }
      : {}),
    ...(analyticsAllowed ? {} : { analytics_opt_out: "true" }),
    ...(tier ? { purchase_tier: tier } : {}),
    ...(interval ? { purchase_interval: interval } : {}),
    ...(promoValue ? { promo_code: promoValue } : {}),
    ...(savedPromo ? { purchase_promo_present: "true" } : {}),
  };
  return metadata;
}

function checkoutReturnUrls(
  params: CheckoutSessionInput,
  source: PurchaseSource,
  limitContext: RecordingLimitContext | undefined,
  savedPromo: string | undefined,
  promoValue: string | undefined,
) {
  const { guildId, tier, interval } = params;
  const successUrl = appendQueryParams(config.stripe.successUrl, {
    promo: savedPromo || promoValue || undefined,
    offerChoice: params.offerChoice ?? "automatic",
    serverId: guildId,
    plan: tier,
    interval,
    source,
    ...limitContext,
  });
  const cancelUrl = appendQueryParams(config.stripe.cancelUrl, {
    promo: savedPromo || promoValue || undefined,
    offerChoice: params.offerChoice ?? "automatic",
    serverId: guildId,
    plan: tier,
    interval,
    source,
    ...limitContext,
  });
  return { successUrl, cancelUrl };
}

async function createCheckoutSessionOwned(
  params: CheckoutSessionInput & { owner: RuntimeBillingOwner },
): Promise<string> {
  const {
    stripe,
    user,
    guildId,
    priceId,
    allowPromotionCodes,
    tier,
    interval,
    source: sourceInput,
    analyticsAllowed = true,
  } = params;
  const source = resolvePurchaseSource(sourceInput);
  const limitContext = resolveRecordingLimitContext(params);
  const checkoutPriceId = priceId || config.stripe.priceBasic;
  if (!checkoutPriceId?.startsWith("price_")) {
    throw new Error("Stripe price not configured");
  }
  const { promoValue, savedPromo, promotionCodeId } =
    await checkoutPromotion(params);
  const { successUrl, cancelUrl } = checkoutReturnUrls(
    params,
    source,
    limitContext,
    savedPromo,
    promoValue,
  );
  const expected = await getSubscriptionRepository().get(guildId);
  const confirmationUrl = await createExistingSubscriptionConfirmation({
    stripe,
    user,
    guildId,
    checkoutPriceId,
    promotionCodeId,
    cancelUrl,
    targetTier: params.tier,
    targetInterval: params.interval,
  });
  if (confirmationUrl) return confirmationUrl;

  const metadata = checkoutMetadata(
    user,
    guildId,
    source,
    limitContext,
    analyticsAllowed,
    tier,
    interval,
    promoValue,
    savedPromo,
  );
  return createInitialPurchase({
    owner: params.owner,
    stripe,
    user,
    guildId,
    expected,
    expectedOffer: params.expectedOffer,
    offerChoice: params.offerChoice ?? "automatic",
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

async function createExistingSubscriptionConfirmation(params: {
  stripe: StripeClient;
  user: StripeUser;
  guildId: string;
  checkoutPriceId: string;
  cancelUrl: string;
  promotionCodeId?: string | null;
  targetTier?: PaidTier;
  targetInterval?: BillingInterval;
}): Promise<string | null> {
  const { stripe, user, guildId } = params;
  const existing = await getSubscriptionRepository().get(guildId);
  if (existing?.stripeSubscriptionId) {
    const subscription = await stripe.subscriptions.retrieve(
      existing.stripeSubscriptionId,
      { expand: SUBSCRIPTION_DISCOUNT_EXPANSIONS },
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
    const recovered = await recoverAcceptedPurchase({
      stripe,
      guildId,
      payerId: user.id,
      subscription,
    });
    if (recovered) return recovered;
    // Only provider-confirmed terminal subscriptions can start a new purchase.
    // A failed read or unsupported state must never fall through to Checkout.
    if (
      subscription.status !== "canceled" &&
      subscription.status !== "incomplete_expired"
    ) {
      if (!config.stripe.subscriptionTransitionsEnabled) {
        throw new BillingActionError(
          "BAD_REQUEST",
          "Plan changes are not available yet. Your current subscription is unchanged; contact support for help.",
        );
      }
      await assertStripePayer({ stripe, customerId, payerId: user.id });
      if (!params.targetTier || !params.targetInterval)
        throw new BillingActionError(
          "BAD_REQUEST",
          "Choose a plan and billing interval before continuing.",
        );
      if (params.promotionCodeId)
        throw new BillingActionError(
          "BAD_REQUEST",
          "Review plan changes at the listed price. Promotion codes cannot be carried into this change.",
        );
      const review = new URL(
        `/portal/server/${encodeURIComponent(guildId)}/billing`,
        config.frontend.siteUrl,
      );
      review.search = new URL(params.cancelUrl).search;
      review.searchParams.set("plan", params.targetTier);
      review.searchParams.set("interval", params.targetInterval);
      return review.toString();
    }
  } else if (existing?.stripeCustomerId) {
    throw new BillingActionError(
      "BAD_REQUEST",
      "Server subscription information is missing; contact support before purchasing again",
    );
  }
  return null;
}

function providerCustomerId(subscription: StripeSubscription): string {
  return typeof subscription.customer === "string"
    ? subscription.customer
    : subscription.customer.id;
}

async function managedPortalConfiguration(
  stripe: StripeClient,
  providerSubscription: StripeSubscription | null,
) {
  const managedConfiguration =
    config.stripe.basicIntroOffer.portalConfigurationId ||
    providerSubscription?.metadata.intro_offer_portal_configuration_id;
  if (config.stripe.subscriptionTransitionsEnabled && !managedConfiguration)
    throw new BillingActionError(
      "BAD_REQUEST",
      "Billing management is temporarily unavailable. Please try again later.",
    );
  return managedConfiguration &&
    (config.stripe.subscriptionTransitionsEnabled ||
      config.stripe.introOfferLedgerEnabled)
    ? await verifyBasicIntroPortalConfiguration(stripe, managedConfiguration)
    : undefined;
}

async function createPortalSessionOwned(params: {
  owner: RuntimeBillingOwner;
  stripe: StripeClient;
  user: StripeUser;
  guildId: string;
}): Promise<string> {
  const { stripe, user, guildId } = params;
  const subscription = await getSubscriptionRepository().get(guildId);
  if (!subscription?.stripeCustomerId && !subscription?.stripeSubscriptionId) {
    throw new Error("No Stripe billing found for guild");
  }
  const providerSubscription = subscription.stripeSubscriptionId
    ? await stripe.subscriptions.retrieve(subscription.stripeSubscriptionId, {
        expand: SUBSCRIPTION_DISCOUNT_EXPANSIONS,
      })
    : null;
  const customerId =
    subscription.stripeCustomerId ||
    (providerSubscription
      ? providerCustomerId(providerSubscription)
      : undefined);
  if (!customerId) throw new Error("No Stripe customer found for guild");
  await assertStripePayer({ stripe, customerId, payerId: user.id });
  if (
    providerSubscription &&
    (providerSubscription.metadata.guild_id !== guildId ||
      providerCustomerId(providerSubscription) !== customerId)
  ) {
    throw new BillingActionError(
      "BAD_REQUEST",
      "Server billing information does not match Stripe; contact support",
    );
  }
  const configuration = await managedPortalConfiguration(
    stripe,
    providerSubscription,
  );
  const portal = await params.owner.effect(() =>
    stripe.billingPortal.sessions.create({
      customer: customerId,
      ...(configuration ? { configuration } : {}),

      return_url: new URL(
        `/portal/server/${encodeURIComponent(guildId)}/billing`,
        config.frontend.siteUrl,
      ).toString(),
    }),
  );
  if (!portal.url) {
    throw new Error("Stripe did not return a portal URL");
  }
  return portal.url;
}

type ProviderBillingState = {
  details: ProviderSubscriptionDetails | null;
  cancellationAt: string | null;
};

async function loadProviderBillingState(
  stripe: StripeClient,
  guildId: string,
  subscription: GuildSubscription | undefined,
): Promise<ProviderBillingState> {
  if (!subscription?.stripeSubscriptionId)
    return { details: null, cancellationAt: null };
  let cancellationAt = subscription.cancellationAt ?? null;
  try {
    const provider = await stripe.subscriptions.retrieve(
      subscription.stripeSubscriptionId,
      { expand: SUBSCRIPTION_DISCOUNT_EXPANSIONS },
    );
    const customerId =
      typeof provider.customer === "string"
        ? provider.customer
        : provider.customer.id;
    if (
      provider.metadata.guild_id !== guildId ||
      provider.livemode !== (config.subscription.stripeMode === "live") ||
      (subscription.stripeCustomerId &&
        subscription.stripeCustomerId !== customerId)
    )
      return { details: { status: "unavailable" }, cancellationAt: null };
    const canceledAt = resolveSubscriptionCancellationAt(provider);
    cancellationAt =
      canceledAt === null ? null : new Date(canceledAt * 1000).toISOString();
    const details = await getProviderSubscriptionDetails(stripe, provider);
    return {
      cancellationAt,
      details:
        details.status === "available"
          ? {
              ...details,
              planChangesRestricted: false,
              planChangeRestrictionEndsAt: null,
            }
          : details,
    };
  } catch {
    return { details: { status: "unavailable" }, cancellationAt };
  }
}

export function createCheckoutSession(
  params: CheckoutSessionInput & { owner?: RuntimeBillingOwner },
): Promise<string> {
  return runBillingOperation(params.owner, (owner) =>
    createCheckoutSessionOwned({ ...params, owner }),
  );
}
export function createPortalSession(params: {
  stripe: StripeClient;
  user: StripeUser;
  guildId: string;
  owner?: RuntimeBillingOwner;
}): Promise<string> {
  return runBillingOperation(params.owner, (owner) =>
    createPortalSessionOwned({ ...params, owner }),
  );
}
