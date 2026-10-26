import type { GuildSubscription } from "../types/db";
import type { RenewalRecovery } from "../types/renewalRecovery";
import { getRenewalRecoveryRepository } from "../repositories/renewalRecoveryRepository";
import { config } from "./configService";
import { getStripeClient } from "./stripeClient";
import { refreshRenewalRecovery } from "./renewalRecoveryService";
import {
  assertRenewalOwner,
  readRenewalPaidBasis,
} from "./renewalRecoveryEvidence";
import { stripeId } from "./billingChangeProvider";

type PaidAccess = { tier: "basic" | "pro" | null; expiresAt?: number };
const noPaidAccess: PaidAccess = { tier: null };
function courtesy(
  record: RenewalRecovery,
  now: number,
): PaidAccess | undefined {
  if (!record.enforcementAccepted) return undefined;
  if (
    record.state !== "grace" &&
    record.state !== "canceling" &&
    record.state !== "canceled"
  )
    return undefined;
  return now < record.endsAt
    ? { tier: record.paid.tier, expiresAt: record.endsAt * 1000 }
    : noPaidAccess;
}
async function verifiedCurrentPaidAccess(
  subscription: GuildSubscription,
  now: number,
): Promise<PaidAccess> {
  const stripe = getStripeClient();
  if (!stripe || !subscription.stripeSubscriptionId) return noPaidAccess;
  const native = await stripe.subscriptions.retrieve(
    subscription.stripeSubscriptionId,
  );
  if (native.status !== "active") return noPaidAccess;
  const customerId = subscription.stripeCustomerId;
  const invoiceId = stripeId(native.latest_invoice);
  if (!customerId || !invoiceId) return noPaidAccess;
  assertRenewalOwner(native, {
    guildId: subscription.guildId,
    subscriptionId: subscription.stripeSubscriptionId,
    customerId,
    mode: config.subscription.stripeMode === "live" ? "live" : "test",
  });
  const paid = await readRenewalPaidBasis(
    stripe,
    native,
    subscription.guildId,
    invoiceId,
  );
  return now < paid.periodEnd
    ? { tier: paid.tier, expiresAt: paid.periodEnd * 1000 }
    : noPaidAccess;
}
export async function resolveRenewalAccess(
  subscription: GuildSubscription | undefined,
  now: number,
): Promise<PaidAccess | undefined> {
  if (!subscription?.stripeSubscriptionId) return undefined;
  try {
    const record = await getRenewalRecoveryRepository().getCurrent(
      subscription.guildId,
    );
    const current =
      record?.subscriptionId === subscription.stripeSubscriptionId &&
      record.mode === config.subscription.stripeMode &&
      record.customerId === subscription.stripeCustomerId;
    if (
      !config.stripe.renewalGraceEnabled &&
      !(current && record?.enforcementAccepted)
    )
      return undefined;
    if (current && record)
      return await trackedPaidAccess(subscription, record, now);
    return subscription.status === "active"
      ? await verifiedCurrentPaidAccess(subscription, now)
      : noPaidAccess;
  } catch (error) {
    console.warn("Could not verify renewed subscription access", {
      guildId: subscription.guildId,
      error,
    });
    return noPaidAccess;
  }
}
async function trackedPaidAccess(
  subscription: GuildSubscription,
  record: RenewalRecovery,
  now: number,
): Promise<PaidAccess> {
  if (record.state === "superseded")
    return verifiedCurrentPaidAccess(subscription, now);
  const savedCourtesy = courtesy(record, now);
  if (savedCourtesy) return savedCourtesy;
  if (
    record.state === "watching" &&
    now < record.paid.periodEnd &&
    subscription.status !== "canceled"
  )
    return { tier: record.paid.tier, expiresAt: record.paid.periodEnd * 1000 };
  const stripe = getStripeClient();
  if (!stripe) return noPaidAccess;
  const refreshed = await refreshRenewalRecovery({
    stripe,
    guildId: subscription.guildId,
    now,
  });
  if (!refreshed) return noPaidAccess;
  const refreshedCourtesy = courtesy(refreshed, now);
  if (refreshedCourtesy) return refreshedCourtesy;
  if (refreshed.state === "watching" && now < refreshed.paid.periodEnd)
    return {
      tier: refreshed.paid.tier,
      expiresAt: refreshed.paid.periodEnd * 1000,
    };
  if (refreshed.state !== "paid" && refreshed.state !== "superseded")
    return noPaidAccess;
  return verifiedCurrentPaidAccess(subscription, now);
}
