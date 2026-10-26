import { readLedgerWriterRuntime } from "./ledgerWriterRuntime";
import { HISTORY_WRITER_VERSION } from "../types/historyWriterBoundary";
import { assertFirstOfferInvoice } from "./firstOfferInvoiceEvidence";
import { assertSessionAssociation } from "./purchaseSession";
import { randomUUID } from "node:crypto";
import type {
  StripeClient,
  StripeInvoice,
  StripeSubscription,
} from "../types/stripe";
import type { PurchaseAttempt } from "../types/purchase";
import { getOfferUsageRepository } from "../repositories/offerUsageRepository";
import {
  introOfferIdSchema,
  type OfferUsage,
  type OfferUsageMutation,
} from "../types/offerUsage";

type ReservedOffer = Extract<OfferUsage, { state: "reserved" }>;
const referenceId = (reference: string | { id: string } | null | undefined) =>
  typeof reference === "string" ? reference : reference?.id;
const invalid = () =>
  new Error("Offer settlement evidence does not match the reserved purchase");

export type InitialOfferSettlement =
  | { kind: "none" }
  | { kind: "awaiting_invoice" }
  | { kind: "pending"; invoiceId: string }
  | { kind: "voided"; invoiceId: string; usage: OfferUsageMutation }
  | { kind: "settled"; invoiceId: string; usage: OfferUsageMutation };
export type SettlementInvoice = { invoiceId: string };

export async function prepareInitialOfferSettlement(
  stripe: StripeClient,
  attempt: PurchaseAttempt,
  subscription: StripeSubscription,
  hint?: SettlementInvoice,
): Promise<InitialOfferSettlement> {
  const id = introOfferIdSchema.safeParse(
    attempt.checkout.metadata?.intro_offer_id,
  );
  if (!id.success) return { kind: "none" };
  const expected = await getOfferUsageRepository().get(
    attempt.guildId,
    id.data,
    attempt.mode,
  );
  if (
    !expected ||
    expected.state === "unused" ||
    expected.operationId !== attempt.attemptId
  )
    throw invalid();
  if (expected.state === "used") return { kind: "none" };
  assertSubscriptionScope(attempt, subscription, expected);
  const invoice = await readInitialOfferInvoice(
    stripe,
    attempt,
    subscription,
    hint,
  );
  if (!invoice) return { kind: "awaiting_invoice" };
  if (isTerminalVoidedInvoice(invoice, subscription))
    return prepareVoidedOfferRelease(invoice, subscription, expected);
  if (!hasSettledPaymentStatus(invoice, subscription))
    return { kind: "pending", invoiceId: invoice.id };
  assertFirstOfferInvoice(invoice, subscription.id, expected.terms);
  const paidAt = invoice.status_transitions.paid_at;
  if (
    paidAt === null ||
    !Number.isInteger(paidAt) ||
    !Number.isInteger(invoice.amount_paid) ||
    invoice.amount_paid < 0 ||
    invoice.amount_remaining !== 0
  )
    throw invalid();
  const writerRuntime = await readLedgerWriterRuntime(
    process.env.ECS_CONTAINER_METADATA_URI_V4,
  );
  return {
    kind: "settled",
    invoiceId: invoice.id,
    usage: {
      expected,
      next: {
        ...expected,
        revision: randomUUID(),
        state: "used",
        writerVersion: HISTORY_WRITER_VERSION,
        ...(writerRuntime ? { writerRuntime } : {}),
        usedAt: Date.now(),
        settlement: {
          customerId: attempt.customerId,
          subscriptionId: subscription.id,
          subscriptionItemId:
            invoice.lines.data[0].parent?.subscription_item_details
              ?.subscription_item,
          invoiceId: invoice.id,
          priceId: expected.terms.priceId,
          status: "paid",
          amountPaid: invoice.amount_paid,
          amountRemaining: 0,
          settledAt: paidAt * 1000,
        },
      },
    },
  };
}
async function readInitialOfferInvoice(
  stripe: StripeClient,
  attempt: PurchaseAttempt,
  subscription: StripeSubscription,
  hint: SettlementInvoice | undefined,
): Promise<StripeInvoice | undefined> {
  const reference =
    attempt.initialInvoiceId ??
    hint?.invoiceId ??
    referenceId(subscription.latest_invoice);
  if (!reference) return undefined;
  const invoice = await readAssociatedInvoice(
    stripe,
    reference,
    attempt,
    subscription,
  );
  if (invoice.billing_reason === "subscription_create") return invoice;
  if (attempt.initialInvoiceId || !attempt.sessionId) throw invalid();
  const session = await stripe.checkout.sessions.retrieve(attempt.sessionId);
  assertSessionAssociation(attempt, session);
  const initialInvoiceId = referenceId(session.invoice);
  if (
    session.status !== "complete" ||
    referenceId(session.subscription) !== subscription.id ||
    !initialInvoiceId
  )
    throw invalid();
  const initial = await readAssociatedInvoice(
    stripe,
    initialInvoiceId,
    attempt,
    subscription,
  );
  if (initial.billing_reason !== "subscription_create") throw invalid();
  return initial;
}
async function readAssociatedInvoice(
  stripe: StripeClient,
  invoiceId: string,
  attempt: PurchaseAttempt,
  subscription: StripeSubscription,
) {
  const invoice = await stripe.invoices.retrieve(invoiceId, {
    expand: ["discounts.source.coupon"],
  });
  assertInvoiceScope(invoice, invoiceId, attempt, subscription);
  return invoice;
}
function assertSubscriptionScope(
  attempt: PurchaseAttempt,
  subscription: StripeSubscription,
  offer: ReservedOffer,
) {
  if (
    subscription.metadata.guild_id !== attempt.guildId ||
    subscription.metadata.purchase_attempt_id !== attempt.attemptId ||
    subscription.metadata.intro_offer_id !== offer.offerId ||
    subscription.metadata.intro_offer_coupon_id !== offer.terms.couponId ||
    referenceId(subscription.customer) !== attempt.customerId ||
    subscription.livemode !== (attempt.mode === "live")
  )
    throw invalid();
}
function assertInvoiceScope(
  invoice: StripeInvoice,
  invoiceId: string,
  attempt: PurchaseAttempt,
  subscription: StripeSubscription,
) {
  if (
    invoice.id !== invoiceId ||
    invoice.livemode !== (attempt.mode === "live") ||
    referenceId(invoice.customer) !== attempt.customerId ||
    referenceId(invoice.parent?.subscription_details?.subscription) !==
      subscription.id ||
    invoice.currency !== "usd"
  )
    throw invalid();
}
function prepareVoidedOfferRelease(
  invoice: StripeInvoice,
  subscription: StripeSubscription,
  expected: ReservedOffer,
): Extract<InitialOfferSettlement, { kind: "voided" }> {
  assertFirstOfferInvoice(invoice, subscription.id, expected.terms);
  const voidedAt = invoice.status_transitions.voided_at;
  if (
    invoice.amount_paid !== 0 ||
    invoice.status_transitions.paid_at !== null ||
    voidedAt === null ||
    !Number.isInteger(voidedAt) ||
    voidedAt * 1000 < Math.floor(expected.reservedAt / 1000) * 1000
  )
    throw invalid();
  return {
    kind: "voided",
    invoiceId: invoice.id,
    usage: {
      expected,
      next: {
        guildId: expected.guildId,
        mode: expected.mode,
        offerId: expected.offerId,
        revision: randomUUID(),
        state: "unused",
        released: {
          operationId: expected.operationId,
          reason: "initial_invoice_voided",
          resourceId: invoice.id,
          verifiedAt: Date.now(),
        },
      },
    },
  };
}

function isTerminalVoidedInvoice(
  invoice: StripeInvoice,
  subscription: StripeSubscription,
): boolean {
  return (
    invoice.status === "void" &&
    ["canceled", "incomplete_expired"].includes(subscription.status)
  );
}
function hasSettledPaymentStatus(
  invoice: StripeInvoice,
  subscription: StripeSubscription,
): boolean {
  return (
    invoice.status === "paid" &&
    !["incomplete", "incomplete_expired"].includes(subscription.status)
  );
}
