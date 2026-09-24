import { randomUUID } from "node:crypto";
import type { GuildSubscription } from "../types/db";
import type {
  StripeClient,
  StripePrice,
  StripeSubscription,
} from "../types/stripe";
import { getSubscriptionRepository } from "../repositories/subscriptionRepository";
import { autoRevokeCoveredCompGrants } from "./entitlementService";
import { resolveTierFromPrice } from "./pricingService";
import { clearGuildSubscriptionCache } from "./subscriptionService";
import {
  recordDuplicatePurchase,
  validatePurchaseSubscription,
  acceptPurchaseSubscription,
} from "./purchaseReconciliation";
type KnownTier = "free" | "basic" | "pro";
const readMetadataValue = (
  metadata: Record<string, string> | null | undefined,
  key: string,
) => metadata?.[key] ?? "";
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
export const reconcileSubscription = async (
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
      if (
        await rejectCompetingSubscription(
          stripe,
          guildId,
          existing.stripeSubscriptionId,
          subscription,
        )
      )
        return;
    }
    await validatePurchaseSubscription(guildId, subscription);
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
    await acceptPurchaseSubscription(guildId, subscription);
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

async function rejectCompetingSubscription(
  stripe: StripeClient,
  guildId: string,
  previousId: string,
  subscription: StripeSubscription,
) {
  // Old terminal events cannot adopt a guild that now points elsewhere.
  if (isTerminalSubscription(subscription)) return true;
  const previous = await stripe.subscriptions.retrieve(previousId);
  if (readMetadataValue(previous.metadata, "guild_id") !== guildId) {
    throw new Error("Stored Stripe subscription guild metadata does not match");
  }
  // A new purchase can replace a canceled subscription, but historical
  // duplicates must not resurrect themselves after the newer one ends.
  if (
    !isTerminalSubscription(previous) ||
    subscription.created <= previous.created
  ) {
    if (!isTerminalSubscription(previous))
      await recordDuplicatePurchase(guildId, previous, subscription);
    return true;
  }

  return false;
}
