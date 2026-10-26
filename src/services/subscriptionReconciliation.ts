import {
  runBillingOperation,
  type RuntimeBillingOwner,
} from "./runtimeBillingOperationService";
import { getBillingChangeRepository } from "../repositories/billingChangeRepository";
import {
  refreshRenewalRecovery,
  trackPaidRenewalPeriod,
  completeRenewalPaidProjection,
} from "./renewalRecoveryService";
import { stripeId } from "./billingChangeProvider";
import {
  buildBillingLifecycleState,
  publishBillingLifecycleTransition,
} from "./billingLifecycleAnalytics";
import { resolveSubscriptionCancellationAt } from "../utils/stripeCancellation";
import type { SettlementInvoice } from "./offerUsageSettlement";
import { randomUUID } from "node:crypto";
import type { RenewalRecovery } from "../types/renewalRecovery";
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
  cancellationAt?: string;
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
  cancellationAt: params.cancellationAt,
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
  owner: RuntimeBillingOwner;
  guildId: string;
  tier: KnownTier;
  status: string;
  stripeSubscriptionId?: string;
  updatedBy?: string;
}) => {
  if (params.tier !== "basic" && params.tier !== "pro") return;
  if (params.status !== "active" && params.status !== "trialing") return;
  await autoRevokeCoveredCompGrants({
    owner: params.owner,
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

function blocksCanceledRenewalProjection(
  recovery: RenewalRecovery | undefined,
  subscription: StripeSubscription,
): boolean {
  return (
    recovery?.subscriptionId === subscription.id &&
    subscription.status === "active" &&
    ["canceling", "canceled"].includes(recovery.state)
  );
}
async function hasUnsettledPlanChange(
  guildId: string,
  subscription: StripeSubscription,
) {
  const control = await getBillingChangeRepository().getControl(guildId);
  if (!control) return false;
  const operation = await getBillingChangeRepository().getOperation(
    guildId,
    control.operationId,
  );
  return Boolean(
    operation &&
    !["succeeded", "canceled"].includes(operation.state) &&
    subscription.metadata.chronote_change_operation === operation.operationId,
  );
}

function subscriptionProjection(
  guildId: string,
  subscription: StripeSubscription,
  existing: GuildSubscription | undefined,
) {
  const tier = isTerminalSubscription(subscription)
    ? "free"
    : resolveTierFromSubscription(subscription);
  const updatedBy =
    readMetadataValue(subscription.metadata, "discord_id") || undefined;
  const payload: GuildSubscription = {
    ...buildSubscriptionPayload({
      guildId,
      status: subscription.status,
      tier,
      startDate: toIso(subscription.start_date),
      endDate: toIso(subscription.ended_at),
      nextBillingDate: toIso(resolveSubscriptionPeriodEnd(subscription)),
      cancellationAt: toIso(resolveSubscriptionCancellationAt(subscription)),
      paymentMethod: subscription.default_payment_method ? "card" : "unknown",
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
    billingAnalyticsState: ["incomplete", "trialing"].includes(
      subscription.status,
    )
      ? existing?.billingAnalyticsState
      : buildBillingLifecycleState(subscription),
  };
  return { payload, tier, updatedBy };
}

async function completePaidSubscription(
  stripe: StripeClient,
  guildId: string,
  subscription: StripeSubscription,
  payload: GuildSubscription,
  settlement: SettlementInvoice | undefined,
  owner: RuntimeBillingOwner,
) {
  if (subscription.status === "active") {
    await completeRenewalPaidProjection(
      guildId,
      subscription,
      payload,
      stripe,
      owner,
    );
    const invoiceId =
      settlement?.invoiceId ?? stripeId(subscription.latest_invoice);
    if (!invoiceId)
      throw new Error("Paid renewal coverage requires its provider invoice");
    await trackPaidRenewalPeriod({
      stripe,
      guildId,
      subscriptionId: subscription.id,
      invoiceId,
      now: Math.floor(Date.now() / 1000),
      owner,
    });
  }
}

// Read the row before fetching Stripe. If another webhook commits during the
// fetch, retry both reads so an older response cannot undo its newer state.
const reconcileSubscriptionOwned = async (
  stripe: StripeClient,
  guildId: string,
  subscriptionId: string,
  settlement: SettlementInvoice | undefined,
  analyticsContext: { userId: string; analyticsOptOut: boolean } | undefined,
  owner: RuntimeBillingOwner,
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
          owner,
        )
      )
        return;
    }
    const recovery = await refreshRenewalRecovery({
      stripe,
      guildId,
      now: Math.floor(Date.now() / 1000),
      owner,
    });
    if (blocksCanceledRenewalProjection(recovery, subscription)) return;
    if (await hasUnsettledPlanChange(guildId, subscription)) return;
    await validatePurchaseSubscription(guildId, subscription);
    const { payload, tier, updatedBy } = subscriptionProjection(
      guildId,
      subscription,
      existing,
    );
    const accepted = await owner.effect(() =>
      repo.compareAndWrite(payload, existing),
    );
    if (!accepted) continue;
    await publishBillingLifecycleTransition({
      previous: existing,
      current: payload,
      provider: subscription,
      observedAt: new Date(),
      ...analyticsContext,
    });
    clearGuildSubscriptionCache(guildId);
    await completePaidSubscription(
      stripe,
      guildId,
      subscription,
      payload,
      settlement,
      owner,
    );
    await acceptPurchaseSubscription(
      guildId,
      subscription,
      stripe,
      settlement,
      owner,
    );
    await maybeAutoRevokeCoveredCompGrants({
      owner,
      guildId,
      tier,
      status: subscription.status,
      stripeSubscriptionId: subscription.id,
      updatedBy,
    });
    return { subscription, tier };
  }
  throw new Error("Stripe subscription changed concurrently; retry webhook");
};

async function rejectCompetingSubscription(
  stripe: StripeClient,
  guildId: string,
  previousId: string,
  subscription: StripeSubscription,
  owner: RuntimeBillingOwner,
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
      await recordDuplicatePurchase(guildId, previous, subscription, owner);
    return true;
  }

  return false;
}

export function reconcileSubscription(
  stripe: StripeClient,
  guildId: string,
  subscriptionId: string,
  settlement?: SettlementInvoice,
  analyticsContext?: { userId: string; analyticsOptOut: boolean },
  owner?: RuntimeBillingOwner,
) {
  return runBillingOperation(owner, (admitted) =>
    reconcileSubscriptionOwned(
      stripe,
      guildId,
      subscriptionId,
      settlement,
      analyticsContext,
      admitted,
    ),
  );
}
