import type {
  StripeClient,
  StripeSubscription,
  StripeInvoice,
} from "../types/stripe";
import type { FirstYearPayment } from "../types/pricing";
import { getBillingChangeRepository } from "../repositories/billingChangeRepository";
import { verifyChangeFunding } from "./billingChangeFunding";
import { stripeId } from "./billingChangeProvider";
import { assertRecurringOfferInvoice } from "./firstOfferInvoiceEvidence";
function isPaidAnnualInvoice(
  invoice: StripeInvoice,
  subscription: StripeSubscription,
): invoice is StripeInvoice & {
  billing_reason: "subscription_cycle" | "subscription_update";
} {
  return (
    (invoice.billing_reason === "subscription_cycle" ||
      invoice.billing_reason === "subscription_update") &&
    invoice.status === "paid" &&
    invoice.amount_remaining === 0 &&
    invoice.pre_payment_credit_notes_amount === 0 &&
    invoice.post_payment_credit_notes_amount === 0 &&
    invoice.livemode === subscription.livemode &&
    stripeId(invoice.customer) === stripeId(subscription.customer)
  );
}
export async function readChangedAnnualPayment(
  stripe: StripeClient,
  subscription: StripeSubscription,
): Promise<FirstYearPayment | null | undefined> {
  const operationId = subscription.metadata.chronote_change_operation;
  if (!operationId) return undefined;
  const operation = await getBillingChangeRepository().getOperation(
    subscription.metadata.guild_id,
    operationId,
  );
  if (!operation || operation.state !== "succeeded")
    return { status: "unavailable" };
  if (operation.target.offer?.id !== "basic_annual_intro_v1") return null;
  const terms = operation.target.offer.terms;
  if (terms.interval !== "year") return { status: "unavailable" };
  if (!sameAnnualPeriod(subscription, operation)) return null;
  if (!samePaymentOwner(subscription, operation))
    return { status: "unavailable" };
  if (!operation.service) return null;
  const invoice = await stripe.invoices.retrieve(
    operation.funding?.invoiceId ?? operation.service.invoiceId,
    { expand: ["discounts.source.coupon"] },
  );
  if (operation.funding) {
    if (!verifyChangeFunding(invoice, operation, operation.funding))
      return { status: "unavailable" };
  } else {
    if (!isPaidAnnualInvoice(invoice, subscription))
      return { status: "unavailable" };
    assertRecurringOfferInvoice(
      invoice,
      subscription.id,
      operation.target.offer.terms,
      invoice.billing_reason,
    );
  }
  return {
    status: "available",
    currency: terms.currency,
    discountedSubtotal: terms.discountedUnitAmount,
    amountPaid: invoice.amount_paid,
    periodStartsAt: new Date(
      operation.service.periodStart * 1000,
    ).toISOString(),
    periodEndsAt: new Date(operation.service.periodEnd * 1000).toISOString(),
  };
}

function sameAnnualPeriod(
  subscription: StripeSubscription,
  operation: Extract<
    import("../types/billingChange").BillingChangeOperation,
    { state: "succeeded" }
  >,
) {
  const item = subscription.items.data[0];
  return (
    operation.service &&
    item.price.id === operation.target.priceId &&
    item.current_period_start === operation.service.periodStart &&
    item.current_period_end === operation.service.periodEnd
  );
}
function samePaymentOwner(
  subscription: StripeSubscription,
  operation: import("../types/billingChange").BillingChangeOperation,
) {
  return (
    subscription.id === operation.source.subscriptionId &&
    stripeId(subscription.customer) === operation.source.customerId &&
    subscription.livemode === (operation.mode === "live")
  );
}
