import { getRenewalRecoveryRepository } from "../repositories/renewalRecoveryRepository";
import {
  isRenewalCancellationComplete,
  renewalRecoveryKey,
} from "../types/renewalRecovery";
import type { BillingChangeOperation } from "../types/billingChange";
import type { StripeInvoice } from "../types/stripe";
import type {
  HistoricalOfferScope,
  HistoricalOfferEvidence,
} from "./historicalOfferEvidence";
import { getBillingChangeRepository } from "../repositories/billingChangeRepository";
import { getOfferUsageRepository } from "../repositories/offerUsageRepository";
import { stripeId } from "./billingChangeProvider";

// A marker identifies evidence to verify. It never grants historical coverage.
export async function classifyChangeHistory(
  invoice: StripeInvoice,
  scope: HistoricalOfferScope,
): Promise<HistoricalOfferEvidence | undefined> {
  const metadata = invoice.metadata?.chronote_change_operation
    ? invoice.metadata
    : invoice.parent?.subscription_details?.metadata;
  const operationId = metadata?.chronote_change_operation;
  if (!operationId) return undefined;
  const operation = await getBillingChangeRepository().getOperation(
    scope.guildId,
    operationId,
  );
  const unresolved: HistoricalOfferEvidence = {
    kind: "unresolved",
    invoiceId: invoice.id,
    offerId: null,
    reason: "unsupported_identity",
  };
  if (!operation || !historyIdentityMatches(invoice, scope, operation))
    return unresolved;
  const funding = invoice.id === operation.draftInvoiceId;
  if (
    operation.state === "canceled" &&
    (await isCanceledChangeInvoice(invoice, operation, funding))
  )
    return { kind: "ordinary" };
  if (operation.state !== "succeeded") return unresolved;
  if (
    !funding &&
    stripeId(invoice.parent?.subscription_details?.subscription) !==
      operation.source.subscriptionId
  )
    return unresolved;
  const offerEvidence = await classifyChangedOffer(
    invoice,
    scope,
    operation,
    funding,
    unresolved,
  );
  if (offerEvidence) return offerEvidence;
  if (
    !funding &&
    operation.service?.invoiceId !== invoice.id &&
    invoice.lines.data.some(
      (line) => line.pricing?.price_details?.price !== operation.target.priceId,
    )
  )
    return unresolved;
  return { kind: "ordinary" };
}

async function isCanceledChangeInvoice(
  invoice: StripeInvoice,
  operation: BillingChangeOperation,
  funding: boolean,
): Promise<boolean> {
  return (
    funding ||
    isAbandonedEmptyDraft(invoice, operation) ||
    (await isCanceledRenewal(invoice, operation))
  );
}
async function isCanceledRenewal(
  invoice: StripeInvoice,
  operation: BillingChangeOperation,
): Promise<boolean> {
  if (operation.timing !== "renewal") return false;
  const recovery = await getRenewalRecoveryRepository().get(
    renewalRecoveryKey({
      guildId: operation.guildId,
      subscriptionId: operation.source.subscriptionId,
      paid: { periodEnd: operation.source.periodEnd },
    }),
  );
  return Boolean(
    isRenewalCancellationComplete(recovery) &&
    recovery.state === "canceled" &&
    recovery.scheduledOperationId === operation.operationId &&
    recovery.invoice.id === invoice.id &&
    recovery.customerId === stripeId(invoice.customer) &&
    recovery.mode === operation.mode,
  );
}
function isAbandonedEmptyDraft(
  invoice: StripeInvoice,
  operation: BillingChangeOperation,
) {
  // An unacknowledged creation can leave an unchargeable draft after preparation expires.
  return (
    operation.draftInvoiceId === null &&
    invoice.status === "draft" &&
    !invoice.auto_advance &&
    !invoice.parent?.subscription_details &&
    invoice.metadata?.guild_id === operation.guildId &&
    invoice.metadata.chronote_invoice_role === "funding" &&
    invoice.lines.data.length === 0 &&
    invoice.subtotal === 0 &&
    invoice.total === 0 &&
    invoice.amount_due === 0 &&
    invoice.amount_paid === 0 &&
    invoice.amount_remaining === 0
  );
}

function historyIdentityMatches(
  invoice: StripeInvoice,
  scope: HistoricalOfferScope,
  operation: BillingChangeOperation,
) {
  return (
    operation.mode === scope.mode &&
    operation.guildId === scope.guildId &&
    invoice.livemode === (scope.mode === "live") &&
    stripeId(invoice.customer) === operation.source.customerId &&
    invoice.currency === operation.target.currency &&
    invoice.created >= operation.createdAt &&
    !invoice.lines.has_more
  );
}
async function classifyChangedOffer(
  invoice: StripeInvoice,
  scope: HistoricalOfferScope,
  operation: Extract<BillingChangeOperation, { state: "succeeded" }>,
  funding: boolean,
  unresolved: HistoricalOfferEvidence,
): Promise<HistoricalOfferEvidence | undefined> {
  const offer = operation.target.offer;
  if (offer) {
    const usage = await getOfferUsageRepository().get(
      scope.guildId,
      offer.id,
      scope.mode,
    );
    if (
      usage?.state !== "used" ||
      usage.operationId !== operation.operationId ||
      usage.settlement.subscriptionId !== operation.source.subscriptionId
    )
      return unresolved;
    if (funding || invoice.id === usage.settlement.invoiceId)
      return {
        kind: "settled",
        offerId: offer.id,
        originalOperationId: operation.operationId,
        originalPayerId: operation.payerId,
        productId: operation.target.productId ?? "",
        customerId: operation.source.customerId,
        subscriptionId: operation.source.subscriptionId,
        invoiceId: invoice.id,
        createdAt: invoice.created * 1000,
        terms: offer.terms,
        settlement: { ...usage.settlement, invoiceId: invoice.id },
      };
    if (
      invoice.lines.data.some(
        (line) =>
          line.pricing?.price_details?.price !== operation.target.priceId,
      )
    )
      return unresolved;
    return {
      kind: "covered_cycle",
      invoiceId: invoice.id,
      offerId: offer.id,
      originalInvoiceId: usage.settlement.invoiceId,
    };
  }

  return undefined;
}
