import type Stripe from "stripe";
import type {
  StripeClient,
  StripeInvoice,
  StripeSubscription,
} from "../types/stripe";
import type { SubscriptionPaymentProgress } from "../types/pricing";
type Subscription = Pick<
  StripeSubscription,
  "id" | "status" | "customer" | "latest_invoice" | "livemode"
>;
const id = (reference: string | { id: string } | null | undefined) =>
  typeof reference === "string" ? reference : reference?.id;
export async function readSubscriptionPaymentProgress(
  stripe: StripeClient,
  subscription: Subscription,
): Promise<SubscriptionPaymentProgress> {
  if (subscription.status !== "incomplete") return "not_pending";
  try {
    const invoiceId = id(subscription.latest_invoice);
    if (!invoiceId) return "unavailable";
    const invoice = await stripe.invoices.retrieve(invoiceId);
    if (!matchesInvoice(invoice, subscription, invoiceId)) return "unavailable";
    const payments = await stripe.invoicePayments.list({
      invoice: invoiceId,
      status: "open",
      limit: 100,
      expand: ["data.payment.payment_intent"],
    });
    if (payments.has_more || payments.data.length !== 1) return "unavailable";
    const payment = payments.data[0];
    if (!matchesPayment(payment, invoice)) return "unavailable";
    const intent = payment.payment.payment_intent;
    if (
      !intent ||
      typeof intent === "string" ||
      !matchesIntent(intent, invoice, payment)
    )
      return "unavailable";
    if (intent.status === "processing") return "processing";
    return [
      "requires_action",
      "requires_payment_method",
      "requires_confirmation",
    ].includes(intent.status)
      ? "action_required"
      : "unavailable";
  } catch {
    return "unavailable";
  }
}
function matchesInvoice(
  invoice: StripeInvoice,
  subscription: Subscription,
  invoiceId: string,
): boolean {
  return (
    invoice.id === invoiceId &&
    id(invoice.customer) === id(subscription.customer) &&
    id(invoice.parent?.subscription_details?.subscription) ===
      subscription.id &&
    invoice.livemode === subscription.livemode &&
    invoice.status === "open" &&
    invoice.amount_remaining > 0
  );
}
function matchesPayment(
  payment: Stripe.InvoicePayment,
  invoice: StripeInvoice,
): boolean {
  return (
    id(payment.invoice) === invoice.id &&
    payment.livemode === invoice.livemode &&
    payment.currency === invoice.currency &&
    payment.is_default &&
    payment.status === "open" &&
    payment.amount_requested === invoice.amount_remaining &&
    payment.payment.type === "payment_intent"
  );
}
function matchesIntent(
  intent: Stripe.PaymentIntent,
  invoice: StripeInvoice,
  payment: Stripe.InvoicePayment,
): boolean {
  return (
    Boolean(intent.id) &&
    id(intent.customer) === id(invoice.customer) &&
    intent.livemode === invoice.livemode &&
    intent.currency === invoice.currency &&
    intent.amount === payment.amount_requested
  );
}
