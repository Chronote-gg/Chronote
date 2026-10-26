/** @jest-environment node */
import {
  readBillingChangeSource,
  readChangePreview,
  changeSourceFingerprint,
} from "../../src/services/billingChangeProvider";
import { config } from "../../src/services/configService";
import { getMockStore, resetMockStore } from "../../src/repositories/mockStore";
import {
  renewalStripeClientFixture as fixture,
  response,
} from "../fixtures/renewalStripeClient";
import {
  renewalSubscription,
  renewalPayerId,
  renewalGuildId,
} from "../fixtures/renewal";
import {
  fundedInvoice,
  sourceSubscription,
  remainingDiscount,
} from "../fixtures/renewalStripe";
import { changeOperation } from "../fixtures/billingChange";
const previousMock = config.mock.enabled;
beforeEach(() => {
  config.mock.enabled = true;
  resetMockStore();
  getMockStore().subscriptions.set(renewalGuildId, {
    ...renewalSubscription,
    stripeCustomerId: "cus_renewal",
  });
});
afterEach(() => {
  config.mock.enabled = previousMock;
  jest.restoreAllMocks();
});
it("binds paid service and original payer while excluding later account balances from source identity", async () => {
  const f = fixture();
  const first = await readBillingChangeSource({
    stripe: f.stripe,
    guildId: renewalGuildId,
    payerId: renewalPayerId,
    at: f.provider.items.data[0].current_period_start + 100,
  });
  f.customer.mockImplementationOnce(async () => {
    const original = await f.customer.mock.results[0].value;
    if (original.deleted) throw new Error("Expected customer");
    return response({ ...original, balance: -200 });
  });
  const second = await readBillingChangeSource({
    stripe: f.stripe,
    guildId: renewalGuildId,
    payerId: renewalPayerId,
    at: first.source.at,
  });
  expect(second.source.fingerprint).toBe(first.source.fingerprint);
  expect(first.source).toMatchObject({
    subscriptionId: "sub_renewal",
    itemId: f.provider.items.data[0].id,
    periodEnd: f.provider.items.data[0].current_period_end,
    tier: "basic",
    interval: "month",
  });
});
it("rejects another payer before any preview or collection", async () => {
  const f = fixture();
  await expect(
    readBillingChangeSource({
      stripe: f.stripe,
      guildId: renewalGuildId,
      payerId: "someone-else",
    }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect(f.preview).not.toHaveBeenCalled();
  expect(f.update).not.toHaveBeenCalled();
});
it("does not credit an unpaid source period", async () => {
  const f = fixture();
  f.invoice.mockResolvedValue(
    response({ ...fundedInvoice, status: "open", amount_remaining: 1000 }),
  );
  await expect(
    readBillingChangeSource({
      stripe: f.stripe,
      guildId: renewalGuildId,
      payerId: renewalPayerId,
    }),
  ).rejects.toMatchObject({ reason: "purchase_pending" });
});
it("reads discounted gross service and rejects unrelated pending invoice lines", () => {
  const line = fundedInvoice.lines.data[0];
  const source = {
    ...changeOperation.source,
    itemId: "si_renewal",
    priceId: "price_renewal",
  };
  const target = { ...changeOperation.target, priceId: "price_target" };
  const credit = {
    ...line,
    id: "il_credit",
    amount: -300,
    parent: {
      type: "subscription_item_details" as const,
      invoice_item_details: null,
      subscription_item_details: {
        ...line.parent?.subscription_item_details,
        invoice_item: null,
        proration: true,
        proration_details: { credited_items: null },
        subscription: "sub_renewal",
        subscription_item: "si_renewal",
      },
    },
  };
  const debit = {
    ...line,
    id: "il_debit",
    amount: 10000,
    pricing: {
      type: "price_details" as const,
      price_details: { price: "price_target", product: "prod_renewal" },
      unit_amount_decimal: line.pricing?.unit_amount_decimal ?? null,
    },
    discount_amounts: [{ amount: 4000, discount: "di_annual" }],
    parent: {
      ...credit.parent,
      subscription_item_details: {
        ...credit.parent.subscription_item_details,
        proration: false,
      },
    },
  };
  const invoice = {
    ...fundedInvoice,
    total: 5700,
    amount_due: 5500,
    starting_balance: -200,
    ending_balance: 0,
    lines: { ...fundedInvoice.lines, data: [credit, debit] },
  };
  expect(readChangePreview(invoice, source, target)).toMatchObject({
    planCharge: 10000,
    offerSavings: 4000,
    unusedCredit: 300,
    serviceTotal: 5700,
  });
  expect(() =>
    readChangePreview(
      {
        ...invoice,
        lines: {
          ...invoice.lines,
          data: [...invoice.lines.data, { ...debit, parent: null }],
        },
      },
      source,
      target,
    ),
  ).toThrow();
});

it("does not invalidate a server quote when another server redeems the same coupon", () => {
  const coupon = remainingDiscount.source.coupon;
  if (typeof coupon === "string" || coupon.deleted)
    throw new Error("Expected coupon fixture");
  const first = { ...sourceSubscription, discounts: [remainingDiscount] };
  const second = {
    ...first,
    discounts: [
      {
        ...remainingDiscount,
        source: {
          ...remainingDiscount.source,
          coupon: {
            ...coupon,
            times_redeemed: coupon.times_redeemed + 1,
            valid: !coupon.valid,
          },
        },
      },
    ],
  };
  expect(changeSourceFingerprint(second)).toBe(changeSourceFingerprint(first));
});

it("allows a settled fully discounted period without treating it as an unpaid invoice", async () => {
  const f = fixture();
  const item = f.provider.items.data[0];
  f.invoice.mockResolvedValue(
    response({
      ...fundedInvoice,
      total: 0,
      amount_due: 0,
      amount_paid: 0,
      amount_remaining: 0,
      lines: {
        ...fundedInvoice.lines,
        data: [
          {
            ...fundedInvoice.lines.data[0],
            period: {
              start: item.current_period_start,
              end: item.current_period_end,
            },
            discount_amounts: [
              { amount: 1000, discount: "di_fully_discounted" },
            ],
          },
        ],
      },
    }),
  );
  await expect(
    readBillingChangeSource({
      stripe: f.stripe,
      guildId: renewalGuildId,
      payerId: renewalPayerId,
      at: item.current_period_start + 100,
    }),
  ).resolves.toMatchObject({ source: { tier: "basic" } });
});

it("never credits a new period using the previous period's paid invoice", async () => {
  const f = fixture();
  const item = f.provider.items.data[0];
  f.provider.items.data[0] = {
    ...item,
    current_period_start: item.current_period_end,
    current_period_end: item.current_period_end + 30 * 86400,
  };
  await expect(
    readBillingChangeSource({
      stripe: f.stripe,
      guildId: renewalGuildId,
      payerId: renewalPayerId,
      at: item.current_period_end + 100,
    }),
  ).rejects.toThrow();
});

it("allows paid service with a future-payment SetupIntent after a zero application invoice", async () => {
  const f = fixture();
  f.provider = { ...f.provider, pending_setup_intent: "seti_future_payment" };
  await expect(
    readBillingChangeSource({
      stripe: f.stripe,
      guildId: renewalGuildId,
      payerId: renewalPayerId,
      at: f.provider.items.data[0].current_period_start + 100,
    }),
  ).resolves.toMatchObject({ source: { tier: "basic" } });
  f.invoice.mockResolvedValue(
    response({ ...fundedInvoice, status: "open", amount_remaining: 1000 }),
  );
  await expect(
    readBillingChangeSource({
      stripe: f.stripe,
      guildId: renewalGuildId,
      payerId: renewalPayerId,
      at: f.provider.items.data[0].current_period_start + 100,
    }),
  ).rejects.toMatchObject({ reason: "purchase_pending" });
});

it.each([
  "pre_payment_credit_notes_amount",
  "post_payment_credit_notes_amount",
] as const)(
  "does not grant another credit from a source reversed through %s",
  async (field) => {
    const f = fixture();
    f.invoice.mockResolvedValue(response({ ...fundedInvoice, [field]: 100 }));
    await expect(
      readBillingChangeSource({
        stripe: f.stripe,
        guildId: renewalGuildId,
        payerId: renewalPayerId,
        at: f.provider.items.data[0].current_period_start + 100,
      }),
    ).rejects.toMatchObject({ reason: "purchase_pending" });
  },
);
