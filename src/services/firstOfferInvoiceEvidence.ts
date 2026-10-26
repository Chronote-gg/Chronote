import type { StripeInvoice } from "../types/stripe";
import type { OfferUsage } from "../types/offerUsage";
const referenceId = (reference: string | { id: string } | null | undefined) =>
  typeof reference === "string" ? reference : reference?.id;
const invalid = () =>
  new Error("Offer settlement evidence does not match the reserved purchase");

export function assertFirstOfferInvoice(
  invoice: StripeInvoice,
  subscriptionId: string,
  terms: Extract<OfferUsage, { state: "reserved" }>["terms"],
  billingReason:
    "subscription_create" | "subscription_cycle" = "subscription_create",
) {
  if (
    invoice.billing_reason !== billingReason ||
    invoice.lines.has_more ||
    invoice.lines.data.length !== 1 ||
    invoice.discounts.length !== 1 ||
    invoice.total_discount_amounts?.length !== 1 ||
    invoice.subtotal !== terms.regularUnitAmount
  )
    throw invalid();
  const discount = invoice.discounts[0];
  if (
    typeof discount === "string" ||
    discount.source.type !== "coupon" ||
    referenceId(discount.source.coupon) !== terms.couponId
  )
    throw invalid();
  const expectedDiscount = terms.regularUnitAmount - terms.discountedUnitAmount;
  const totalDiscount = invoice.total_discount_amounts[0];
  if (
    totalDiscount.amount !== expectedDiscount ||
    referenceId(totalDiscount.discount) !== discount.id
  )
    throw invalid();
  assertInvoiceLine(
    invoice,
    invoice.lines.data[0],
    subscriptionId,
    terms,
    discount.id,
    expectedDiscount,
  );
}
function assertInvoiceLine(
  invoice: StripeInvoice,
  line: StripeInvoice["lines"]["data"][number],
  subscriptionId: string,
  terms: Extract<OfferUsage, { state: "reserved" }>["terms"],
  discountId: string,
  expectedDiscount: number,
) {
  const parent = line.parent?.subscription_item_details;
  if (
    line.invoice !== invoice.id ||
    line.livemode !== invoice.livemode ||
    line.currency !== terms.currency ||
    line.quantity !== 1 ||
    line.amount !== terms.regularUnitAmount ||
    referenceId(line.pricing?.price_details?.price) !== terms.priceId
  )
    throw invalid();
  if (
    !parent ||
    parent.subscription !== subscriptionId ||
    !parent.subscription_item ||
    parent.proration ||
    !Number.isInteger(line.period.start) ||
    !Number.isInteger(line.period.end) ||
    line.period.end <= line.period.start
  )
    throw invalid();
  assertLineDiscount(line, discountId, expectedDiscount);
}

function assertLineDiscount(
  line: StripeInvoice["lines"]["data"][number],
  discountId: string,
  expectedDiscount: number,
) {
  if (
    line.discount_amounts?.length !== 1 ||
    line.discount_amounts[0].amount !== expectedDiscount ||
    referenceId(line.discount_amounts[0].discount) !== discountId
  )
    throw invalid();
}

function assertRecurringInvoiceItems(
  invoice: StripeInvoice,
  service: StripeInvoice["lines"]["data"][number],
  currency: string,
) {
  for (const line of invoice.lines.data) {
    if (
      line.invoice !== invoice.id ||
      line.livemode !== invoice.livemode ||
      line.currency !== currency
    )
      throw invalid();
    if (line !== service && line.parent?.type !== "invoice_item_details")
      throw invalid();
  }
}
export function assertOfferServiceLine(
  invoice: StripeInvoice,
  subscriptionId: string,
  terms: Extract<OfferUsage, { state: "reserved" }>["terms"],
) {
  if (invoice.lines.has_more) throw invalid();
  const service = invoice.lines.data.filter(
    (line) =>
      referenceId(line.pricing?.price_details?.price) === terms.priceId &&
      line.parent?.subscription_item_details?.subscription === subscriptionId,
  );
  if (service.length !== 1) throw invalid();
  const discountId = referenceId(service[0].discount_amounts?.[0]?.discount);
  const discount = invoice.discounts.find(
    (item) => referenceId(item) === discountId,
  );
  if (
    !discount ||
    typeof discount === "string" ||
    discount.source.type !== "coupon" ||
    referenceId(discount.source.coupon) !== terms.couponId
  )
    throw invalid();
  assertInvoiceLine(
    invoice,
    service[0],
    subscriptionId,
    terms,
    discount.id,
    terms.regularUnitAmount - terms.discountedUnitAmount,
  );
  return service[0];
}

export function assertRecurringOfferInvoice(
  invoice: StripeInvoice,
  subscriptionId: string,
  terms: Extract<OfferUsage, { state: "reserved" }>["terms"],
  billingReason:
    "subscription_cycle" | "subscription_update" = "subscription_cycle",
) {
  if (invoice.billing_reason !== billingReason) throw invalid();
  const line = assertOfferServiceLine(invoice, subscriptionId, terms);
  assertRecurringInvoiceItems(invoice, line, terms.currency);
  return line;
}
