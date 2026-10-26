/** @jest-environment node */
import {
  changeServiceFingerprint,
  changeSourceFingerprint,
} from "../../src/services/billingChangeProvider";
import { readBillingChange } from "../../src/services/billingChangeService";
import * as fundingRecovery from "../../src/services/billingChangeRecovery";
import {
  billingChangeBase,
  billingChangeOperationSchema,
} from "../../src/types/billingChange";
import type { StripeSubscription } from "../../src/types/stripe";
import { config } from "../../src/services/configService";
import { getMockStore, resetMockStore } from "../../src/repositories/mockStore";
import { getBillingChangeRepository } from "../../src/repositories/billingChangeRepository";
import { changeOperation, changePointer } from "../fixtures/billingChange";
import { sourceSubscription, fundedInvoice } from "../fixtures/renewalStripe";
import { renewalStripeClientFixture } from "../fixtures/renewalStripeClient";
import { stripeTransport } from "../fixtures/stripeTransport";

const originalConfig = {
  mock: config.mock.enabled,
  transitions: config.stripe.subscriptionTransitionsEnabled,
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
  config.mock.enabled = originalConfig.mock;
  config.stripe.subscriptionTransitionsEnabled = originalConfig.transitions;
  jest.restoreAllMocks();
});

async function fixture(
  timing: "immediate" | "renewal",
  cancellation: "at" | "period_end",
  change: "add" | "remove",
) {
  const base = billingChangeBase(changeOperation);
  const original: StripeSubscription = {
    ...sourceSubscription,
    id: base.source.subscriptionId,
    customer: base.source.customerId,
    status: "active",
    schedule: null,
    pending_update: null,
    cancel_at: change === "remove" ? base.source.periodEnd : null,
    cancel_at_period_end: change === "remove" && cancellation === "period_end",
    metadata: { guild_id: base.guildId, discord_id: base.payerId },
    latest_invoice: "in_original",
    items: {
      ...sourceSubscription.items,
      data: sourceSubscription.items.data.map((item) => ({
        ...item,
        id: base.source.itemId,
        price: { ...item.price, id: base.source.priceId },
        current_period_start: base.source.periodStart,
        current_period_end: base.source.periodEnd,
      })),
    },
  };
  const funding = {
    invoiceId: "in_funding",
    total: 900,
    amountDue: 900,
    currency: "usd",
    startingBalance: 0,
    endingBalance: 0,
    serviceValue: 900,
  };
  const operation = billingChangeOperationSchema.parse({
    ...base,
    timing,
    state: timing === "renewal" ? "accepted" : "applying",
    funding: timing === "renewal" ? null : funding,
    consent: { at: base.createdAt, quoteRevision: base.revision },
    source: {
      ...base.source,
      fingerprint: changeSourceFingerprint(original),
      invariantFingerprint: changeServiceFingerprint(original),
      cancellation: {
        at: original.cancel_at,
        atPeriodEnd: original.cancel_at_period_end,
      },
    },
  });
  const native = {
    ...original,
    cancel_at: change === "add" ? base.source.periodEnd : null,
    cancel_at_period_end: change === "add" && cancellation === "period_end",
  };
  const paid = {
    ...fundedInvoice,
    id: "in_original",
    customer: base.source.customerId,
    parent: {
      type: "subscription_details",
      subscription_details: { subscription: original.id, metadata: {} },
    },
    lines: {
      ...fundedInvoice.lines,
      data: [
        {
          ...fundedInvoice.lines.data[0],
          invoice: "in_original",
          period: {
            start: base.source.periodStart,
            end: base.source.periodEnd,
          },
          pricing: { price_details: { price: base.source.priceId } },
          parent: {
            subscription_item_details: {
              subscription: original.id,
              subscription_item: base.source.itemId,
            },
          },
        },
      ],
    },
  };
  const fundingInvoice = {
    ...fundedInvoice,
    id: funding.invoiceId,
    parent: null,
    customer: base.source.customerId,
    total: 900,
    amount_due: 900,
    amount_paid: 900,
    amount_remaining: 0,
    starting_balance: 0,
    auto_advance: false,
    metadata: {
      guild_id: base.guildId,
      chronote_change_operation: base.operationId,
      chronote_invoice_role: "funding",
    },
  };
  getMockStore().billingChangeOperations.set(
    `CHANGE_OP#${base.guildId}#${base.operationId}`,
    operation,
  );
  getMockStore().billingChangeControls.set(`CHANGE_CONTROL#${base.guildId}`, {
    operationId: base.operationId,
  });
  const baseline = renewalStripeClientFixture();
  const customer = await baseline.stripe.customers.retrieve("cus_renewal");
  if (customer.deleted) throw new Error("Expected customer fixture");
  const f = stripeTransport(({ path, method }) => {
    if (method !== "GET") throw new Error(`Unexpected write ${path}`);
    if (path === `/v1/subscriptions/${native.id}`) return native;
    if (path === `/v1/customers/${base.source.customerId}`)
      return {
        ...customer,
        id: base.source.customerId,
        metadata: { discord_id: base.payerId },
      };
    if (path === `/v1/invoices/${funding.invoiceId}`) return fundingInvoice;
    if (path === "/v1/invoices/in_original") return paid;
    throw new Error(`Unexpected ${path}`);
  });
  return { ...f, operation, native, funding };
}

test.each([
  ["renewal", "at", "add"],
  ["renewal", "period_end", "add"],
  ["immediate", "at", "add"],
  ["immediate", "period_end", "add"],
  ["renewal", "at", "remove"],
  ["renewal", "period_end", "remove"],
  ["immediate", "at", "remove"],
  ["immediate", "period_end", "remove"],
] as const)(
  "releases %s work after portal cancellation changes (%s, %s) without reversing the payer's intent",
  async (timing, cancellation, change) => {
    const f = await fixture(timing, cancellation, change);
    const compensation = jest
      .spyOn(fundingRecovery, "compensateChangeFunding")
      .mockImplementation(async (input) => {
        const receipt = {
          creditNoteId: input.operation.funding ? "cn_owned" : null,
          debtRefundId: null,
          balanceTransactionId: null,
        };
        await input.onProgress(receipt);
        return receipt;
      });
    const context = {
      stripe: f.stripe,
      guildId: f.operation.guildId,
      payerId: f.operation.payerId,
      now: f.operation.createdAt + 2,
    };
    expect(await readBillingChange(context)).toMatchObject({
      state: "canceled",
    });
    expect(
      await getBillingChangeRepository().getControl(context.guildId),
    ).toBeUndefined();
    await readBillingChange(context);
    expect(compensation).toHaveBeenCalledTimes(1);
    expect(f.native.cancel_at).toBe(
      change === "add" ? f.operation.source.periodEnd : null,
    );
    expect(f.native.cancel_at_period_end).toBe(
      change === "add" && cancellation === "period_end",
    );
    expect(f.requests.every((request) => request.method === "GET")).toBe(true);
  },
);
