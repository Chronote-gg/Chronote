import { hasProcessingRenewalPayment } from "./renewalRecoveryProvider";
import type { StripeClient } from "../types/stripe";
import type {
  RenewalRecovery,
  RenewalRecoveryView,
} from "../types/renewalRecovery";
import { getRenewalRecoveryRepository } from "../repositories/renewalRecoveryRepository";
import { getSubscriptionRepository } from "../repositories/subscriptionRepository";
import { getBillingChangeRepository } from "../repositories/billingChangeRepository";
import { refreshRenewalRecovery } from "./renewalRecoveryService";
import {
  assertRenewalOwner,
  verifyRenewalInvoice,
} from "./renewalRecoveryEvidence";
import { assertStripePayer } from "./billingPayerService";
import { config } from "./configService";
import { resolveTierFromPrice } from "./pricingService";

type Input = {
  stripe: StripeClient;
  guildId: string;
  payerId?: string;
  now: number;
};
type RecoveryDetails = Exclude<RenewalRecoveryView, { status: "none" }>;
async function baseView(
  record: RenewalRecovery,
  input: Input,
): Promise<RecoveryDetails> {
  let selectedTier: RecoveryDetails["selectedTier"] = record.paid.tier;
  let selectedInterval: RecoveryDetails["selectedInterval"] =
    record.paid.interval;
  if (record.scheduledOperationId) {
    const operation = await getBillingChangeRepository().getOperation(
      record.guildId,
      record.scheduledOperationId,
    );
    selectedTier = operation?.target.selection.tier ?? null;
    selectedInterval = operation?.target.selection.interval ?? null;
  }
  return {
    status: viewStatus(record, input.now),
    priorTier: record.paid.tier,
    selectedTier,
    selectedInterval,
    scheduledChange: record.scheduledOperationId !== null,
    endsAt:
      "endsAt" in record &&
      record.state !== "paid" &&
      record.state !== "superseded"
        ? new Date(record.endsAt * 1000).toISOString()
        : null,
    amountDue: null,
    currency: null,
    paymentUrl: null,
    canManage: input.payerId === record.payerId,
  };
}
function viewStatus(
  record: RenewalRecovery,
  now: number,
): RecoveryDetails["status"] {
  if (!record.enforcementAccepted) return "settlement_pending";
  if (record.state === "canceled") return "canceled";
  if (record.state === "canceling") return "reconciling";
  if (record.state === "grace")
    return now < record.endsAt ? "grace" : "reconciling";
  return "settlement_pending";
}
async function payableView(
  record: Extract<RenewalRecovery, { state: "grace" }>,
  input: Input,
  view: RecoveryDetails,
): Promise<RecoveryDetails> {
  const subscription = await input.stripe.subscriptions.retrieve(
    record.subscriptionId,
  );
  assertRenewalOwner(subscription, record);
  const invoice = await input.stripe.invoices.retrieve(record.invoice.id);
  await verifyRenewalInvoice(invoice, record, subscription);
  if (invoice.status === "void" || invoice.status === "uncollectible") {
    if (view.canManage)
      await assertStripePayer({
        stripe: input.stripe,
        customerId: record.customerId,
        payerId: record.payerId,
      });
    return {
      ...view,
      amountDue: invoice.status === "void" ? null : invoice.amount_remaining,
      currency: invoice.currency,
    };
  }
  if (invoice.status !== "open" || invoice.amount_remaining <= 0)
    return { ...view, status: "settlement_pending" };
  if (await hasProcessingRenewalPayment(input.stripe, invoice, record))
    return { ...view, status: "settlement_pending" };
  const item = subscription.items.data[0];
  const interval = item.price.recurring?.interval;
  if (view.canManage)
    await assertStripePayer({
      stripe: input.stripe,
      customerId: record.customerId,
      payerId: record.payerId,
    });
  return {
    ...view,
    selectedTier:
      resolveTierFromPrice({
        priceId: item.price.id,
        lookupKey: item.price.lookup_key,
      }) ?? null,
    selectedInterval:
      interval === "month" ? "month" : interval === "year" ? "year" : null,
    amountDue: invoice.amount_remaining,
    currency: invoice.currency,
    paymentUrl: view.canManage ? (invoice.hosted_invoice_url ?? null) : null,
  };
}
export async function getRenewalRecoveryView(
  input: Input,
): Promise<RenewalRecoveryView> {
  const pointer = await getSubscriptionRepository().get(input.guildId);
  let record = await getRenewalRecoveryRepository().getCurrent(input.guildId);
  if (
    !record ||
    pointer?.stripeSubscriptionId !== record.subscriptionId ||
    record.mode !== config.subscription.stripeMode
  )
    return { status: "none" };
  if (!config.stripe.renewalGraceEnabled && !record.enforcementAccepted)
    return { status: "none" };
  if (record.state === "watching" && input.now < record.paid.periodEnd)
    return { status: "none" };
  try {
    record = (await refreshRenewalRecovery(input)) ?? record;
  } catch (error) {
    console.warn("Could not refresh renewal billing status", {
      guildId: input.guildId,
      error,
    });
  }
  if (
    record.state === "ended" ||
    ((record.state === "paid" || record.state === "superseded") &&
      record.projection.state === "complete")
  )
    return { status: "none" };
  const view = await baseView(record, input);
  if (record.state !== "grace" || view.status !== "grace") return view;
  try {
    return await payableView(record, input, view);
  } catch (error) {
    console.warn("Could not verify renewal payment details", {
      guildId: input.guildId,
      error,
    });
    return { ...view, paymentUrl: null };
  }
}
