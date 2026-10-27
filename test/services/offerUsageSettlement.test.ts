/** @jest-environment node */
jest.mock("../../src/services/runtimeApiOperationService", () => ({
  runRuntimeApiOperation: jest.requireActual("../fixtures/runtimeApiOperation")
    .runTestApiOperation,
}));
import { classifyHistoricalOfferInvoice } from "../../src/services/historicalOfferEvidence";
import { acceptPurchaseSubscription } from "../../src/services/purchaseReconciliation";
import { getMockStore, resetMockStore } from "../../src/repositories/mockStore";
import { getPurchaseRepository } from "../../src/repositories/purchaseAttemptRepository";
import { getOfferUsageRepository } from "../../src/repositories/offerUsageRepository";
import type { PurchaseAttempt } from "../../src/types/purchase";
import type {
  StripeClient,
  StripeSubscription,
  StripeInvoice,
  StripePrice,
} from "../../src/types/stripe";

const guildId = "111111111111111111";
const createdAt = Date.parse("2026-10-14T12:00:00Z");
async function fixture(annual = false) {
  resetMockStore();
  const offerId = annual ? "basic_annual_intro_v1" : "basic_intro_v1";
  const unitAmount = annual ? 10000 : 1000;
  const paid = annual ? 6000 : 600;
  const operation: PurchaseAttempt = {
    guildId,
    attemptId: "op",
    revision: "op-r1",
    payerId: "payer",
    customerId: "cus",
    mode: "test",
    fingerprint: "terms",
    createdAt,
    state: "open",
    sessionId: "cs",
    checkout: {
      metadata: { intro_offer_id: offerId, intro_offer_coupon_id: "coupon" },
      line_items: [{ price: "price", quantity: 1 }],
      discounts: [{ coupon: "coupon" }],
    },
  };
  const reserved = {
    guildId,
    mode: "test",
    offerId,
    revision: "offer-r1",
    state: "reserved",
    operationId: "op",
    reservedAt: createdAt,
    terms: {
      priceId: "price",
      couponId: "coupon",
      currency: "usd",
      interval: annual ? "year" : "month",
      regularUnitAmount: unitAmount,
      discountedUnitAmount: paid,
      durationMonths: annual ? 12 : 3,
    },
  };
  getMockStore().subscriptions.set(guildId, {
    guildId,
    status: "active",
    tier: "basic",
    subscriptionType: "stripe",
    startDate: "now",
    stripeCustomerId: "cus",
    stripeSubscriptionId: "sub",
    stripeSyncRevision: "sub-r1",
  });
  await getPurchaseRepository().compareAndWrite(
    operation,
    undefined,
    getMockStore().subscriptions.get(guildId),
    undefined,
    { next: reserved, expected: undefined },
  );
  const discount = { id: "di", source: { type: "coupon", coupon: "coupon" } };
  const transitions: Pick<
    StripeInvoice["status_transitions"],
    "paid_at" | "voided_at"
  > = { paid_at: createdAt / 1000 + 1, voided_at: null };
  const invoice = {
    id: "in",
    customer: "cus",
    status: "paid",
    livemode: false,
    currency: "usd",
    billing_reason: "subscription_create",
    parent: { subscription_details: { subscription: "sub" } },
    amount_paid: paid,
    amount_remaining: 0,
    subtotal: unitAmount,
    total_excluding_tax: paid,
    status_transitions: transitions,
    discounts: [discount],
    total_discount_amounts: [{ amount: unitAmount - paid, discount: "di" }],
    lines: {
      has_more: false,
      data: [
        {
          id: "il",
          invoice: "in",
          currency: "usd",
          livemode: false,
          quantity: 1,
          amount: unitAmount,
          subtotal: unitAmount,
          pricing: { price_details: { price: "price" } },
          parent: {
            subscription_item_details: {
              subscription: "sub",
              subscription_item: "si",
              proration: false,
            },
          },
          period: {
            start: createdAt / 1000,
            end: createdAt / 1000 + (annual ? 365 : 31) * 86400,
          },
          discount_amounts: [{ amount: unitAmount - paid, discount: "di" }],
        },
      ],
    },
  };
  const subscription = {
    id: "sub",
    status: "active",
    customer: "cus",
    livemode: false,
    metadata: {
      guild_id: guildId,
      discord_id: "payer",
      purchase_attempt_id: "op",
      intro_offer_id: offerId,
      intro_offer_coupon_id: "coupon",
    },
    latest_invoice: "in",
    discounts: [],
    items: {
      data: [
        {
          id: "si",
          quantity: 1,
          price: {
            id: "price",
            currency: "usd",
            unit_amount: unitAmount,
            recurring: {
              interval: annual ? "year" : "month",
              interval_count: 1,
            },
          },
          current_period_start: createdAt / 1000,
          current_period_end: invoice.lines.data[0].period.end,
        },
      ],
    },
  };
  const stripe = {
    invoices: { retrieve: jest.fn(async () => invoice) },
    checkout: {
      sessions: {
        retrieve: jest.fn(async () => ({
          id: "cs",
          status: "complete",
          customer: "cus",
          livemode: false,
          subscription: "sub",
          invoice: "in",
          metadata: { guild_id: guildId, purchase_attempt_id: "op" },
        })),
      },
    },
  };
  return {
    offerId,
    invoice,
    subscription,
    stripe,
    native: subscription as unknown as StripeSubscription,
    client: stripe as unknown as StripeClient,
    reserved,
  };
}
beforeEach(() => {
  jest.useFakeTimers({ now: createdAt + 5000 });
});
afterEach(() => jest.useRealTimers());

test.each([false, true])(
  "a settled first invoice finalizes only the %s cadence offer once",
  async (annual) => {
    const f = await fixture(annual);
    await acceptPurchaseSubscription(guildId, f.native, f.client);
    const used = await getOfferUsageRepository().get(
      guildId,
      f.offerId,
      "test",
    );
    expect(used).toMatchObject({
      state: "used",
      operationId: "op",
      settlement: {
        invoiceId: "in",
        customerId: "cus",
        subscriptionId: "sub",
        subscriptionItemId: "si",
        amountPaid: annual ? 6000 : 600,
        amountRemaining: 0,
      },
    });
    expect(getMockStore().purchaseAttempts.get(guildId)?.state).toBe(
      "completed",
    );
    f.subscription.latest_invoice = "later-renewal";
    await acceptPurchaseSubscription(guildId, f.native, f.client);
    expect(
      await getOfferUsageRepository().get(guildId, f.offerId, "test"),
    ).toEqual(used);
    expect(
      await getOfferUsageRepository().get(
        guildId,
        annual ? "basic_intro_v1" : "basic_annual_intro_v1",
        "test",
      ),
    ).toBeUndefined();
  },
);

test("a settled credit-covered zero-cash invoice consumes the offer", async () => {
  const f = await fixture();
  f.invoice.amount_paid = 0;
  await acceptPurchaseSubscription(guildId, f.native, f.client);
  expect(
    await getOfferUsageRepository().get(guildId, f.offerId, "test"),
  ).toMatchObject({ state: "used", settlement: { amountPaid: 0 } });
});

test("failed payment leaves use reserved until the same invoice settles", async () => {
  const f = await fixture();
  f.invoice.status = "open";
  f.invoice.amount_paid = 0;
  f.invoice.amount_remaining = 600;
  await acceptPurchaseSubscription(guildId, f.native, f.client);
  expect(
    await getOfferUsageRepository().get(guildId, f.offerId, "test"),
  ).toEqual(f.reserved);
  expect(getMockStore().purchaseAttempts.get(guildId)?.initialInvoiceId).toBe(
    "in",
  );
  f.invoice.status = "paid";
  f.invoice.amount_paid = 600;
  f.invoice.amount_remaining = 0;
  await acceptPurchaseSubscription(guildId, f.native, f.client);
  expect(
    await getOfferUsageRepository().get(guildId, f.offerId, "test"),
  ).toMatchObject({ state: "used" });
});

test.each([
  "customer",
  "subscription",
  "price",
  "coupon",
  "discount",
  "mode",
  "quantity",
  "renewal",
  "proration",
])(
  "rejects mismatched %s invoice evidence without consuming the reserved offer",
  async (change) => {
    const f = await fixture();
    if (change === "customer") f.invoice.customer = "wrong";
    if (change === "subscription")
      f.invoice.parent.subscription_details.subscription = "wrong";
    if (change === "price")
      f.invoice.lines.data[0].pricing.price_details.price = "wrong";
    if (change === "coupon") f.invoice.discounts[0].source.coupon = "wrong";
    if (change === "discount") f.invoice.total_discount_amounts[0].amount = 0;
    if (change === "mode") f.invoice.livemode = true;
    if (change === "quantity") f.invoice.lines.data[0].quantity = 2;
    if (change === "renewal") f.invoice.billing_reason = "subscription_cycle";
    if (change === "proration")
      f.invoice.lines.data[0].parent.subscription_item_details.proration = true;
    await expect(
      acceptPurchaseSubscription(guildId, f.native, f.client),
    ).rejects.toThrow("Offer settlement");
    expect(
      await getOfferUsageRepository().get(guildId, f.offerId, "test"),
    ).toEqual(f.reserved);
  },
);

test.each([false, true])(
  "native inclusive tax first-invoice fields consume the %s offer",
  async (annual) => {
    const f = await fixture(annual);
    f.invoice.total_excluding_tax = annual ? 5607 : 561;
    f.invoice.lines.data[0].subtotal = annual ? 9607 : 961;
    await acceptPurchaseSubscription(guildId, f.native, f.client);
    expect(
      await getOfferUsageRepository().get(guildId, f.offerId, "test"),
    ).toMatchObject({
      state: "used",
      settlement: { amountPaid: annual ? 6000 : 600 },
    });
  },
);
test("a delayed first-payment event consumes the original offer after a later plan change", async () => {
  const f = await fixture();
  f.subscription.latest_invoice = "in-later";
  f.subscription.items.data[0].price.id = "price-pro";
  f.subscription.items.data[0].price.unit_amount = 2400;
  f.subscription.items.data[0].current_period_start += 31 * 86400;
  f.subscription.items.data[0].current_period_end += 31 * 86400;
  await acceptPurchaseSubscription(guildId, f.native, f.client, {
    invoiceId: "in",
  });
  expect(
    await getOfferUsageRepository().get(guildId, f.offerId, "test"),
  ).toMatchObject({
    state: "used",
    settlement: { invoiceId: "in", priceId: "price" },
  });
  expect(getMockStore().purchaseAttempts.get(guildId)?.initialInvoiceId).toBe(
    "in",
  );
});

test("a later renewal recovers the original invoice from its associated completed Checkout", async () => {
  const f = await fixture();
  f.subscription.latest_invoice = "in-renewal";
  f.subscription.items.data[0].current_period_start += 31 * 86400;
  f.subscription.items.data[0].current_period_end += 31 * 86400;
  const renewal = {
    ...f.invoice,
    id: "in-renewal",
    billing_reason: "subscription_cycle",
  };
  f.stripe.invoices.retrieve.mockImplementation(async (id: string) =>
    id === "in-renewal" ? renewal : f.invoice,
  );
  Object.assign(f.stripe, {
    checkout: {
      sessions: {
        retrieve: jest.fn(async () => ({
          id: "cs",
          status: "complete",
          customer: "cus",
          livemode: false,
          subscription: "sub",
          invoice: "in",
          metadata: { guild_id: guildId, purchase_attempt_id: "op" },
        })),
      },
    },
  });
  await acceptPurchaseSubscription(guildId, f.native, f.client, {
    invoiceId: "in-renewal",
  });
  expect(
    await getOfferUsageRepository().get(guildId, f.offerId, "test"),
  ).toMatchObject({
    state: "used",
    settlement: { invoiceId: "in" },
  });
  expect(getMockStore().purchaseAttempts.get(guildId)?.initialInvoiceId).toBe(
    "in",
  );
});

test("a known introductory purchase with missing reservation requires reconciliation", async () => {
  const f = await fixture();
  getMockStore().offerUsages.clear();
  await expect(
    acceptPurchaseSubscription(guildId, f.native, f.client),
  ).rejects.toThrow("Offer settlement");
  expect(getMockStore().purchaseAttempts.get(guildId)?.state).toBe("open");
});

test("the original invoice binding cannot be changed by a retry of the same purchase", async () => {
  const f = await fixture();
  await acceptPurchaseSubscription(guildId, f.native, f.client);
  const repo = getPurchaseRepository();
  const current = (await repo.get(guildId))!;
  await expect(
    repo.compareAndWrite(
      { ...current, revision: "tampered", initialInvoiceId: "in-other" },
      current,
      getMockStore().subscriptions.get(guildId),
    ),
  ).rejects.toThrow("Initial invoice binding");
  expect((await repo.get(guildId))?.initialInvoiceId).toBe("in");
});

async function retiredPurchaseFixture(annual = false) {
  const f = await fixture(annual);
  f.subscription.status = "canceled";
  const store = getMockStore();
  const old = store.purchaseAttempts.get(guildId)!;
  store.purchaseAttempts.set(guildId, {
    ...old,
    state: "completed",
    subscriptionId: "sub",
  });
  const pointer = { ...store.subscriptions.get(guildId)!, status: "canceled" };
  store.subscriptions.set(guildId, pointer);
  const create = jest.fn(async () => {
    const current = store.purchaseAttempts.get(guildId)!;
    return {
      id: "cs-new",
      status: "open",
      url: "https://checkout.stripe.com/new",
      customer: "cus-new",
      livemode: false,
      metadata: { guild_id: guildId, purchase_attempt_id: current.attemptId },
    };
  });
  Object.assign(f.stripe, {
    subscriptions: { retrieve: jest.fn(async () => f.subscription) },
    customers: { create: jest.fn(async () => ({ id: "cus-new" })) },
  });
  Object.assign(f.stripe.checkout.sessions, { create });
  const { createInitialPurchase } =
    await import("../../src/services/initialPurchaseService");
  const purchase = () =>
    createInitialPurchase({
      stripe: f.client,
      user: { id: "payer-new" },
      guildId,
      mode: "test",
      expected: pointer,
      checkout: {
        line_items: [{ price: "price-regular", quantity: 1 }],
        metadata: { guild_id: guildId, discord_id: "payer-new" },
      },
    });
  return { ...f, old, create, purchase };
}

test.each([
  [false, 600],
  [true, 6000],
  [false, 0],
  [true, 0],
] as const)(
  "repurchase settles the original %s offer with %s cash before replacing its purchase record",
  async (annual, cashPaid) => {
    const f = await retiredPurchaseFixture(annual);
    f.invoice.amount_paid = cashPaid;
    await expect(f.purchase()).resolves.toContain("checkout.stripe.com/new");
    expect(getMockStore().purchaseAttempts.get(guildId)?.attemptId).not.toBe(
      "op",
    );
    expect(
      await getOfferUsageRepository().get(guildId, f.offerId, "test"),
    ).toMatchObject({
      state: "used",
      operationId: "op",
      settlement: { invoiceId: "in" },
    });
  },
);

test("unsettled original payment cannot lose its purchase record during repurchase", async () => {
  const f = await retiredPurchaseFixture();
  f.invoice.status = "open";
  f.invoice.amount_paid = 0;
  f.invoice.amount_remaining = 600;
  await expect(f.purchase()).rejects.toMatchObject({
    reason: "purchase_pending",
  });
  expect(getMockStore().purchaseAttempts.get(guildId)?.attemptId).toBe("op");
  expect(
    await getOfferUsageRepository().get(guildId, f.offerId, "test"),
  ).toEqual(f.reserved);
  expect(f.create).not.toHaveBeenCalled();
});

test("a missing original invoice retains its control record during repurchase", async () => {
  const f = await retiredPurchaseFixture();
  f.subscription.latest_invoice = "";
  await expect(f.purchase()).rejects.toMatchObject({
    reason: "purchase_pending",
  });
  expect(getMockStore().purchaseAttempts.get(guildId)?.attemptId).toBe("op");
  expect(f.create).not.toHaveBeenCalled();
});

test("a payer mismatch cannot retire the old offer purchase", async () => {
  const f = await retiredPurchaseFixture();
  f.subscription.metadata.discord_id = "unexpected-payer";
  await expect(f.purchase()).rejects.toMatchObject({
    reason: "purchase_needs_review",
  });
  expect(getMockStore().purchaseAttempts.get(guildId)?.attemptId).toBe("op");
  expect(f.create).not.toHaveBeenCalled();
});

test.each([false, true])(
  "a concurrent revision prevents original settlement or void release (%s)",
  async (voided) => {
    const f = await retiredPurchaseFixture();
    if (voided) {
      f.invoice.status = "void";
      f.invoice.amount_paid = 0;
      f.invoice.amount_remaining = 600;
      f.invoice.status_transitions.paid_at = null;
      f.invoice.status_transitions.voided_at = createdAt / 1000 + 86400;
    }
    const module =
      await import("../../src/repositories/purchaseAttemptRepository");
    const real = module.getPurchaseRepository();
    const spy = jest.spyOn(module, "getPurchaseRepository").mockReturnValue({
      ...real,
      compareAndWrite: async (...args) => {
        const current = getMockStore().purchaseAttempts.get(guildId)!;
        getMockStore().purchaseAttempts.set(guildId, {
          ...current,
          revision: "other-worker",
        });
        return real.compareAndWrite(...args);
      },
    });
    try {
      await expect(f.purchase()).rejects.toMatchObject({
        reason: "purchase_pending",
      });
      expect(getMockStore().purchaseAttempts.get(guildId)?.attemptId).toBe(
        "op",
      );
      expect(
        await getOfferUsageRepository().get(guildId, f.offerId, "test"),
      ).toEqual(f.reserved);
      expect(f.create).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  },
);

test.each([false, true])(
  "a native-voided unpaid %s first invoice releases before repurchase",
  async (annual) => {
    const f = await retiredPurchaseFixture(annual);
    f.subscription.status = "incomplete_expired";
    f.invoice.status = "void";
    f.invoice.amount_paid = 0;
    f.invoice.amount_remaining = annual ? 6000 : 600;
    f.invoice.status_transitions.paid_at = null;
    f.invoice.status_transitions.voided_at = createdAt / 1000 + 86400;
    await expect(f.purchase()).resolves.toContain("checkout.stripe.com/new");
    expect(
      await getOfferUsageRepository().get(guildId, f.offerId, "test"),
    ).toMatchObject({
      state: "unused",
      released: {
        operationId: "op",
        reason: "initial_invoice_voided",
        resourceId: "in",
      },
    });
  },
);

test("uncollectible original invoices retain their owner because payment is still possible", async () => {
  const f = await retiredPurchaseFixture();
  f.invoice.status = "uncollectible";
  f.invoice.amount_paid = 0;
  f.invoice.amount_remaining = 600;
  await expect(f.purchase()).rejects.toMatchObject({
    reason: "purchase_pending",
  });
  expect(getMockStore().purchaseAttempts.get(guildId)?.attemptId).toBe("op");
  expect(f.create).not.toHaveBeenCalled();
});

test("terminal reconciliation cannot reclaim an already released original reservation", async () => {
  const f = await retiredPurchaseFixture();
  f.invoice.status = "void";
  f.invoice.amount_paid = 0;
  f.invoice.amount_remaining = 600;
  f.invoice.status_transitions.paid_at = null;
  f.invoice.status_transitions.voided_at = createdAt / 1000 + 86400;
  await f.purchase();
  const released = await getOfferUsageRepository().get(
    guildId,
    f.offerId,
    "test",
  );
  getMockStore().purchaseAttempts.set(guildId, {
    ...f.old,
    state: "expired",
    subscriptionId: "sub",
    initialInvoiceId: "in",
  });
  await expect(
    acceptPurchaseSubscription(guildId, f.native, f.client),
  ).resolves.toBeUndefined();
  expect(getMockStore().purchaseAttempts.get(guildId)?.state).toBe("expired");
  expect(
    await getOfferUsageRepository().get(guildId, f.offerId, "test"),
  ).toEqual(released);
});

test("void status without a native void timestamp cannot release the original offer", async () => {
  const f = await retiredPurchaseFixture();
  f.invoice.status = "void";
  f.invoice.amount_paid = 0;
  f.invoice.amount_remaining = 600;
  f.invoice.status_transitions.paid_at = null;
  await expect(f.purchase()).rejects.toThrow("Offer settlement evidence");
  expect(getMockStore().purchaseAttempts.get(guildId)?.attemptId).toBe("op");
  expect(f.create).not.toHaveBeenCalled();
});
test.each([false, true])(
  "terminal webhook releases a native-voided original %s offer and preserves replay",
  async (annual) => {
    const f = await fixture(annual);
    f.subscription.status = "incomplete_expired";
    f.invoice.status = "void";
    f.invoice.amount_paid = 0;
    f.invoice.amount_remaining = annual ? 6000 : 600;
    f.invoice.status_transitions.paid_at = null;
    f.invoice.status_transitions.voided_at = createdAt / 1000 + 5;
    await acceptPurchaseSubscription(guildId, f.native, f.client);
    const released = await getOfferUsageRepository().get(
      guildId,
      f.offerId,
      "test",
    );
    expect(released).toMatchObject({
      state: "unused",
      released: { reason: "initial_invoice_voided", resourceId: "in" },
    });
    expect(getMockStore().purchaseAttempts.get(guildId)).toMatchObject({
      state: "expired",
      initialInvoiceId: "in",
    });
    await expect(
      acceptPurchaseSubscription(guildId, f.native, f.client),
    ).resolves.toBeUndefined();
    expect(
      await getOfferUsageRepository().get(guildId, f.offerId, "test"),
    ).toEqual(released);
  },
);

async function historicalFixture(annual = false) {
  const f = await fixture(annual);
  const metadata = { ...f.subscription.metadata };
  const coupon = {
    id: "coupon",
    livemode: false,
    percent_off: 40,
    amount_off: null,
    currency: null,
    duration: annual ? "once" : "repeating",
    duration_in_months: annual ? null : 3,
    valid: false,
    applies_to: { products: ["prod-historical-basic"] },
  };
  const invoice = {
    ...f.invoice,
    created: createdAt / 1000,
    discounts: [
      { ...f.invoice.discounts[0], source: { type: "coupon", coupon } },
    ],
    parent: { subscription_details: { subscription: "sub", metadata } },
  };
  const scope = {
    guildId,
    mode: "test" as const,
    createdBefore: createdAt / 1000 + 10,
    accountId: "acct-owned",
  };
  return {
    ...f,
    invoice,
    metadata,
    coupon,
    scope,
    nativeInvoice: invoice as unknown as StripeInvoice,
    nativePrice: {
      ...f.subscription.items.data[0].price,
      product: "prod-historical-basic",
      livemode: false,
      type: "recurring",
      billing_scheme: "per_unit",
      transform_quantity: null,
      recurring: {
        ...f.subscription.items.data[0].price.recurring,
        usage_type: "licensed",
      },
    } as unknown as StripePrice,
  };
}

test.each([false, true])(
  "historical %s offer uses immutable invoice metadata after current plan changes",
  async (annual) => {
    const f = await historicalFixture(annual);
    f.subscription.metadata.intro_offer_id = "";
    const result = classifyHistoricalOfferInvoice(
      f.nativeInvoice,
      f.nativePrice,
      f.scope,
    );
    expect(result).toMatchObject({
      kind: "settled",
      offerId: f.offerId,
      originalOperationId: "op",
      settlement: { invoiceId: "in", amountPaid: annual ? 6000 : 600 },
    });
    expect(getMockStore().purchaseAttempts.get(guildId)?.state).toBe("open");
  },
);

test("credit-covered historical payment is use even when no cash was collected", async () => {
  const f = await historicalFixture();
  f.invoice.amount_paid = 0;
  expect(
    classifyHistoricalOfferInvoice(f.nativeInvoice, f.nativePrice, f.scope),
  ).toMatchObject({ kind: "settled", settlement: { amountPaid: 0 } });
});

test("ordinary historical payments consume no offer", async () => {
  const f = await historicalFixture();
  f.metadata.intro_offer_id = "";
  f.metadata.intro_offer_coupon_id = "";
  f.invoice.discounts = [];
  f.invoice.total_discount_amounts = [];
  f.invoice.lines.data[0].discount_amounts = [];
  f.invoice.amount_paid = 1000;
  expect(
    classifyHistoricalOfferInvoice(f.nativeInvoice, f.nativePrice, f.scope),
  ).toEqual({ kind: "ordinary" });
});

test("a discounted historical invoice without original offer identity stays unresolved", async () => {
  const f = await historicalFixture();
  f.metadata.intro_offer_id = "";
  f.metadata.intro_offer_coupon_id = "";
  expect(
    classifyHistoricalOfferInvoice(f.nativeInvoice, f.nativePrice, f.scope),
  ).toMatchObject({ kind: "unresolved" });
});

test("historical invoice currency must match its offer even when its line currency matches", async () => {
  const f = await historicalFixture();
  f.invoice.currency = "eur";
  expect(() =>
    classifyHistoricalOfferInvoice(f.nativeInvoice, f.nativePrice, f.scope),
  ).toThrow();
});
test.each(["open", "uncollectible"])(
  "historical %s invoice remains unresolved",
  async (status) => {
    const f = await historicalFixture();
    f.invoice.status = status;
    f.invoice.amount_paid = 0;
    f.invoice.amount_remaining = 600;
    f.invoice.status_transitions.paid_at = null;
    expect(
      classifyHistoricalOfferInvoice(f.nativeInvoice, f.nativePrice, f.scope),
    ).toMatchObject({
      kind: "unresolved",
      offerId: f.offerId,
      invoiceId: "in",
    });
  },
);

test("historical terminal void proves only an unpaid attempt, not server-wide unused history", async () => {
  const f = await historicalFixture();
  f.invoice.status = "void";
  f.invoice.amount_paid = 0;
  f.invoice.amount_remaining = 600;
  f.invoice.status_transitions.paid_at = null;
  f.invoice.status_transitions.voided_at = createdAt / 1000 + 5;
  expect(
    classifyHistoricalOfferInvoice(f.nativeInvoice, f.nativePrice, f.scope),
  ).toMatchObject({ kind: "unpaid_void", offerId: f.offerId, invoiceId: "in" });
});

test.each(["guild", "mode", "cutoff", "price", "coupon"])(
  "historical %s mismatch cannot become imported use",
  async (mismatch) => {
    const f = await historicalFixture();
    if (mismatch === "guild") f.metadata.guild_id = "222222222222222222";
    if (mismatch === "mode") f.invoice.livemode = true;
    if (mismatch === "cutoff") f.scope.createdBefore = createdAt / 1000 - 1;
    if (mismatch === "price") f.invoice.lines.data[0].amount = 999;
    if (mismatch === "coupon") f.metadata.intro_offer_coupon_id = "different";
    expect(() =>
      classifyHistoricalOfferInvoice(f.nativeInvoice, f.nativePrice, f.scope),
    ).toThrow();
  },
);

test("partial historical introductory identity is unresolved, not an ordinary payment", async () => {
  const f = await historicalFixture();
  f.metadata.intro_offer_id = "";
  expect(
    classifyHistoricalOfferInvoice(f.nativeInvoice, f.nativePrice, f.scope),
  ).toMatchObject({ kind: "unresolved", reason: "unsupported_identity" });
});
test("historical use rejects a mismatched original price cadence", async () => {
  const f = await historicalFixture();
  f.nativePrice.recurring!.interval = "year";
  expect(() =>
    classifyHistoricalOfferInvoice(f.nativeInvoice, f.nativePrice, f.scope),
  ).toThrow();
});
test("an archived historical price remains valid evidence for paid offer use", async () => {
  const f = await historicalFixture();
  f.nativePrice.active = false;
  expect(
    classifyHistoricalOfferInvoice(f.nativeInvoice, f.nativePrice, f.scope),
  ).toMatchObject({ kind: "settled" });
});

test.each(["duration", "percentage", "currency", "mode", "product"])(
  "historical %s campaign mismatch cannot become use",
  async (mismatch) => {
    const f = await historicalFixture();
    if (mismatch === "duration") {
      f.coupon.duration = "once";
      f.coupon.duration_in_months = null;
    }
    if (mismatch === "percentage") f.coupon.percent_off = 20;
    if (mismatch === "currency")
      Object.assign(f.coupon, { currency: "eur", amount_off: 400 });
    if (mismatch === "mode") f.coupon.livemode = true;
    if (mismatch === "product") f.coupon.applies_to.products = ["prod-other"];
    expect(() =>
      classifyHistoricalOfferInvoice(f.nativeInvoice, f.nativePrice, f.scope),
    ).toThrow();
  },
);
test("missing expanded historical campaign remains unresolved", async () => {
  const f = await historicalFixture();
  Object.assign(f.invoice.discounts[0].source, { coupon: "coupon" });
  expect(
    classifyHistoricalOfferInvoice(f.nativeInvoice, f.nativePrice, f.scope),
  ).toMatchObject({ kind: "unresolved", reason: "missing_campaign" });
});

test.each([false, true])(
  "historical %s inclusive tax uses gross evidence rather than net subtotal",
  async (annual) => {
    const f = await historicalFixture(annual);
    f.invoice.lines.data[0].subtotal = annual ? 9607 : 961;
    f.invoice.total_excluding_tax = annual ? 5607 : 561;
    expect(
      classifyHistoricalOfferInvoice(f.nativeInvoice, f.nativePrice, f.scope),
    ).toMatchObject({
      kind: "settled",
      settlement: { amountPaid: annual ? 6000 : 600 },
    });
  },
);
test("deleted historical campaign evidence remains unresolved", async () => {
  const f = await historicalFixture();
  Object.assign(f.invoice.discounts[0].source, {
    coupon: { id: "coupon", deleted: true },
  });
  expect(
    classifyHistoricalOfferInvoice(f.nativeInvoice, f.nativePrice, f.scope),
  ).toMatchObject({ kind: "unresolved", reason: "missing_campaign" });
});
test("draft metadata without discounts does not prove ordinary finalized history", async () => {
  const f = await historicalFixture();
  f.invoice.status = "draft";
  f.metadata.intro_offer_id = "";
  f.metadata.intro_offer_coupon_id = "";
  f.invoice.discounts = [];
  f.invoice.total_discount_amounts = [];
  f.invoice.lines.data[0].discount_amounts = [];
  expect(
    classifyHistoricalOfferInvoice(f.nativeInvoice, f.nativePrice, f.scope),
  ).toMatchObject({ kind: "unresolved" });
});

test("truncated historical lines cannot prove an ordinary undiscounted payment", async () => {
  const f = await historicalFixture();
  f.metadata.intro_offer_id = "";
  f.metadata.intro_offer_coupon_id = "";
  f.invoice.discounts = [];
  f.invoice.total_discount_amounts = [];
  f.invoice.lines.data[0].discount_amounts = [];
  f.invoice.lines.has_more = true;
  expect(
    classifyHistoricalOfferInvoice(f.nativeInvoice, f.nativePrice, f.scope),
  ).toMatchObject({ kind: "unresolved" });
});
test("null historical campaign returns unresolved evidence", async () => {
  const f = await historicalFixture();
  Object.assign(f.invoice.discounts[0].source, { coupon: null });
  expect(
    classifyHistoricalOfferInvoice(f.nativeInvoice, f.nativePrice, f.scope),
  ).toMatchObject({ kind: "unresolved", reason: "missing_campaign" });
});
