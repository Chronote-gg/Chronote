import { getSubscriptionRepository } from "../repositories/subscriptionRepository";
import {
  getBestActiveEntitlementGrantForGuild,
  highestTier,
  toPublicEntitlementGrant,
  type BillingSource,
  type PublicEntitlementGrant,
} from "./entitlementService";
import {
  getCachedGuildSubscription,
  setCachedGuildSubscription,
} from "./subscriptionCache";
import { config } from "./configService";
import type { GuildSubscription } from "../types/db";

export { clearGuildSubscriptionCache } from "./subscriptionCache";

export type Tier = "free" | "basic" | "pro";

export interface TierLimits {
  maxMeetingDurationMs?: number;
  maxMeetingDurationPretty?: string;
  maxMeetingMinutesRolling?: number;
  maxAskMeetings?: number;
  maxChatTtsMessagesMonthly?: number;
  liveVoiceEnabled: boolean;
  imagesEnabled: boolean;
}

export interface ResolvedSubscription {
  tier: Tier;
  status: string; // raw Stripe status or "free"
  source: "stripe" | "forced" | "default" | "manual_comp";
  billingSource: BillingSource;
  stripeTier: Tier | null;
  grantTier: "basic" | "pro" | null;
  activeGrant: PublicEntitlementGrant | null;
}

const chatTtsLimits = {
  free: config.chatTts?.monthlyMessageLimitFree ?? 0,
  basic: config.chatTts?.monthlyMessageLimitBasic ?? 1000,
  pro: config.chatTts?.monthlyMessageLimitPro,
};

const DEFAULT_LIMITS: Record<Tier, TierLimits> = {
  free: {
    maxMeetingDurationMs: 90 * 60 * 1000, // 90 minutes
    maxMeetingDurationPretty: "90 minutes",
    maxMeetingMinutesRolling: 4 * 60,
    maxAskMeetings: 5,
    maxChatTtsMessagesMonthly: chatTtsLimits.free,
    liveVoiceEnabled: false,
    imagesEnabled: false,
  },
  basic: {
    maxMeetingDurationMs: 7_200_000,
    maxMeetingDurationPretty: "2 hours",
    maxMeetingMinutesRolling: 20 * 60,
    maxAskMeetings: 25,
    maxChatTtsMessagesMonthly: chatTtsLimits.basic,
    liveVoiceEnabled: true,
    imagesEnabled: true,
  },
  pro: {
    maxMeetingDurationMs: 7_200_000,
    maxMeetingDurationPretty: "2 hours",
    maxMeetingMinutesRolling: undefined,
    maxAskMeetings: 100,
    maxChatTtsMessagesMonthly: chatTtsLimits.pro,
    liveVoiceEnabled: true,
    imagesEnabled: true,
  },
};

const CACHE_TTL_MS = 5 * 60 * 1000;

export function getLimitsForTier(tier: Tier): TierLimits {
  return DEFAULT_LIMITS[tier];
}

const paidStatuses = new Set(["active", "trialing", "past_due"]);

function resolveStripeTier(
  subscription: GuildSubscription | undefined,
): Tier | null {
  const status = subscription?.status || "free";
  const storedTier =
    subscription?.tier === "basic" || subscription?.tier === "pro"
      ? subscription.tier
      : null;
  if (!paidStatuses.has(status)) return null;
  return storedTier ?? "basic";
}

function resolveCacheExpiresAt(activeGrantExpiresAt?: string) {
  const defaultExpiresAt = Date.now() + CACHE_TTL_MS;
  if (!activeGrantExpiresAt) return defaultExpiresAt;
  const grantExpiresAt = Date.parse(activeGrantExpiresAt);
  if (!Number.isFinite(grantExpiresAt)) return defaultExpiresAt;
  return Math.min(defaultExpiresAt, grantExpiresAt);
}

function resolveForcedSubscription(): ResolvedSubscription | null {
  const forced = config.subscription.forceTier;
  if (forced !== "free" && forced !== "basic" && forced !== "pro") {
    return null;
  }
  return {
    tier: forced,
    status: forced,
    source: "forced",
    billingSource: "forced",
    stripeTier: null,
    grantTier: null,
    activeGrant: null,
  };
}

function resolveBillingSource(params: {
  effectiveTier: Tier;
  stripeTier: Tier | null;
  grantTier: "basic" | "pro" | null;
}): BillingSource {
  const { effectiveTier, stripeTier, grantTier } = params;
  if (!grantTier) return stripeTier ? "stripe" : "free";
  if (effectiveTier === grantTier && grantTier !== stripeTier) {
    return "manual_comp";
  }
  return stripeTier ? "stripe" : "manual_comp";
}

function buildResolvedSubscription(params: {
  status: string;
  stripeTier: Tier | null;
  grantTier: "basic" | "pro" | null;
  activeGrant: PublicEntitlementGrant | null;
}): ResolvedSubscription {
  const effectiveTier = highestTier(
    params.stripeTier ?? "free",
    params.grantTier ?? "free",
  );
  const billingSource = resolveBillingSource({
    effectiveTier,
    stripeTier: params.stripeTier,
    grantTier: params.grantTier,
  });
  return {
    tier: effectiveTier,
    status: billingSource === "manual_comp" ? "comped" : params.status,
    source: billingSource === "free" ? "default" : billingSource,
    billingSource,
    stripeTier: params.stripeTier,
    grantTier: params.grantTier,
    activeGrant: params.activeGrant,
  };
}

export async function resolveGuildSubscription(
  guildId: string,
): Promise<ResolvedSubscription> {
  const forced = resolveForcedSubscription();
  if (forced) return forced;

  const cached = getCachedGuildSubscription<ResolvedSubscription>(guildId);
  if (cached) return cached;

  const stripeEnabled =
    Boolean(config.stripe.secretKey) &&
    config.subscription.stripeMode !== "disabled";
  const [subscription, activeGrant] = await Promise.all([
    stripeEnabled
      ? getSubscriptionRepository().get(guildId)
      : Promise.resolve(undefined),
    getBestActiveEntitlementGrantForGuild(guildId),
  ]);
  const status = subscription?.status || "free";
  const stripeTier = resolveStripeTier(subscription);
  const grantTier = activeGrant?.tier ?? null;
  const publicGrant = toPublicEntitlementGrant(activeGrant);
  const sub = buildResolvedSubscription({
    status,
    stripeTier,
    grantTier,
    activeGrant: publicGrant,
  });
  setCachedGuildSubscription(
    guildId,
    sub,
    resolveCacheExpiresAt(activeGrant?.expiresAt),
  );
  return sub;
}

export async function getGuildLimits(guildId: string | null): Promise<{
  subscription: ResolvedSubscription;
  limits: TierLimits;
}> {
  if (!guildId) {
    return {
      subscription: {
        tier: "free",
        status: "free",
        source: "default",
        billingSource: "free",
        stripeTier: null,
        grantTier: null,
        activeGrant: null,
      },
      limits: DEFAULT_LIMITS.free,
    };
  }
  const subscription = await resolveGuildSubscription(guildId);
  const limits = getLimitsForTier(subscription.tier);
  return { subscription, limits };
}
