import type { PurchaseAttempt } from "../types/purchase";
import type {
  StripeClient,
  StripeInvoice,
  StripeSubscription,
} from "../types/stripe";
import type { LedgerWriterRuntime } from "../types/ledgerWriterRuntime";
import {
  normalPurchaseWriterWitnessSchema,
  type NormalPurchaseWriterWitness,
} from "../types/normalPurchaseWriterWitness";
import { HISTORY_WRITER_VERSION } from "../types/historyWriterBoundary";
import { readLedgerWriterRuntime } from "./ledgerWriterRuntime";
import {
  assertSessionAssociation,
  checkoutInvoiceHint,
} from "./purchaseSession";
const id = (reference: string | { id: string } | null | undefined) =>
  typeof reference === "string" ? reference : reference?.id;
type Subscription = Pick<StripeSubscription, "id" | "customer" | "livemode">;
export function normalPurchaseWriterWitness(
  attempt: PurchaseAttempt,
  subscription: Subscription,
  invoice: StripeInvoice,
  runtime: LedgerWriterRuntime,
): NormalPurchaseWriterWitness | undefined {
  if (
    !matchesPurchase(invoice, attempt, subscription) ||
    !matchesOriginalLine(invoice, attempt, subscription)
  )
    return undefined;
  return normalPurchaseWriterWitnessSchema.parse({
    ...runtime,
    writerVersion: HISTORY_WRITER_VERSION,
    invoiceId: invoice.id,
  });
}
function matchesPurchase(
  invoice: StripeInvoice,
  attempt: PurchaseAttempt,
  subscription: Subscription,
): boolean {
  const parent = invoice.parent?.subscription_details;
  return Boolean(
    invoice.id &&
    attempt.customerId &&
    invoice.status === "paid" &&
    invoice.amount_remaining === 0 &&
    invoice.billing_reason === "subscription_create" &&
    invoice.livemode === (attempt.mode === "live") &&
    invoice.livemode === subscription.livemode &&
    id(invoice.customer) === attempt.customerId &&
    id(subscription.customer) === attempt.customerId &&
    id(parent?.subscription) === subscription.id &&
    parent?.metadata?.guild_id === attempt.guildId &&
    parent.metadata.purchase_attempt_id === attempt.attemptId &&
    parent.metadata.discord_id === attempt.payerId,
  );
}
function matchesOriginalLine(
  invoice: StripeInvoice,
  attempt: PurchaseAttempt,
  subscription: Subscription,
): boolean {
  const line = invoice.lines.data[0];
  const expected = attempt.checkout.line_items?.[0];
  return Boolean(
    !invoice.lines.has_more &&
    invoice.lines.data.length === 1 &&
    attempt.checkout.line_items?.length === 1 &&
    expected?.quantity === 1 &&
    line.quantity === 1 &&
    id(line.pricing?.price_details?.price) === expected.price &&
    line.parent?.subscription_item_details?.subscription === subscription.id &&
    line.parent.subscription_item_details.proration === false,
  );
}
export async function prepareNormalPurchaseWriterWitness(
  stripe: StripeClient,
  attempt: PurchaseAttempt,
  subscription: StripeSubscription,
  hint?: { invoiceId: string },
): Promise<NormalPurchaseWriterWitness | undefined> {
  if (
    attempt.writerWitness ||
    attempt.incidentKey ||
    attempt.state === "needs_review" ||
    attempt.state === "expired"
  )
    return undefined;
  const runtime = await readLedgerWriterRuntime(
    process.env.ECS_CONTAINER_METADATA_URI_V4,
  );
  if (!runtime) return undefined;
  try {
    let invoiceId = attempt.initialInvoiceId ?? hint?.invoiceId;
    if (!invoiceId && attempt.sessionId) {
      const session = await stripe.checkout.sessions.retrieve(
        attempt.sessionId,
      );
      assertSessionAssociation(attempt, session);
      if (id(session.subscription) !== subscription.id) return undefined;
      invoiceId = checkoutInvoiceHint(session)?.invoiceId;
    }
    if (!invoiceId) return undefined;
    const invoice = await stripe.invoices.retrieve(invoiceId);
    if (invoice.id !== invoiceId) return undefined;
    return normalPurchaseWriterWitness(attempt, subscription, invoice, runtime);
  } catch {
    return undefined;
  }
}
