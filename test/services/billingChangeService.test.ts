/** @jest-environment node */
jest.mock("../../src/services/runtimeApiOperationService", () => ({
  runRuntimeApiOperation: jest.requireActual("../fixtures/runtimeApiOperation")
    .runTestApiOperation,
}));
import * as fundingRecovery from "../../src/services/billingChangeRecovery";
import * as reconciliation from "../../src/services/subscriptionReconciliation";
import { changeSourceFingerprint } from "../../src/services/billingChangeProvider";
import * as renewalRecovery from "../../src/services/renewalRecoveryService";
import * as scheduling from "../../src/services/billingChangeSchedule";
import {
  readBillingChange,
  confirmBillingChange,
  prepareBillingChange,
  cancelBillingChange,
} from "../../src/services/billingChangeService";
import { getBillingChangeRepository } from "../../src/repositories/billingChangeRepository";
import { billingChangeBase } from "../../src/types/billingChange";
import { changeOperation, changePointer } from "../fixtures/billingChange";
import { getMockStore, resetMockStore } from "../../src/repositories/mockStore";
import { config } from "../../src/services/configService";
import {
  sourceSubscription,
  fundedInvoice,
  remainingDiscount,
} from "../fixtures/renewalStripe";
import { renewalPayerId, renewalSubscription } from "../fixtures/renewal";
import { renewalStripeClientFixture } from "../fixtures/renewalStripeClient";
import { stripeTransport } from "../fixtures/stripeTransport";
const previous = {
  mock: config.mock.enabled,
  enabled: config.stripe.subscriptionTransitionsEnabled,
};
beforeEach(() => {
  config.mock.enabled = true;
  config.stripe.subscriptionTransitionsEnabled = false;
  resetMockStore();
  getMockStore().subscriptions.set(
    changeOperation.guildId,
    structuredClone(changePointer),
  );
});
afterEach(() => {
  config.mock.enabled = previous.mock;
  config.stripe.subscriptionTransitionsEnabled = previous.enabled;
});
function seedReview(amountDue = 0) {
  const operation = {
    ...billingChangeBase(changeOperation),
    state: "review" as const,
    funding: {
      invoiceId: "in_funding",
      total: 900,
      amountDue,
      currency: "usd",
      startingBalance: -900,
      endingBalance: 0,
      serviceValue: 900,
    },
  };
  getMockStore().billingChangeOperations.set(
    `CHANGE_OP#${operation.guildId}#${operation.operationId}`,
    operation,
  );
  getMockStore().billingChangeControls.set(
    `CHANGE_CONTROL#${operation.guildId}`,
    { operationId: operation.operationId },
  );
  return operation;
}
it("keeps new changes gated without touching Stripe", async () => {
  const f = stripeTransport(() => {
    throw new Error("Unexpected Stripe request");
  });
  const context = {
    stripe: f.stripe,
    guildId: changeOperation.guildId,
    payerId: changeOperation.payerId,
  };
  expect(await readBillingChange(context)).toEqual({
    kind: "none",
    enabled: false,
  });
  await expect(
    prepareBillingChange({
      ...context,
      selection: { tier: "pro", interval: "month", expectedOffer: "none" },
    }),
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  expect(f.requests).toHaveLength(0);
});
it("does not expose another payer's pending invoice", async () => {
  const operation = seedReview(900);
  const f = stripeTransport(() => {
    throw new Error("Unexpected Stripe request");
  });
  await expect(
    readBillingChange({
      stripe: f.stripe,
      guildId: operation.guildId,
      payerId: "another-payer",
    }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect(f.requests).toHaveLength(0);
});
it("rejects stale approval before provider mutation", async () => {
  const operation = seedReview();
  const f = stripeTransport(() => {
    throw new Error("Unexpected Stripe request");
  });
  await expect(
    confirmBillingChange({
      stripe: f.stripe,
      guildId: operation.guildId,
      payerId: operation.payerId,
      operationId: operation.operationId,
      revision: "stale",
      now: operation.createdAt,
    }),
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  expect(
    (
      await getBillingChangeRepository().getOperation(
        operation.guildId,
        operation.operationId,
      )
    )?.state,
  ).toBe("review");
  expect(f.requests).toHaveLength(0);
});
it("does not apply a zero-cash invoice before explicit confirmation", async () => {
  const operation = seedReview();
  const f = stripeTransport(() => {
    throw new Error("Unexpected Stripe request");
  });
  const view = await readBillingChange({
    stripe: f.stripe,
    guildId: operation.guildId,
    payerId: operation.payerId,
    now: operation.createdAt,
  });
  expect(view).toMatchObject({
    kind: "operation",
    state: "review",
    paymentUrl: null,
  });
  expect(f.requests).toHaveLength(0);
});

it("keeps Basic through review and incomplete payment, then applies one settled upgrade and survives replay", async () => {
  config.stripe.subscriptionTransitionsEnabled = true;
  const guildId = changeOperation.guildId;
  getMockStore().subscriptions.set(guildId, {
    ...renewalSubscription,
    stripeCustomerId: "cus_renewal",
  });
  const baseline = renewalStripeClientFixture();
  const customer = await baseline.stripe.customers.retrieve("cus_renewal");
  if (customer.deleted) throw new Error("Expected full customer fixture");
  const baseItem = sourceSubscription.items.data[0];
  const basic = { ...baseItem.price, tax_behavior: "inclusive" as const };
  const pro = {
    ...basic,
    id: "price_pro_monthly",
    unit_amount: 2400,
    lookup_key: "chronote_pro_monthly",
  };
  let provider = {
    ...sourceSubscription,
    cancel_at: null,
    cancel_at_period_end: false,
    items: {
      ...sourceSubscription.items,
      data: [{ ...baseItem, price: basic }],
    },
    discounts: [remainingDiscount],
  };
  const now = Math.floor(
    (baseItem.current_period_start + baseItem.current_period_end) / 2,
  );
  const credit = {
    ...fundedInvoice.lines.data[0],
    id: "il_credit",
    amount: -300,
    parent: {
      ...fundedInvoice.lines.data[0].parent,
      type: "subscription_item_details" as const,
      invoice_item_details: null,
      subscription_item_details: {
        invoice_item: null,
        subscription: "sub_renewal",
        subscription_item: baseItem.id,
        proration: true,
        proration_details: { credited_items: null },
      },
    },
  };
  const debit = {
    ...credit,
    id: "il_debit",
    amount: 1200,
    pricing: {
      ...credit.pricing,
      type: "price_details" as const,
      price_details: { price: pro.id, product: "prod_renewal" },
      unit_amount_decimal: credit.pricing?.unit_amount_decimal ?? null,
    },
  };
  let funding = {
    ...fundedInvoice,
    id: "in_change",
    parent: null,
    customer: "cus_renewal",
    status: "draft" as const,
    auto_advance: false,
    total: 900,
    amount_due: 900,
    amount_remaining: 900,
    amount_paid: 0,
    starting_balance: 0,
    ending_balance: 0,
    metadata: {} as Record<string, string>,
    lines: {
      ...fundedInvoice.lines,
      data: [] as typeof fundedInvoice.lines.data,
    },
  };
  let fundingPaid = false;
  let fundingFinalized = false;
  const application = {
    ...fundedInvoice,
    id: "in_application",
    lines: {
      ...fundedInvoice.lines,
      data: [
        { ...debit, period: { start: now, end: baseItem.current_period_end } },
      ],
    },
    total: 0,
    amount_due: 0,
    amount_remaining: 0,
    amount_paid: 0,
  };
  function fundingWrite(path: string, method: string, fields: URLSearchParams) {
    if (path === "/v1/invoices" && method === "POST") {
      funding = {
        ...funding,
        metadata: {
          guild_id: guildId,
          chronote_change_operation:
            fields.get("metadata[chronote_change_operation]") ?? "",
          chronote_invoice_role: "funding",
        },
      };
      return funding;
    }
    if (path === "/v1/invoiceitems")
      return { id: "ii_owned", object: "invoiceitem" };
    if (path === "/v1/invoices/in_change/finalize") {
      fundingFinalized = true;
      funding = {
        ...funding,
        subtotal: 900,
        lines: {
          ...funding.lines,
          data: [
            {
              ...fundedInvoice.lines.data[0],
              amount: 1200,
              discount_amounts: [],
              metadata: { chronote_change_part: "target-service" },
            },
            {
              ...fundedInvoice.lines.data[0],
              amount: -300,
              discount_amounts: [],
              metadata: { chronote_change_part: "unused-service" },
            },
          ],
        },
      };
      return {
        ...funding,
        status: "open",
        hosted_invoice_url: "https://invoice.stripe.com/i/fixture",
      };
    }
    return undefined;
  }
  const f = stripeTransport(({ path, method, fields }) => {
    if (path === "/v1/customers/cus_renewal") return customer;
    if (path === "/v1/subscriptions/sub_renewal" && method === "GET")
      return provider;
    if (path === "/v1/prices")
      return { object: "list", data: [basic, pro], has_more: false };
    if (path === "/v1/prices/price_pro_monthly") return pro;
    if (path === "/v1/invoices/in_funded")
      return {
        ...fundedInvoice,
        total: 600,
        amount_due: 600,
        amount_paid: 600,
        lines: {
          ...fundedInvoice.lines,
          data: [
            {
              ...fundedInvoice.lines.data[0],
              discount_amounts: [
                { amount: 400, discount: remainingDiscount.id },
              ],
            },
          ],
        },
      };
    if (path === "/v1/invoices/create_preview")
      return {
        ...fundedInvoice,
        total: 900,
        amount_due: 900,
        amount_paid: 0,
        lines: { ...fundedInvoice.lines, data: [credit, debit] },
      };
    const createdFunding = fundingWrite(path, method, fields);
    if (createdFunding) return createdFunding;
    if (path === "/v1/invoices/in_change")
      return {
        ...funding,
        status: fundingPaid ? "paid" : fundingFinalized ? "open" : "draft",
        amount_paid: fundingPaid ? 900 : 0,
        amount_remaining: fundingPaid ? 0 : 900,
        hosted_invoice_url: "https://invoice.stripe.com/i/fixture",
      };
    if (path === "/v1/subscriptions/sub_renewal" && method === "POST") {
      expect(fields.get("discounts")).toBe("");
      expect(fields.get("items[0][price]")).toBe(pro.id);
      expect(fields.get("add_invoice_items[0][price_data][unit_amount]")).toBe(
        "-900",
      );
      provider = {
        ...provider,
        items: {
          ...provider.items,
          data: [{ ...provider.items.data[0], price: pro }],
        },
        discounts: [],
        latest_invoice: "in_application",
        metadata: {
          ...provider.metadata,
          chronote_change_operation: funding.metadata.chronote_change_operation,
        },
      };
      return provider;
    }
    if (path === "/v1/invoices/in_application") return application;
    throw new Error(`Unexpected ${method} ${path}`);
  });
  const context = { stripe: f.stripe, guildId, payerId: renewalPayerId, now };
  const review = await prepareBillingChange({
    ...context,
    selection: { tier: "pro", interval: "month", expectedOffer: "none" },
  });
  expect(review).toMatchObject({
    kind: "operation",
    state: "review",
    paymentUrl: null,
    quote: { amountDue: 900, unusedCredit: 300, planCharge: 1200 },
  });
  expect(provider.items.data[0].price.id).toBe(basic.id);
  if (review.kind !== "operation") throw new Error("Expected review");
  const accepted = await confirmBillingChange({
    ...context,
    operationId: review.operationId,
    revision: review.revision,
  });
  expect(accepted).toMatchObject({
    state: "accepted",
    paymentUrl: "https://invoice.stripe.com/i/fixture",
  });
  expect(provider.items.data[0].price.id).toBe(basic.id);
  expect(await readBillingChange(context)).toMatchObject({ state: "accepted" });
  fundingPaid = true;
  expect(await readBillingChange(context)).toMatchObject({
    state: "succeeded",
  });
  expect(getMockStore().subscriptions.get(guildId)).toMatchObject({
    tier: "pro",
    stripeSubscriptionId: "sub_renewal",
  });
  expect(await readBillingChange(context)).toEqual({
    kind: "none",
    enabled: true,
  });
  expect(
    f.requests.filter(
      (request) =>
        request.path === "/v1/subscriptions/sub_renewal" &&
        request.method === "POST",
    ),
  ).toHaveLength(1);
  expect(f.requests.some((request) => request.path.endsWith("/pay"))).toBe(
    false,
  );
  expect(baseline.update).not.toHaveBeenCalled();
  jest.restoreAllMocks();
});

it("finishes accepted schedule creation before cancellation releases control", async () => {
  const watch = jest.spyOn(renewalRecovery, "trackPaidRenewalPeriod");
  const review = seedReview();
  const operation = {
    ...billingChangeBase(review),
    timing: "renewal" as const,
    state: "accepted" as const,
    funding: null,
    consent: { at: review.createdAt, quoteRevision: review.revision },
  };
  getMockStore().billingChangeOperations.set(
    `CHANGE_OP#${operation.guildId}#${operation.operationId}`,
    operation,
  );
  const baseline = renewalStripeClientFixture();
  const customer = await baseline.stripe.customers.retrieve("cus_renewal");
  if (customer.deleted) throw Error("Expected customer");
  const f = stripeTransport(({ path }) => {
    if (path.includes("customers"))
      return {
        ...customer,
        id: operation.source.customerId,
        metadata: { discord_id: operation.payerId },
      };
    if (path === `/v1/invoices/${fundedInvoice.id}`) return fundedInvoice;
    if (path.includes("subscriptions"))
      return { ...sourceSubscription, schedule: null };
    throw Error(`Unexpected ${path}`);
  });
  let finishCreation: (id: string) => void = () => undefined;
  let started: () => void = () => undefined;
  const creationStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const creationResult = new Promise<string>((resolve) => {
    finishCreation = resolve;
  });
  const creation = jest
    .spyOn(scheduling, "scheduleBillingChange")
    .mockImplementationOnce(() => {
      started();
      return creationResult;
    })
    .mockRejectedValue(Error("Creation still pending"));
  const settlement = jest
    .spyOn(scheduling, "readScheduledChangeSettlement")
    .mockResolvedValue({ kind: "waiting" });
  const originalRead = readBillingChange({
    stripe: f.stripe,
    guildId: operation.guildId,
    payerId: operation.payerId,
    now: operation.createdAt,
  });
  await creationStarted;
  expect(watch.mock.calls[0][0].owner?.effect).toBe(creation.mock.calls[0][3]);
  expect(watch.mock.calls[0][0].owner).toBeDefined();
  await expect(
    cancelBillingChange({
      stripe: f.stripe,
      guildId: operation.guildId,
      payerId: operation.payerId,
      operationId: operation.operationId,
      now: operation.createdAt,
    }),
  ).rejects.toThrow("Creation still pending");
  expect(creation).toHaveBeenCalled();
  expect(
    (
      await getBillingChangeRepository().getOperation(
        operation.guildId,
        operation.operationId,
      )
    )?.state,
  ).toBe("accepted");
  expect(
    await getBillingChangeRepository().getControl(operation.guildId),
  ).toBeDefined();
  finishCreation("sub_sched_owned");
  await expect(originalRead).resolves.toMatchObject({ state: "scheduled" });
  expect(creation).toHaveBeenCalledTimes(2);
  settlement.mockRestore();
  creation.mockRestore();
  watch.mockRestore();
});

it("releases an unexpired review after its subscription has become terminal", async () => {
  const seeded = seedReview();
  const operation = { ...seeded, timing: "renewal" as const, funding: null };
  getMockStore().billingChangeOperations.set(
    `CHANGE_OP#${operation.guildId}#${operation.operationId}`,
    operation,
  );
  getMockStore().subscriptions.set(operation.guildId, {
    ...changePointer,
    status: "canceled",
    tier: "free",
  });
  const baseline = renewalStripeClientFixture();
  const customer = await baseline.stripe.customers.retrieve("cus_renewal");
  if (customer.deleted) throw Error("Expected customer");
  const f = stripeTransport(({ path }) => {
    if (path.includes("customers"))
      return {
        ...customer,
        id: operation.source.customerId,
        metadata: { discord_id: operation.payerId },
      };
    if (path.includes("subscriptions"))
      return {
        ...sourceSubscription,
        id: operation.source.subscriptionId,
        customer: operation.source.customerId,
        metadata: { guild_id: operation.guildId },
        status: "canceled",
      };
    throw Error(`Unexpected ${path}`);
  });
  const result = await readBillingChange({
    stripe: f.stripe,
    guildId: operation.guildId,
    payerId: operation.payerId,
    now: operation.createdAt,
  });
  expect(result).toMatchObject({ state: "canceled" });
  expect(
    await getBillingChangeRepository().getControl(operation.guildId),
  ).toBeUndefined();
});

it.each(["expired", "terminal"] as const)(
  "recovers a claimed preparing operation with an %s source without trapping its control",
  async (kind) => {
    const f = renewalStripeClientFixture();
    const now = f.provider.items.data[0].current_period_start + 100;
    const preparing = {
      ...changeOperation,
      payerId: renewalPayerId,
      createdAt: kind === "expired" ? now - 86400 : now,
      expiresAt: kind === "expired" ? now - 85800 : now + 600,
      source: {
        ...changeOperation.source,
        fingerprint: changeSourceFingerprint(f.provider),
        customerId: "cus_renewal",
        subscriptionId: f.provider.id,
        periodStart: f.provider.items.data[0].current_period_start,
        periodEnd: f.provider.items.data[0].current_period_end,
        at: now,
      },
    };
    getMockStore().subscriptions.set(preparing.guildId, {
      ...changePointer,
      stripeCustomerId: "cus_renewal",
      stripeSubscriptionId: f.provider.id,
    });
    getMockStore().billingChangeOperations.set(
      `CHANGE_OP#${preparing.guildId}#${preparing.operationId}`,
      preparing,
    );
    getMockStore().billingChangeControls.set(
      `CHANGE_CONTROL#${preparing.guildId}`,
      { operationId: preparing.operationId },
    );
    if (kind === "terminal") f.provider = { ...f.provider, status: "canceled" };
    const result = await readBillingChange({
      stripe: f.stripe,
      guildId: preparing.guildId,
      payerId: renewalPayerId,
      now,
    });
    expect(result).toMatchObject({ state: "canceled" });
    expect(
      await getBillingChangeRepository().getControl(preparing.guildId),
    ).toBeUndefined();
    expect(f.update).not.toHaveBeenCalled();
  },
);

it("retains terminal work until entitlement reconciliation succeeds, without repeating payment", async () => {
  const operation = {
    ...billingChangeBase(changeOperation),
    state: "succeeded" as const,
    funding: null,
    scheduleId: null,
    appliedAt: changeOperation.createdAt,
    consent: { at: changeOperation.createdAt, quoteRevision: "approved" },
  };
  getMockStore().billingChangeOperations.set(
    `CHANGE_OP#${operation.guildId}#${operation.operationId}`,
    operation,
  );
  getMockStore().billingChangeControls.set(
    `CHANGE_CONTROL#${operation.guildId}`,
    { operationId: operation.operationId },
  );
  const reconcile = jest
    .spyOn(reconciliation, "reconcileSubscription")
    .mockRejectedValueOnce(new Error("pointer write unavailable"))
    .mockResolvedValue(undefined);
  const f = stripeTransport(() => {
    throw new Error("Unexpected payment request");
  });
  const context = {
    stripe: f.stripe,
    guildId: operation.guildId,
    payerId: operation.payerId,
    now: operation.createdAt,
  };
  try {
    await expect(readBillingChange(context)).rejects.toThrow(
      "pointer write unavailable",
    );
    expect(
      await getBillingChangeRepository().getControl(operation.guildId),
    ).toBeDefined();
    expect(await readBillingChange(context)).toMatchObject({
      state: "succeeded",
    });
    expect(
      await getBillingChangeRepository().getControl(operation.guildId),
    ).toBeUndefined();
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(f.requests).toHaveLength(0);
  } finally {
    reconcile.mockRestore();
  }
});

it.each(["canceled", "incomplete_expired"] as const)(
  "releases accepted unscheduled consent after verified %s source, before the saved projection catches up",
  async (status) => {
    const seeded = seedReview();
    const operation = {
      ...billingChangeBase(seeded),
      state: "accepted" as const,
      timing: "renewal" as const,
      funding: null,
      consent: { at: seeded.createdAt, quoteRevision: seeded.revision },
    };
    getMockStore().billingChangeOperations.set(
      `CHANGE_OP#${operation.guildId}#${operation.operationId}`,
      operation,
    );
    const baseline = renewalStripeClientFixture();
    const customer = await baseline.stripe.customers.retrieve("cus_renewal");
    if (customer.deleted) throw new Error("Expected customer");
    const native = {
      ...sourceSubscription,
      id: operation.source.subscriptionId,
      customer: operation.source.customerId,
      status,
      schedule: null,
      metadata: { guild_id: operation.guildId, discord_id: operation.payerId },
    };
    const f = stripeTransport(({ path }) => {
      if (path.includes("customers"))
        return {
          ...customer,
          id: operation.source.customerId,
          metadata: { discord_id: operation.payerId },
        };
      if (path.includes("subscriptions")) return native;
      throw new Error(`Unexpected ${path}`);
    });
    expect(
      await readBillingChange({
        stripe: f.stripe,
        guildId: operation.guildId,
        payerId: operation.payerId,
        now: operation.createdAt,
      }),
    ).toMatchObject({ state: "canceled" });
    expect(
      await getBillingChangeRepository().getControl(operation.guildId),
    ).toBeUndefined();
    expect(f.requests.every((request) => request.method === "GET")).toBe(true);
  },
);

it.each(["rolled_forward", "at_boundary"] as const)(
  "releases accepted unscheduled consent after %s source expiry without scheduling stale terms",
  async (status) => {
    const seeded = seedReview();
    const operation = {
      ...billingChangeBase(seeded),
      state: "accepted" as const,
      timing: "renewal" as const,
      funding: null,
      consent: { at: seeded.createdAt, quoteRevision: seeded.revision },
    };
    getMockStore().billingChangeOperations.set(
      `CHANGE_OP#${operation.guildId}#${operation.operationId}`,
      operation,
    );
    const baseline = renewalStripeClientFixture();
    const customer = await baseline.stripe.customers.retrieve("cus_renewal");
    if (customer.deleted) throw new Error("Expected customer");
    const native = {
      ...sourceSubscription,
      id: operation.source.subscriptionId,
      customer: operation.source.customerId,
      status: "active" as const,
      items: {
        ...sourceSubscription.items,
        data: sourceSubscription.items.data.map((item) => ({
          ...item,
          id: operation.source.itemId,
          price: { ...item.price, id: operation.source.priceId },
          current_period_start:
            status === "rolled_forward"
              ? operation.source.periodEnd
              : operation.source.periodStart,
          current_period_end:
            status === "rolled_forward"
              ? operation.source.periodEnd + 2592000
              : operation.source.periodEnd,
        })),
      },
      schedule: null,
      metadata: { guild_id: operation.guildId, discord_id: operation.payerId },
    };
    const f = stripeTransport(({ path }) => {
      if (path.includes("customers"))
        return {
          ...customer,
          id: operation.source.customerId,
          metadata: { discord_id: operation.payerId },
        };
      if (path.includes("subscriptions")) return native;
      if (path.includes("invoices")) return currentPaidFixture(native);
      throw new Error(`Unexpected ${path}`);
    });
    expect(
      await readBillingChange({
        stripe: f.stripe,
        guildId: operation.guildId,
        payerId: operation.payerId,
        now: operation.source.periodEnd,
      }),
    ).toMatchObject({ state: "canceled" });
    expect(
      await getBillingChangeRepository().getControl(operation.guildId),
    ).toBeUndefined();
    expect(f.requests.every((request) => request.method === "GET")).toBe(true);
  },
);

it("compensates paid applying work once and releases its control after the source is canceled", async () => {
  const seeded = seedReview(900);
  const operation = {
    ...billingChangeBase(seeded),
    state: "applying" as const,
    funding: { ...seeded.funding, startingBalance: 0 },
    consent: { at: seeded.createdAt, quoteRevision: seeded.revision },
  };
  getMockStore().billingChangeOperations.set(
    `CHANGE_OP#${operation.guildId}#${operation.operationId}`,
    operation,
  );
  const baseline = renewalStripeClientFixture();
  const customer = await baseline.stripe.customers.retrieve("cus_renewal");
  if (customer.deleted) throw new Error("Expected customer");
  const funding = {
    ...fundedInvoice,
    id: operation.funding.invoiceId,
    parent: null,
    customer: operation.source.customerId,
    total: 900,
    amount_due: 900,
    amount_paid: 900,
    amount_remaining: 0,
    starting_balance: 0,
    auto_advance: false,
    metadata: {
      guild_id: operation.guildId,
      chronote_change_operation: operation.operationId,
      chronote_invoice_role: "funding",
    },
  };
  const f = stripeTransport(({ path }) => {
    if (path.includes("customers"))
      return {
        ...customer,
        id: operation.source.customerId,
        metadata: { discord_id: operation.payerId },
      };
    if (path.includes("subscriptions"))
      return {
        ...sourceSubscription,
        id: operation.source.subscriptionId,
        customer: operation.source.customerId,
        status: "canceled",
        metadata: {
          guild_id: operation.guildId,
          discord_id: operation.payerId,
        },
      };
    if (path === `/v1/invoices/${funding.id}`) return funding;
    throw new Error(`Unexpected ${path}`);
  });
  const compensation = jest
    .spyOn(fundingRecovery, "compensateChangeFunding")
    .mockImplementation(async (input) => {
      const receipt = {
        creditNoteId: "cn_owned",
        debtRefundId: null,
        balanceTransactionId: null,
      };
      await input.onProgress(receipt);
      return receipt;
    });
  const context = {
    stripe: f.stripe,
    guildId: operation.guildId,
    payerId: operation.payerId,
    now: operation.createdAt,
  };
  try {
    expect(await readBillingChange(context)).toMatchObject({
      state: "canceled",
    });
    expect(
      await getBillingChangeRepository().getControl(operation.guildId),
    ).toBeUndefined();
    await readBillingChange(context);
    expect(compensation).toHaveBeenCalledTimes(1);
    expect(compensation.mock.calls[0][0].operation.funding?.invoiceId).toBe(
      funding.id,
    );
    expect(f.requests.every((request) => request.method === "GET")).toBe(true);
  } finally {
    compensation.mockRestore();
  }
});

it("compensates paid applying work once and releases its control after the unmarked source period expires", async () => {
  const seeded = seedReview(900);
  const operation = {
    ...billingChangeBase(seeded),
    state: "applying" as const,
    funding: { ...seeded.funding, startingBalance: 0 },
    consent: { at: seeded.createdAt, quoteRevision: seeded.revision },
  };
  getMockStore().billingChangeOperations.set(
    `CHANGE_OP#${operation.guildId}#${operation.operationId}`,
    operation,
  );
  const baseline = renewalStripeClientFixture();
  const customer = await baseline.stripe.customers.retrieve("cus_renewal");
  if (customer.deleted) throw new Error("Expected customer");
  const funding = {
    ...fundedInvoice,
    id: operation.funding.invoiceId,
    parent: null,
    customer: operation.source.customerId,
    total: 900,
    amount_due: 900,
    amount_paid: 900,
    amount_remaining: 0,
    starting_balance: 0,
    auto_advance: false,
    metadata: {
      guild_id: operation.guildId,
      chronote_change_operation: operation.operationId,
      chronote_invoice_role: "funding",
    },
  };
  const f = stripeTransport(({ path }) => {
    if (path.includes("customers"))
      return {
        ...customer,
        id: operation.source.customerId,
        metadata: { discord_id: operation.payerId },
      };
    if (path.includes("subscriptions"))
      return {
        ...sourceSubscription,
        id: operation.source.subscriptionId,
        customer: operation.source.customerId,
        status: "active",
        schedule: null,
        items: {
          ...sourceSubscription.items,
          data: sourceSubscription.items.data.map((item) => ({
            ...item,
            id: operation.source.itemId,
            price: { ...item.price, id: operation.source.priceId },
            current_period_start: operation.source.periodStart,
            current_period_end: operation.source.periodEnd,
          })),
        },
        metadata: {
          guild_id: operation.guildId,
          discord_id: operation.payerId,
        },
      };
    if (path === `/v1/invoices/${funding.id}`) return funding;
    if (path.includes("invoices"))
      return currentPaidFixture({
        ...sourceSubscription,
        id: operation.source.subscriptionId,
        customer: operation.source.customerId,
        items: {
          ...sourceSubscription.items,
          data: sourceSubscription.items.data.map((item) => ({
            ...item,
            id: operation.source.itemId,
            price: { ...item.price, id: operation.source.priceId },
            current_period_start: operation.source.periodStart,
            current_period_end: operation.source.periodEnd,
          })),
        },
      });
    throw new Error(`Unexpected ${path}`);
  });
  const compensation = jest
    .spyOn(fundingRecovery, "compensateChangeFunding")
    .mockImplementation(async (input) => {
      const receipt = {
        creditNoteId: "cn_owned",
        debtRefundId: null,
        balanceTransactionId: null,
      };
      await input.onProgress(receipt);
      return receipt;
    });
  const context = {
    stripe: f.stripe,
    guildId: operation.guildId,
    payerId: operation.payerId,
    now: operation.source.periodEnd,
  };
  try {
    expect(await readBillingChange(context)).toMatchObject({
      state: "canceled",
    });
    expect(
      await getBillingChangeRepository().getControl(operation.guildId),
    ).toBeUndefined();
    await readBillingChange(context);
    expect(compensation).toHaveBeenCalledTimes(1);
    expect(compensation.mock.calls[0][0].operation.funding?.invoiceId).toBe(
      funding.id,
    );
    expect(f.requests.every((request) => request.method === "GET")).toBe(true);
  } finally {
    compensation.mockRestore();
  }
});

function currentPaidFixture(native: typeof sourceSubscription) {
  const item = native.items.data[0];
  return {
    ...fundedInvoice,
    id: native.latest_invoice,
    customer: native.customer,
    parent: {
      type: "subscription_details",
      quote_details: null,
      subscription_details: { metadata: {}, subscription: native.id },
    },
    lines: {
      ...fundedInvoice.lines,
      data: fundedInvoice.lines.data.map((line) => ({
        ...line,
        pricing: {
          ...line.pricing,
          price_details: {
            ...line.pricing?.price_details,
            price: item.price.id,
          },
        },
        parent: {
          type: "subscription_item_details",
          invoice_item_details: null,
          subscription_item_details: {
            invoice_item: null,
            proration: false,
            proration_details: null,
            subscription: native.id,
            subscription_item: item.id,
          },
        },
        period: {
          start: item.current_period_start,
          end: item.current_period_end,
        },
      })),
    },
  };
}
