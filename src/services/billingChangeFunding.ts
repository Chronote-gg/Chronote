import type { StripeEffect } from "../types/stripe";
import type {
  StripeClient,
  StripeInvoice,
  StripeSubscription,
} from "../types/stripe";
import type {
  BillingChangeOperation,
  BillingChangeFunding,
} from "../types/billingChange";
import { stripeId, changeUnavailable } from "./billingChangeProvider";

export const changeIdempotency = (
  operation: BillingChangeOperation,
  step: string,
) => ({
  idempotencyKey: `chronote_change_${operation.mode}_${operation.operationId}_${step}`,
});
export const changeMetadata = (operation: BillingChangeOperation) => ({
  guild_id: operation.guildId,
  chronote_change_operation: operation.operationId,
  chronote_change_offer_id: operation.target.offer?.id ?? "",
  chronote_change_coupon_id: operation.target.offer?.terms.couponId ?? "",
});
export function assertFundingOwner(
  invoice: StripeInvoice,
  operation: BillingChangeOperation,
) {
  if (
    stripeId(invoice.customer) !== operation.source.customerId ||
    invoice.livemode !== (operation.mode === "live") ||
    invoice.currency !== operation.target.currency ||
    invoice.metadata?.chronote_change_operation !== operation.operationId ||
    invoice.metadata.guild_id !== operation.guildId ||
    invoice.metadata.chronote_invoice_role !== "funding" ||
    invoice.parent?.subscription_details ||
    invoice.auto_advance
  )
    throw changeUnavailable();
}
export async function createChangeFundingDraft(input: {
  stripe: StripeClient;
  effect?: StripeEffect;
  operation: BillingChangeOperation;
  subscription: StripeSubscription;
}) {
  const { stripe, operation, subscription } = input;
  const write: StripeEffect = input.effect ?? ((run) => run());
  const invoice = await write(() =>
    stripe.invoices.create(
      {
        customer: operation.source.customerId,
        auto_advance: false,
        collection_method: "charge_automatically",
        pending_invoice_items_behavior: "exclude",
        discounts: "",
        ...(subscription.automatic_tax.enabled
          ? { automatic_tax: { enabled: true } }
          : { default_tax_rates: operation.source.taxRateIds }),
        default_payment_method: stripeId(subscription.default_payment_method),
        metadata: {
          ...changeMetadata(operation),
          chronote_invoice_role: "funding",
        },
        description: "Chronote plan change",
      },
      changeIdempotency(operation, "funding-draft"),
    ),
  );
  assertFundingOwner(invoice, operation);
  if (invoice.status !== "draft") throw changeUnavailable();
  return invoice.id;
}
async function completeFundingDraft(
  input: {
    stripe: StripeClient;
    effect?: StripeEffect;
    operation: BillingChangeOperation;
    subscription: StripeSubscription;
  },
  invoice: StripeInvoice,
) {
  const { stripe, operation } = input;
  const write: StripeEffect = input.effect ?? ((run) => run());
  if (invoice.status === "draft") {
    const parts = [
      {
        role: "target-service",
        amount: operation.quote.planCharge - operation.quote.offerSavings,
        description: operation.quote.chargeLabel,
        productId: operation.target.productId,
        taxBehavior: operation.target.taxBehavior,
      },
      {
        role: "unused-service",
        amount: -operation.quote.unusedCredit,
        description: operation.quote.creditLabel,
        productId: operation.source.productId,
        taxBehavior: operation.source.taxBehavior,
      },
    ].filter((part) => part.amount !== 0);
    for (const part of parts) {
      const existing = invoice.lines.data.filter(
        (line) => line.metadata?.chronote_change_part === part.role,
      );
      if (
        existing.length > 1 ||
        existing.some((line) => line.amount !== part.amount)
      )
        throw changeUnavailable();
      let taxCode: string | undefined;
      if (part.amount < 0 && input.subscription.automatic_tax.enabled) {
        const product = await stripe.products.retrieve(
          part.productId ?? operation.source.productId,
        );
        if (product.deleted) throw changeUnavailable();
        taxCode = stripeId(product.tax_code);
      }
      if (!existing.length)
        await write(() =>
          stripe.invoiceItems.create(
            {
              customer: operation.source.customerId,
              invoice: invoice.id,
              ...(part.amount < 0
                ? {
                    amount: part.amount,
                    currency: operation.target.currency,
                    tax_behavior: part.taxBehavior,
                    ...(taxCode ? { tax_code: taxCode } : {}),
                  }
                : {
                    price_data: {
                      currency: operation.target.currency,
                      product: part.productId ?? operation.source.productId,
                      unit_amount: part.amount,
                      tax_behavior: part.taxBehavior,
                    },
                  }),
              ...(input.subscription.automatic_tax.enabled
                ? {}
                : { tax_rates: operation.source.taxRateIds }),
              discountable: false,
              description: part.description,
              metadata: {
                ...changeMetadata(operation),
                chronote_change_part: part.role,
              },
            },
            changeIdempotency(operation, `funding-${part.role}`),
          ),
        );
    }
    invoice = await write(() =>
      stripe.invoices.finalizeInvoice(
        invoice.id,
        { auto_advance: false },
        changeIdempotency(operation, "funding-finalize"),
      ),
    );
  }
  return invoice;
}

export async function finalizeChangeFunding(input: {
  stripe: StripeClient;
  effect?: StripeEffect;
  operation: BillingChangeOperation;
  subscription: StripeSubscription;
}) {
  const { stripe, operation } = input;
  if (!operation.draftInvoiceId) throw changeUnavailable();
  let invoice: StripeInvoice = await stripe.invoices.retrieve(
    operation.draftInvoiceId,
  );
  assertFundingOwner(invoice, operation);
  if (invoice.lines.has_more) throw changeUnavailable();
  invoice = await completeFundingDraft(input, invoice);
  assertFundingOwner(invoice, operation);
  if (invoice.status !== "open" && invoice.status !== "paid")
    throw changeUnavailable();
  assertFundingLines(invoice, operation);
  const taxAmount = (invoice.total_taxes ?? []).reduce(
    (sum, tax) => sum + tax.amount,
    0,
  );
  const funding: BillingChangeFunding = {
    invoiceId: invoice.id,
    total: invoice.total,
    amountDue: invoice.amount_due,
    currency: invoice.currency,
    startingBalance: invoice.starting_balance,
    endingBalance: invoice.ending_balance ?? 0,
    serviceValue: invoice.total,
    targetServiceValue: targetFundedValue(invoice, operation),
  };
  return {
    funding,
    quote: {
      ...operation.quote,
      amountDue: funding.amountDue,
      taxAmount,
      billingBalance:
        invoice.total > 0
          ? invoice.amount_due +
            Math.max(0, invoice.ending_balance ?? 0) -
            invoice.total
          : Math.max(0, invoice.starting_balance),
      balanceCarriedForward: Math.max(0, invoice.ending_balance ?? 0),
      remainingCredit: Math.max(0, -(invoice.ending_balance ?? 0)),
    },
  };
}

function targetFundedValue(
  invoice: StripeInvoice,
  operation: BillingChangeOperation,
) {
  const lines = invoice.lines.data.filter(
    (line) => line.metadata?.chronote_change_part === "target-service",
  );
  if (lines.length === 1)
    return (
      lines[0].amount +
      (lines[0].taxes ?? []).reduce(
        (sum, tax) => sum + (tax.tax_behavior === "exclusive" ? tax.amount : 0),
        0,
      )
    );
  const expected = operation.quote.planCharge - operation.quote.offerSavings;
  if (
    !lines.length &&
    (expected === 0 || operation.target.taxBehavior === "inclusive")
  )
    return expected;
  throw changeUnavailable();
}

function assertFundingLines(
  invoice: StripeInvoice,
  operation: BillingChangeOperation,
) {
  const expected = new Map<string, number>(
    (
      [
        [
          "target-service",
          operation.quote.planCharge - operation.quote.offerSavings,
        ],
        ["unused-service", -operation.quote.unusedCredit],
      ] satisfies [string, number][]
    ).filter(([, amount]) => amount !== 0),
  );
  if (
    invoice.lines.has_more ||
    invoice.lines.data.length !== expected.size ||
    invoice.discounts.length ||
    invoice.subtotal !==
      operation.quote.planCharge -
        operation.quote.offerSavings -
        operation.quote.unusedCredit
  )
    throw changeUnavailable();
  for (const line of invoice.lines.data) {
    const role = line.metadata?.chronote_change_part;
    if (
      !role ||
      line.amount !== expected.get(role) ||
      line.currency !== operation.target.currency ||
      line.discount_amounts?.length
    )
      throw changeUnavailable();
    expected.delete(role);
  }
  if (expected.size) throw changeUnavailable();
}

export function verifyChangeFunding(
  invoice: StripeInvoice,
  operation: BillingChangeOperation,
  funding: BillingChangeFunding,
): boolean {
  try {
    assertFundingOwner(invoice, operation);
  } catch {
    return false;
  }
  return (
    invoice.id === funding.invoiceId &&
    invoice.total === funding.total &&
    invoice.amount_due === funding.amountDue &&
    invoice.currency === funding.currency &&
    invoice.starting_balance === funding.startingBalance &&
    invoice.status === "paid" &&
    invoice.amount_remaining === 0 &&
    invoice.amount_paid === funding.amountDue &&
    invoice.pre_payment_credit_notes_amount === 0 &&
    invoice.post_payment_credit_notes_amount === 0
  );
}
