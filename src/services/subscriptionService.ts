import { getSubscriptionRepository } from "../repositories/subscriptionRepository";
import { config } from "./configService";

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
  source: "stripe" | "forced" | "default";
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

type CacheEntry = { sub: ResolvedSubscription; expiresAt: number };
const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000;

function isCacheValid(entry?: CacheEntry) {
  return !!entry && entry.expiresAt > Date.now();
}

export function getLimitsForTier(tier: Tier): TierLimits {
  return DEFAULT_LIMITS[tier];
}

export async function resolveGuildSubscription(
  guildId: string,
): Promise<ResolvedSubscription> {
  const forced = config.subscription.forceTier;
  if (forced === "free" || forced === "basic" || forced === "pro") {
    return { tier: forced, status: forced, source: "forced" };
  }

  const cached = cache.get(guildId);
  if (isCacheValid(cached)) return cached!.sub;

  // If Stripe is disabled, everyone is free
  if (
    !config.stripe.secretKey ||
    config.subscription.stripeMode === "disabled"
  ) {
    const sub: ResolvedSubscription = {
      tier: "free",
      status: "free",
      source: "default",
    };
    cache.set(guildId, { sub, expiresAt: Date.now() + CACHE_TTL_MS });
    return sub;
  }

  const subscription = await getSubscriptionRepository().get(guildId);
  const status = subscription?.status || "free";
  const paidStatuses = new Set(["active", "trialing", "past_due"]);
  const storedTier =
    subscription?.tier === "basic" || subscription?.tier === "pro"
      ? subscription.tier
      : null;
  const tier: Tier =
    storedTier ?? (paidStatuses.has(status) ? "basic" : "free");

  const sub: ResolvedSubscription = {
    tier,
    status,
    source: "stripe",
  };
  cache.set(guildId, { sub, expiresAt: Date.now() + CACHE_TTL_MS });
  return sub;
}

export async function getGuildLimits(guildId: string | null): Promise<{
  subscription: ResolvedSubscription;
  limits: TierLimits;
}> {
  if (!guildId) {
    return {
      subscription: { tier: "free", status: "free", source: "default" },
      limits: DEFAULT_LIMITS.free,
    };
  }
  const subscription = await resolveGuildSubscription(guildId);
  const limits = getLimitsForTier(subscription.tier);
  return { subscription, limits };
}
