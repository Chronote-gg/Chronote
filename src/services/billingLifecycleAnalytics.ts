import {
  runBillingOperation,
  type RuntimeBillingOwner,
} from "./runtimeBillingOperationService";
import type { GuildSubscription } from "../types/db";
import type { BillingLifecycleState } from "../types/billingAnalytics";
import type { RenewalOperation } from "../types/renewal";
import type {
  StripeClient,
  StripeInvoice,
  StripeSubscription,
} from "../types/stripe";
import { captureEvent } from "./analyticsService";
import { config } from "./configService";
import { resolveTierFromPrice } from "./pricingService";
import { resolveSubscriptionCancellationAt } from "../utils/stripeCancellation";
import { getRenewalReactivationRepository } from "../repositories/renewalReactivationRepository";
import { getStripeWebhookRepository } from "../repositories/stripeWebhookRepository";
import { getSubscriptionRepository } from "../repositories/subscriptionRepository";
import { isPurchaseAnalyticsOptedOut } from "./purchaseReconciliation";

export function buildBillingLifecycleState(
  provider: StripeSubscription,
): BillingLifecycleState {
  const terminal =
    provider.status === "canceled" || provider.status === "incomplete_expired";
  const end = resolveSubscriptionCancellationAt(provider);
  const price = provider.items.data[0]?.price;
  const interval = price?.recurring?.interval;
  return {
    state: terminal
      ? "ended"
      : end !== null && end !== undefined
        ? "renewal_off"
        : "renewal_on",
    scheduledEnd:
      end !== null && end !== undefined
        ? new Date(end * 1000).toISOString()
        : null,
    tier: terminal
      ? "free"
      : (resolveTierFromPrice({
          priceId: price?.id,
          lookupKey: price?.lookup_key,
        }) ?? "unknown"),
    interval:
      interval === "month" ? "month" : interval === "year" ? "year" : "unknown",
  };
}
export function billingBoundary(scheduledEnd: string | null, observedAt: Date) {
  if (!scheduledEnd) return { boundary_known: false };
  const seconds = Math.floor(
    (Date.parse(scheduledEnd) - observedAt.getTime()) / 1000,
  );
  return Number.isFinite(seconds) && seconds >= 0 && seconds <= 31622400
    ? { boundary_known: true, remaining_seconds_to_scheduled_end: seconds }
    : { boundary_known: false };
}
async function operationOptOut(
  guildId: string,
  subscriptionId: string,
): Promise<boolean> {
  const repo = getRenewalReactivationRepository();
  const control = await repo.getControl({ guildId });
  if (!control) return false;
  const op = await repo.getOperation({
    guildId,
    operationId: control.operationId,
  });
  return !op || op.subscriptionId !== subscriptionId || op.analyticsOptOut;
}
export async function publishBillingLifecycleTransition({
  previous,
  current,
  provider,
  observedAt,
  analyticsOptOut = false,
  userId,
}: {
  previous: GuildSubscription | undefined;
  current: GuildSubscription;
  provider: StripeSubscription;
  observedAt: Date;
  analyticsOptOut?: boolean;
  userId?: string;
}): Promise<void> {
  try {
    const before = previous?.billingAnalyticsState;
    const after = current.billingAnalyticsState;
    if (!before || !after) return;
    const change = lifecycleChange(before, after);
    if (!change) return;
    if (
      !config.analytics.billingLifecycleEnabled ||
      analyticsOptOut ||
      (await isPurchaseAnalyticsOptedOut(current.guildId, provider)) ||
      (await operationOptOut(current.guildId, provider.id))
    )
      return;
    captureEvent("billing_subscription_state_changed", {
      guildId: current.guildId,
      userId,
      timestamp: observedAt,
      properties: {
        surface: userId ? "portal_billing" : "stripe_webhook",
        event_version: 1,
        from_state: before.state,
        to_state: after.state,
        change,
        tier: after.tier,
        previous_tier: before.tier,
        interval: after.interval,
        cause:
          after.state === "ended"
            ? provider.cancellation_details?.reason === "payment_failed"
              ? "payment_failure"
              : before.state === "renewal_off"
                ? "voluntary"
                : "unknown"
            : "unknown",
        ...billingBoundary(after.scheduledEnd, observedAt),
      },
    });
  } catch {
    console.warn("Billing lifecycle analytics unavailable");
  }
}
function lifecycleChange(
  before: BillingLifecycleState,
  after: BillingLifecycleState,
) {
  if (before.state !== after.state) return "state_changed";
  if (
    after.state === "renewal_off" &&
    before.scheduledEnd !== after.scheduledEnd
  )
    return "terms_updated";
  if (before.tier !== after.tier || before.interval !== after.interval)
    return "plan_changed";
  return null;
}
async function receipt(key: string, owner?: RuntimeBillingOwner) {
  const now = Date.now();
  return runBillingOperation(owner, (admitted) =>
    admitted.effect(() =>
      getStripeWebhookRepository().tryCreate({
        eventId: `billing_lifecycle:${key}`,
        receivedAt: new Date(now).toISOString(),
        expiresAt: Math.floor(now / 1000) + 86400 * 400,
      }),
    ),
  );
}
export async function captureRenewalOperationEvent({
  operation,
  phase,
}: {
  operation: RenewalOperation;
  phase: "requested" | "result";
}): Promise<void> {
  try {
    if (!config.analytics.billingLifecycleEnabled || operation.analyticsOptOut)
      return;
    captureEvent(`billing_renewal_reactivation_${phase}`, {
      guildId: operation.guildId,
      userId: operation.payerId,
      timestamp:
        phase === "requested" ? new Date(operation.firstAttemptAt) : undefined,
      properties: {
        event_version: 1,
        surface: "portal_billing",
        tier: operation.approvedTerms.tier,
        interval: operation.approvedTerms.interval,
        ...(phase === "result"
          ? {
              outcome:
                operation.state === "succeeded" ? "confirmed" : operation.state,
            }
          : {}),
      },
    });
  } catch {
    console.warn("Renewal operation analytics unavailable");
  }
}
const objectId = (value: string | { id: string } | null | undefined) =>
  typeof value === "string" ? value : value?.id;
function invoiceSubscription(invoice: StripeInvoice) {
  return objectId(invoice.parent?.subscription_details?.subscription);
}
function matchesInvoice(
  invoice: StripeInvoice,
  provider: StripeSubscription,
  guildId: string,
) {
  return (
    invoiceSubscription(invoice) === provider.id &&
    provider.metadata.guild_id === guildId &&
    objectId(invoice.customer) === objectId(provider.customer) &&
    invoice.livemode === provider.livemode
  );
}
export async function captureBillingInvoiceOutcome({
  stripe,
  invoice,
  outcome,
  owner,
}: {
  stripe: StripeClient;
  invoice: StripeInvoice;
  outcome: "failed" | "settled";
  owner?: RuntimeBillingOwner;
}): Promise<void> {
  try {
    const native = await stripe.invoices.retrieve(invoice.id);
    const subId = invoiceSubscription(native);
    if (!subId) return;
    const provider = await stripe.subscriptions.retrieve(subId);
    const guildId = provider.metadata.guild_id;
    if (!guildId || !matchesInvoice(native, provider, guildId)) return;
    const saved = await getSubscriptionRepository().get(guildId);
    if (saved?.stripeSubscriptionId !== provider.id) return;
    const suppressed = await isPurchaseAnalyticsOptedOut(guildId, provider);
    const state = buildBillingLifecycleState(provider);
    const mode = provider.livemode ? "live" : "test";
    const key = `${mode}:${native.id}`;
    const emit = (event: string) => {
      if (config.analytics.billingLifecycleEnabled && !suppressed)
        captureEvent(event, {
          guildId,
          properties: {
            surface: "stripe_webhook",
            event_version: 1,
            tier: state.tier,
            interval: state.interval,
          },
        });
    };
    if (outcome === "failed") {
      if (isFailedInvoice(native) && (await receipt(`failed:${key}`, owner)))
        emit("billing_payment_failed");
      return;
    }
    await captureSettlement(native, provider, key, emit, owner);
  } catch {
    console.warn("Billing invoice analytics unavailable");
  }
}

function isFailedInvoice(invoice: StripeInvoice) {
  return (
    invoice.status === "open" &&
    invoice.attempted &&
    invoice.attempt_count > 0 &&
    invoice.amount_remaining > 0
  );
}
function isServiceRenewal(
  invoice: StripeInvoice,
  provider: StripeSubscription,
) {
  return (
    invoice.billing_reason === "subscription_cycle" &&
    invoice.lines.data.some(
      (line) =>
        line.parent?.subscription_item_details?.subscription_item ===
          provider.items.data[0]?.id &&
        !line.parent.subscription_item_details.proration &&
        line.period.end > line.period.start,
    )
  );
}
async function captureSettlement(
  invoice: StripeInvoice,
  provider: StripeSubscription,
  key: string,
  emit: (event: string) => void,
  owner?: RuntimeBillingOwner,
) {
  if (
    invoice.status !== "paid" ||
    invoice.amount_remaining !== 0 ||
    provider.status !== "active"
  )
    return;
  if (
    await getStripeWebhookRepository().get(`billing_lifecycle:failed:${key}`)
  ) {
    if (await receipt(`recovered:${key}`, owner))
      emit("billing_payment_recovered");
  }
  if (
    isServiceRenewal(invoice, provider) &&
    (await receipt(`settled:${key}`, owner))
  )
    emit("billing_renewal_settled");
}
