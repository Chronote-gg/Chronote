import Stripe from "stripe";
import { stripeTransport } from "../fixtures/stripeTransport";
import { changeSourceFingerprint } from "../../src/services/billingChangeProvider";
/** @jest-environment node */
import {
  buildChangeApplicationRequest,
  applyFundedBillingChange,
  inspectChangeApplication,
} from "../../src/services/billingChangeApplication";
import { changeOperation } from "../fixtures/billingChange";
import { billingChangeBase } from "../../src/types/billingChange";
import {
  sourceSubscription,
  fundedInvoice,
  remainingDiscount,
} from "../fixtures/renewalStripe";
const operation = {
  ...billingChangeBase(changeOperation),
  state: "applying" as const,
  consent: { at: 1700000010, quoteRevision: "approved" },
  funding: {
    invoiceId: "in_funding",
    total: 900,
    amountDue: 900,
    currency: "usd",
    startingBalance: 0,
    endingBalance: 0,
    serviceValue: 900,
  },
};
it.each(["classic", "flexible"] as const)(
  "preserves %s billing mode and removes Basic discounts for Pro",
  (mode) => {
    const request = buildChangeApplicationRequest({
      ...operation,
      source: { ...operation.source, billingMode: mode },
    });
    expect(request).toMatchObject({
      items: [
        {
          id: operation.source.itemId,
          price: operation.target.priceId,
          quantity: 1,
        },
      ],
      discounts: "",
      proration_behavior: "always_invoice",
      proration_date: 1700000000,
      payment_behavior: "default_incomplete",
      metadata: { chronote_change_operation: operation.operationId },
    });
    expect(request).not.toHaveProperty("billing_mode");
    expect(request).not.toHaveProperty("billing_cycle_anchor");
    expect(request.add_invoice_items?.[0]).toMatchObject({
      discountable: false,
      price_data: { unit_amount: -900, tax_behavior: "inclusive" },
    });
  },
);
it("starts a full new year without recalculating the approved unused source credit", async () => {
  const request = buildChangeApplicationRequest({
    ...operation,
    target: {
      ...operation.target,
      selection: { ...operation.target.selection, interval: "year" },
    },
  });
  expect(request).toMatchObject({
    billing_cycle_anchor: { type: "now" },
    proration_behavior: "none",
  });
  expect(request).not.toHaveProperty("proration_date");
  expect(request.add_invoice_items?.[0].price_data?.unit_amount).toBe(-1200);
  const transport = stripeTransport(() => ({ id: "sub_fixture" }));
  await transport.stripe.subscriptions.update("sub_fixture", request);
  expect(transport.requests[0].fields.get("billing_cycle_anchor[type]")).toBe(
    "now",
  );
  expect(transport.requests[0].fields.has("billing_cycle_anchor")).toBe(false);
});
it("never accepts an application invoice as an extra payment", () => {
  const subscription = {
    ...sourceSubscription,
    id: operation.source.subscriptionId,
    customer: operation.source.customerId,
    billing_mode: { type: operation.source.billingMode, flexible: null },
    metadata: {
      guild_id: operation.guildId,
      chronote_change_operation: operation.operationId,
    },
    items: {
      ...sourceSubscription.items,
      data: [
        {
          ...sourceSubscription.items.data[0],
          id: operation.source.itemId,
          current_period_start: operation.source.periodStart,
          current_period_end: operation.source.periodEnd,
          price: {
            ...sourceSubscription.items.data[0].price,
            id: operation.target.priceId ?? "",
          },
        },
      ],
    },
    discounts: [],
  };
  const invoice = {
    ...fundedInvoice,
    id: "in_application",
    customer: operation.source.customerId,
    total: 0,
    amount_due: 0,
    amount_paid: 0,
    amount_remaining: 0,
    parent: {
      ...fundedInvoice.parent,
      type: "subscription_details" as const,
      subscription_details: {
        subscription: subscription.id,
        metadata: {},
        subscription_proration_date: null,
      },
      quote_details: null,
    },
  };
  expect(inspectChangeApplication(subscription, invoice, operation)).toBe(
    "applied",
  );
  expect(
    inspectChangeApplication(
      subscription,
      { ...invoice, total: 500, amount_due: 500 },
      operation,
    ),
  ).toBe("unknown");
  expect(
    inspectChangeApplication(
      subscription,
      {
        ...invoice,
        status: "open",
        amount_due: 500,
        amount_remaining: 500,
        starting_balance: 500,
        auto_advance: false,
        attempt_count: 0,
        next_payment_attempt: null,
      },
      operation,
    ),
  ).toBe("residual_balance");
  expect(
    inspectChangeApplication(
      { ...subscription, customer: "cus_other" },
      invoice,
      operation,
    ),
  ).toBe("unknown");
});

it("offsets the full target value including exclusive tax when starting a new year", () => {
  const request = buildChangeApplicationRequest({
    ...operation,
    target: {
      ...operation.target,
      taxBehavior: "exclusive",
      selection: { ...operation.target.selection, interval: "year" },
    },
    funding: { ...operation.funding, targetServiceValue: 1320 },
  });
  expect(request.add_invoice_items?.[0].price_data?.unit_amount).toBe(-1320);
});

import { stripeTransport } from "../fixtures/stripeTransport";
it("holds an unknown application when the source changed instead of refunding an offer that may already have run", async () => {
  const paid = {
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
  const f = stripeTransport(({ path }) =>
    path.startsWith("/v1/invoices/") ? paid : sourceSubscription,
  );
  expect(
    await applyFundedBillingChange({
      stripe: f.stripe,
      operation,
      now: operation.createdAt,
    }),
  ).toBe("unknown");
  expect(f.requests.some((request) => request.method === "POST")).toBe(false);
});

it("can compensate a definitive rejected update while holding an ambiguous transport failure", async () => {
  const native = {
    ...sourceSubscription,
    customer: operation.source.customerId,
  };
  const selected = {
    ...operation,
    source: {
      ...operation.source,
      fingerprint: changeSourceFingerprint(native),
    },
  };
  const paid = {
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
  const f = stripeTransport(({ path }) =>
    path.startsWith("/v1/invoices/") ? paid : native,
  );
  const update = jest.spyOn(f.stripe.subscriptions, "update");
  update.mockRejectedValueOnce(
    new Stripe.errors.StripeInvalidRequestError({
      message: "Coupon is no longer available",
      statusCode: 400,
    }),
  );
  expect(
    await applyFundedBillingChange({
      stripe: f.stripe,
      operation: selected,
      now: operation.createdAt,
    }),
  ).toBe("rejected");
  update.mockRejectedValueOnce(
    new Stripe.errors.StripeConnectionError({ message: "Lost response" }),
  );
  await expect(
    applyFundedBillingChange({
      stripe: f.stripe,
      operation: selected,
      now: operation.createdAt,
    }),
  ).rejects.toThrow("Lost response");
});

it.each([true, false])(
  "verifies the consumed one-time annual coupon from its application invoice: correct discount %s",
  (valid) => {
    const start = operation.consent.at;
    const end = new Date(start * 1000);
    end.setUTCFullYear(end.getUTCFullYear() + 1);
    const target = {
      ...operation.target,
      priceId: "price_basic_year",
      unitAmount: 10000,
      selection: {
        tier: "basic" as const,
        interval: "year" as const,
        expectedOffer: "basic_annual_intro_v1" as const,
      },
      offer: {
        id: "basic_annual_intro_v1" as const,
        terms: {
          interval: "year" as const,
          currency: "usd" as const,
          priceId: "price_basic_year",
          couponId: "co_annual",
          regularUnitAmount: 10000 as const,
          discountedUnitAmount: 6000 as const,
          durationMonths: 12 as const,
        },
        authority: {
          guildId: operation.guildId,
          mode: "test" as const,
          offerId: "basic_annual_intro_v1" as const,
          accountId: "acct-owned",
          coverageRevision: "coverage",
          boundaryRevision: "boundary",
          writerImageDigest: "sha256:" + "a".repeat(64),
        },
      },
    };
    const applying = { ...operation, target };
    const native = {
      ...sourceSubscription,
      id: operation.source.subscriptionId,
      customer: operation.source.customerId,
      billing_mode: { type: operation.source.billingMode, flexible: null },
      discounts: [],
      metadata: {
        guild_id: operation.guildId,
        chronote_change_operation: operation.operationId,
      },
      items: {
        ...sourceSubscription.items,
        data: [
          {
            ...sourceSubscription.items.data[0],
            id: operation.source.itemId,
            price: {
              ...sourceSubscription.items.data[0].price,
              id: target.priceId,
            },
            current_period_start: start,
            current_period_end: end.getTime() / 1000,
          },
        ],
      },
    };
    const discount = {
      ...remainingDiscount,
      id: "di_annual",
      source: { ...remainingDiscount.source, coupon: "co_annual" },
    };
    const line = {
      ...fundedInvoice.lines.data[0],
      invoice: "in_annual_application",
      amount: 10000,
      quantity: 1,
      period: { start, end: end.getTime() / 1000 },
      pricing: {
        ...fundedInvoice.lines.data[0].pricing,
        type: "price_details" as const,
        price_details: { price: target.priceId, product: "prod_basic" },
        unit_amount_decimal: "10000",
      },
      discount_amounts: [
        { amount: valid ? 4000 : 3000, discount: discount.id },
      ],
      parent: {
        type: "subscription_item_details" as const,
        invoice_item_details: null,
        subscription_item_details: {
          invoice_item: null,
          subscription: native.id,
          subscription_item: operation.source.itemId,
          proration: false,
          proration_details: null,
        },
      },
    };
    const invoice = {
      ...fundedInvoice,
      id: "in_annual_application",
      customer: operation.source.customerId,
      billing_reason: "subscription_update" as const,
      total: 0,
      amount_due: 0,
      amount_paid: 0,
      amount_remaining: 0,
      parent: {
        type: "subscription_details" as const,
        quote_details: null,
        subscription_details: {
          subscription: native.id,
          metadata: {},
          subscription_proration_date: null,
        },
      },
      discounts: [discount],
      lines: { ...fundedInvoice.lines, data: [line] },
    };
    expect(inspectChangeApplication(native, invoice, applying)).toBe(
      valid ? "applied" : "unknown",
    );
  },
);

it.each(["canceled", "incomplete_expired"] as const)(
  "rejects a verified %s source before application so its funding can be compensated",
  async (status) => {
    const paid = {
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
    const native = {
      ...sourceSubscription,
      id: operation.source.subscriptionId,
      customer: operation.source.customerId,
      livemode: operation.mode === "live",
      status,
      metadata: { guild_id: operation.guildId },
    };
    const f = stripeTransport(({ path }) =>
      path.startsWith("/v1/invoices/") ? paid : native,
    );
    expect(
      await applyFundedBillingChange({
        stripe: f.stripe,
        operation,
        now: operation.createdAt,
      }),
    ).toBe("rejected");
    expect(f.requests.every((request) => request.method === "GET")).toBe(true);
  },
);
it.each([
  "rolled_forward",
  "at_boundary",
  "foreign_customer",
  "application_marked",
  "other_price",
  "owned_schedule",
] as const)(
  "rejects a verified %s expired source so its funding can be compensated",
  async (status) => {
    const paid = {
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
    const native = {
      ...sourceSubscription,
      id: operation.source.subscriptionId,
      customer:
        status === "foreign_customer"
          ? "cus_foreign"
          : operation.source.customerId,
      livemode: operation.mode === "live",
      status: "active" as const,
      schedule: status === "owned_schedule" ? "sub_sched_unresolved" : null,
      pending_update: null,
      items: {
        ...sourceSubscription.items,
        data: sourceSubscription.items.data.map((item) => ({
          ...item,
          id: operation.source.itemId,
          price: {
            ...item.price,
            id:
              status === "other_price"
                ? "price_other"
                : operation.source.priceId,
          },
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
      metadata: {
        guild_id: operation.guildId,
        ...(status === "application_marked"
          ? { chronote_change_operation: operation.operationId }
          : {}),
      },
    };
    const f = stripeTransport(({ path }) =>
      path.startsWith("/v1/invoices/") ? paid : native,
    );
    expect(
      await applyFundedBillingChange({
        stripe: f.stripe,
        operation,
        now: operation.source.periodEnd,
      }),
    ).toBe(
      status === "rolled_forward" || status === "at_boundary"
        ? "rejected"
        : "unknown",
    );
    expect(f.requests.every((request) => request.method === "GET")).toBe(true);
  },
);
it("does not compensate an unowned terminal source", async () => {
  const paid = {
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
  const f = stripeTransport(({ path }) =>
    path.startsWith("/v1/invoices/")
      ? paid
      : { ...sourceSubscription, status: "canceled", customer: "cus_other" },
  );
  expect(
    await applyFundedBillingChange({
      stripe: f.stripe,
      operation,
      now: operation.createdAt,
    }),
  ).toBe("unknown");
});
