/** @jest-environment node */
import { classifyChangeHistory } from "../../src/services/billingChangeHistory";
import { readChangedAnnualPayment } from "../../src/services/billingChangePaymentHistory";
import { getMockStore, resetMockStore } from "../../src/repositories/mockStore";
import {
  billingChangeBase,
  billingChangeOperationSchema,
  billingChangeOperationKey,
} from "../../src/types/billingChange";
import { offerUsageKey, offerUsageSchema } from "../../src/types/offerUsage";
import { changeOperation } from "../fixtures/billingChange";
import { fundedInvoice, sourceSubscription } from "../fixtures/renewalStripe";
import { stripeTransport } from "../fixtures/stripeTransport";
import { config } from "../../src/services/configService";
const prior = config.mock.enabled;
beforeEach(() => {
  config.mock.enabled = true;
  resetMockStore();
});
afterEach(() => {
  config.mock.enabled = prior;
});
const operation = billingChangeOperationSchema.parse({
  ...billingChangeBase(changeOperation),
  state: "succeeded",
  draftInvoiceId: "in_owned_funding",
  funding: {
    invoiceId: "in_owned_funding",
    total: 5700,
    amountDue: 5700,
    currency: "usd",
    startingBalance: 0,
    endingBalance: 0,
    serviceValue: 5700,
  },
  target: {
    ...changeOperation.target,
    priceId: "price_basic_annual",
    selection: {
      tier: "basic",
      interval: "year",
      expectedOffer: "basic_annual_intro_v1",
    },
    offer: {
      id: "basic_annual_intro_v1",
      terms: {
        priceId: "price_basic_annual",
        couponId: "co_annual",
        currency: "usd",
        interval: "year",
        regularUnitAmount: 10000,
        discountedUnitAmount: 6000,
        durationMonths: 12,
      },
      authority: {
        guildId: changeOperation.guildId,
        mode: "test",
        offerId: "basic_annual_intro_v1",
        accountId: "acct-owned",
        coverageRevision: "coverage",
        boundaryRevision: "boundary",
        writerImageDigest: "sha256:" + "a".repeat(64),
      },
    },
  },
  scheduleId: null,
  appliedAt: changeOperation.createdAt + 10,
  consent: { at: changeOperation.createdAt + 1, quoteRevision: "review" },
  service: {
    invoiceId: "in_zero_application",
    periodStart: changeOperation.createdAt + 10,
    periodEnd: changeOperation.createdAt + 10 + 365 * 86400,
  },
});
function seed() {
  if (operation.state !== "succeeded" || !operation.target.offer)
    throw new Error("Expected settled offer fixture");
  getMockStore().billingChangeOperations.set(
    billingChangeOperationKey(operation.guildId, operation.operationId),
    structuredClone(operation),
  );
  getMockStore().offerUsages.set(
    offerUsageKey(operation.guildId, operation.target.offer.id, operation.mode),
    offerUsageSchema.parse({
      guildId: operation.guildId,
      mode: operation.mode,
      offerId: operation.target.offer.id,
      state: "used",
      revision: "used",
      operationId: operation.operationId,
      terms: operation.target.offer.terms,
      reservedAt: operation.createdAt * 1000,
      usedAt: operation.appliedAt * 1000,
      settlement: {
        customerId: operation.source.customerId,
        subscriptionId: operation.source.subscriptionId,
        subscriptionItemId: operation.source.itemId,
        invoiceId: "in_owned_funding",
        priceId: operation.target.priceId,
        status: "paid",
        amountPaid: 5700,
        amountRemaining: 0,
        settledAt: operation.appliedAt * 1000,
      },
    }),
  );
}
const invoice = {
  ...fundedInvoice,
  id: "in_owned_funding",
  customer: operation.source.customerId,
  parent: null,
  created: operation.createdAt + 5,
  auto_advance: false,
  total: 5700,
  amount_due: 5700,
  amount_paid: 5700,
  amount_remaining: 0,
  starting_balance: 0,
  metadata: {
    guild_id: operation.guildId,
    chronote_change_operation: operation.operationId,
    chronote_invoice_role: "funding",
  },
};
const scope = {
  guildId: operation.guildId,
  mode: "test" as const,
  accountId: "acct-owned",
  createdBefore: operation.createdAt + 100,
};
it("recognizes an independently funded offer without inventing another initial purchase", async () => {
  seed();
  expect(await classifyChangeHistory(invoice, scope)).toMatchObject({
    kind: "settled",
    offerId: "basic_annual_intro_v1",
    settlement: { amountPaid: 5700, invoiceId: invoice.id },
  });
});
it.each(["missing operation", "other customer", "other mode", "missing usage"])(
  "keeps %s unresolved",
  async (kind) => {
    seed();
    if (kind === "missing operation")
      getMockStore().billingChangeOperations.clear();
    if (kind === "missing usage") getMockStore().offerUsages.clear();
    const native = {
      ...invoice,
      customer: kind === "other customer" ? "cus_foreign" : invoice.customer,
      livemode: kind === "other mode",
    };
    expect(await classifyChangeHistory(native, scope)).toMatchObject({
      kind: "unresolved",
    });
  },
);
it("shows actual annual switch payment and coverage, then stops showing it after renewal", async () => {
  seed();
  if (operation.state !== "succeeded" || !operation.service)
    throw new Error("Expected service fixture");
  const item = {
    ...sourceSubscription.items.data[0],
    price: {
      ...sourceSubscription.items.data[0].price,
      id: operation.target.priceId ?? "",
    },
    current_period_start: operation.service.periodStart,
    current_period_end: operation.service.periodEnd,
  };
  const native = {
    ...sourceSubscription,
    id: operation.source.subscriptionId,
    customer: operation.source.customerId,
    metadata: {
      guild_id: operation.guildId,
      chronote_change_operation: operation.operationId,
    },
    items: { ...sourceSubscription.items, data: [item] },
  };
  const f = stripeTransport(() => invoice);
  expect(await readChangedAnnualPayment(f.stripe, native)).toMatchObject({
    status: "available",
    amountPaid: 5700,
    discountedSubtotal: 6000,
  });
  expect(
    await readChangedAnnualPayment(f.stripe, {
      ...native,
      items: {
        ...native.items,
        data: [{ ...item, current_period_start: item.current_period_end }],
      },
    }),
  ).toBeNull();
});

it.each(["subscription_cycle", "subscription_update"] as const)(
  "shows a paid scheduled annual offer invoice with a separate one-off item: %s",
  async (reason) => {
    seed();
    if (
      operation.state !== "succeeded" ||
      !operation.service ||
      !operation.target.offer
    )
      throw Error("Expected annual offer");
    const scheduled = { ...operation, funding: null };
    getMockStore().billingChangeOperations.set(
      billingChangeOperationKey(operation.guildId, operation.operationId),
      scheduled,
    );
    const terms = operation.target.offer.terms;
    const item = {
      ...sourceSubscription.items.data[0],
      price: { ...sourceSubscription.items.data[0].price, id: terms.priceId },
      current_period_start: operation.service.periodStart,
      current_period_end: operation.service.periodEnd,
    };
    const native = {
      ...sourceSubscription,
      id: operation.source.subscriptionId,
      customer: operation.source.customerId,
      metadata: {
        guild_id: operation.guildId,
        chronote_change_operation: operation.operationId,
      },
      items: { ...sourceSubscription.items, data: [item] },
    };
    const invoiceId = operation.service.invoiceId;
    const service = {
      ...fundedInvoice.lines.data[0],
      invoice: invoiceId,
      amount: 10000,
      quantity: 1,
      period: {
        start: item.current_period_start,
        end: item.current_period_end,
      },
      pricing: { price_details: { price: terms.priceId } },
      discount_amounts: [{ amount: 4000, discount: "di_annual" }],
      parent: {
        type: "subscription_item_details",
        subscription_item_details: {
          subscription: native.id,
          subscription_item: item.id,
          proration: false,
        },
      },
    };
    const oneOff = {
      ...fundedInvoice.lines.data[0],
      invoice: invoiceId,
      amount: 200,
      pricing: null,
      discount_amounts: [],
      parent: {
        type: "invoice_item_details",
        invoice_item_details: { invoice_item: "ii_pending", proration: false },
      },
    };
    const paid = {
      ...fundedInvoice,
      id: invoiceId,
      customer: operation.source.customerId,
      billing_reason: reason,
      total: 6200,
      amount_paid: 6200,
      amount_due: 6200,
      amount_remaining: 0,
      discounts: [
        { id: "di_annual", source: { type: "coupon", coupon: terms.couponId } },
      ],
      lines: { ...fundedInvoice.lines, data: [service, oneOff] },
    };
    const f = stripeTransport(() => paid);
    expect(await readChangedAnnualPayment(f.stripe, native)).toMatchObject({
      status: "available",
      amountPaid: 6200,
      discountedSubtotal: 6000,
    });
  },
);

it.each([
  "empty",
  "paid",
  "open",
  "nonempty",
  "automatic",
  "wrong role",
  "subscription",
])("classifies an abandoned unbound funding draft safely: %s", async (kind) => {
  const canceled = {
    ...billingChangeBase(operation),
    draftInvoiceId: null,
    state: "canceled" as const,
    completedAt: operation.createdAt + 10,
  };
  getMockStore().billingChangeOperations.set(
    billingChangeOperationKey(operation.guildId, operation.operationId),
    billingChangeOperationSchema.parse(canceled),
  );
  const abandoned = {
    ...invoice,
    id: "in_unbound_empty",
    status:
      kind === "paid"
        ? ("paid" as const)
        : kind === "open"
          ? ("open" as const)
          : ("draft" as const),
    total: 0,
    subtotal: 0,
    amount_paid: 0,
    amount_due: 0,
    amount_remaining: 0,
    auto_advance: kind === "automatic",
    parent: kind === "subscription" ? fundedInvoice.parent : null,
    metadata: {
      ...invoice.metadata,
      chronote_invoice_role: kind === "wrong role" ? "other" : "funding",
    },
    lines: {
      ...invoice.lines,
      data: kind === "nonempty" ? invoice.lines.data : [],
    },
  };
  expect(await classifyChangeHistory(abandoned, scope)).toMatchObject({
    kind: kind === "empty" ? "ordinary" : "unresolved",
  });
});

it("settles the owned service item when a one-off item uses the same price first", async () => {
  seed();
  if (!operation.target.offer) throw Error("Expected offer");
  const key = offerUsageKey(
    operation.guildId,
    operation.target.offer.id,
    operation.mode,
  );
  const used = getMockStore().offerUsages.get(key);
  if (used?.state !== "used") throw Error("Expected usage");
  const { usedAt, settlement, ...reserved } = used;
  void usedAt;
  void settlement;
  getMockStore().offerUsages.set(
    key,
    offerUsageSchema.parse({ ...reserved, state: "reserved" }),
  );
  const service = {
    ...fundedInvoice.lines.data[0],
    pricing: {
      ...fundedInvoice.lines.data[0].pricing,
      price_details: {
        price: operation.target.priceId ?? "",
        product: "prod_owned",
      },
    },
    parent: {
      type: "subscription_item_details" as const,
      invoice_item_details: null,
      subscription_item_details: {
        ...fundedInvoice.lines.data[0].parent?.subscription_item_details,
        subscription: operation.source.subscriptionId,
        subscription_item: "si_owned_service",
        invoice_item: null,
        proration: false,
        proration_details: null,
      },
    },
  };
  const oneOff = {
    ...service,
    parent: {
      type: "invoice_item_details" as const,
      subscription_item_details: null,
      invoice_item_details: {
        invoice_item: "ii_owned",
        proration: false,
        proration_details: null,
        subscription: null,
      },
    },
  };
  const { settleChangeOffer } =
    await import("../../src/services/billingChangeTerms");
  const result = await settleChangeOffer(
    { ...operation, timing: "renewal" },
    {
      ...fundedInvoice,
      lines: { ...fundedInvoice.lines, data: [oneOff, service] },
    },
    operation.createdAt + 20,
  );
  expect(result?.next).toMatchObject({
    state: "used",
    settlement: { subscriptionItemId: "si_owned_service" },
  });
});
