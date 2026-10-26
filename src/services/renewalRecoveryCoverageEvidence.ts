import { randomUUID } from "node:crypto";
import type {
  StripeClient,
  StripeSubscription,
  StripeInvoice,
} from "../types/stripe";
import type { GuildSubscription } from "../types/db";
import {
  renewalRecoverySchema,
  type RenewalRecovery,
} from "../types/renewalRecovery";
import {
  assertRenewalOwner,
  readRenewalPaidBasis,
} from "./renewalRecoveryEvidence";
import { inventory } from "./billingChangeRecovery";
import { stripeId, changeUnavailable } from "./billingChangeProvider";

async function historicalPaidBasis(
  stripe: StripeClient,
  subscription: StripeSubscription,
  guildId: string,
) {
  const invoices = await inventory(
    stripe.invoices.list({
      subscription: subscription.id,
      status: "paid",
      limit: 100,
    }),
  );
  if (
    subscription.status === "trialing" &&
    invoices.some((invoice) => invoice.total > 0 && invoice.lines.has_more)
  )
    throw changeUnavailable();
  for (const invoice of invoices.toSorted(
    (a, b) =>
      (historicalLine(b, subscription)?.period.end ?? 0) -
      (historicalLine(a, subscription)?.period.end ?? 0),
  )) {
    const line = historicalLine(invoice, subscription);
    if (!line) continue;
    const priceId = stripeId(line.pricing?.price_details?.price);
    if (!priceId) throw changeUnavailable();
    const price = await stripe.prices.retrieve(priceId);
    // Use the provider's paid line period to verify history after the live item has advanced.
    const historical = {
      ...subscription,
      items: {
        ...subscription.items,
        data: [
          {
            ...subscription.items.data[0],
            price,
            current_period_start: line.period.start,
            current_period_end: line.period.end,
          },
        ],
      },
    };
    return readRenewalPaidBasis(stripe, historical, guildId, invoice.id);
  }
  return undefined;
}
function historicalLine(
  invoice: StripeInvoice,
  subscription: StripeSubscription,
) {
  if (
    (subscription.status === "trialing" && invoice.total <= 0) ||
    invoice.lines.has_more ||
    invoice.metadata?.chronote_invoice_role === "funding"
  )
    return undefined;
  const lines = invoice.lines.data.filter(
    (line) =>
      line.parent?.subscription_item_details?.subscription ===
        subscription.id &&
      !line.parent.subscription_item_details.proration &&
      line.quantity === 1 &&
      line.period.end <= subscription.items.data[0].current_period_start,
  );
  if (lines.length !== 1) return undefined;
  return lines[0];
}
export async function readRenewalCoverageCandidate(input: {
  stripe: StripeClient;
  saved: GuildSubscription;
  mode: "test" | "live";
}): Promise<RenewalRecovery | null> {
  const { stripe, saved, mode } = input;
  if (!saved.stripeSubscriptionId || !saved.stripeCustomerId)
    throw changeUnavailable();
  const subscription = await stripe.subscriptions.retrieve(
    saved.stripeSubscriptionId,
  );
  assertRenewalOwner(subscription, {
    guildId: saved.guildId,
    subscriptionId: saved.stripeSubscriptionId,
    customerId: saved.stripeCustomerId,
    mode,
  });
  if (
    !subscription.metadata.discord_id ||
    subscription.items.has_more ||
    subscription.items.data.length !== 1
  )
    throw changeUnavailable();
  const invoiceId = stripeId(subscription.latest_invoice);
  const latest = invoiceId ? await stripe.invoices.retrieve(invoiceId) : null;
  const paid =
    latest?.status === "paid" &&
    invoiceId &&
    (subscription.status !== "trialing" || latest.total > 0)
      ? await readRenewalPaidBasis(
          stripe,
          subscription,
          saved.guildId,
          invoiceId,
        )
      : await historicalPaidBasis(stripe, subscription, saved.guildId);
  if (!paid) {
    if (subscription.status === "trialing") return null;
    throw changeUnavailable();
  }
  return renewalRecoverySchema.parse({
    guildId: saved.guildId,
    subscriptionId: subscription.id,
    customerId: saved.stripeCustomerId,
    payerId: subscription.metadata.discord_id,
    mode,
    revision: randomUUID(),
    paid,
    scheduledOperationId: null,
    enforcementAccepted: false,
    state: "watching",
    nextCheckAt: paid.periodEnd,
  });
}
