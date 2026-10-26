/** @jest-environment node */
import { afterEach, beforeEach, expect, it } from "@jest/globals";
import { config } from "../../src/services/configService";
import { readRenewalSource } from "../../src/services/renewalProvider";
import { getMockStore, resetMockStore } from "../../src/repositories/mockStore";
import {
  renewalStripeClientFixture as fixture,
  response,
} from "../fixtures/renewalStripeClient";
import {
  renewalGuildId as guildId,
  renewalSubscription,
} from "../fixtures/renewal";
import {
  renewalPreview,
  fundedInvoice,
  remainingDiscount,
} from "../fixtures/renewalStripe";
const previousMock = config.mock.enabled;
beforeEach(() => {
  config.mock.enabled = true;
  resetMockStore();
  getMockStore().subscriptions.set(guildId, {
    ...renewalSubscription,
    stripeCustomerId: "cus_renewal",
  });
});
afterEach(() => {
  config.mock.enabled = previousMock;
});
it("rejects a pending or proration preview line instead of quoting its invoice total", async () => {
  const f = fixture();
  const line = renewalPreview.lines.data[0];
  f.preview.mockResolvedValue(
    response({
      ...renewalPreview,
      lines: { ...renewalPreview.lines, data: [line, line] },
    }),
  );
  expect(
    await readRenewalSource({
      stripe: f.stripe,
      guildId,
      subscriptionId: "sub_renewal",
    }),
  ).toMatchObject({ kind: "review", reason: "unverified_terms" });
  expect(f.update).not.toHaveBeenCalled();
});
it("requires an explicitly verified tax basis", async () => {
  const f = fixture();
  const item = f.provider.items.data[0];
  f.provider = {
    ...f.provider,
    items: {
      ...f.provider.items,
      data: [
        { ...item, price: { ...item.price, tax_behavior: "unspecified" } },
      ],
    },
  };
  expect(
    await readRenewalSource({
      stripe: f.stripe,
      guildId,
      subscriptionId: "sub_renewal",
    }),
  ).toMatchObject({ kind: "review", reason: "unverified_terms" });
});
it("does not treat a zero-cash application invoice as independent funded service", async () => {
  const f = fixture();
  f.invoice.mockResolvedValue(response({ ...fundedInvoice, amount_paid: 0 }));
  expect(
    await readRenewalSource({
      stripe: f.stripe,
      guildId,
      subscriptionId: "sub_renewal",
    }),
  ).toMatchObject({ kind: "review" });
});
it("validates mode and server/customer association before a preview or update", async () => {
  const f = fixture();
  f.provider = { ...f.provider, customer: "cus_someone_else" };
  await expect(
    readRenewalSource({
      stripe: f.stripe,
      guildId,
      subscriptionId: "sub_renewal",
    }),
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  expect(f.preview).not.toHaveBeenCalled();
  expect(f.update).not.toHaveBeenCalled();
});
it("does not trust an unrelated paid invoice for the subscription boundary", async () => {
  const f = fixture();
  f.invoice.mockResolvedValue(
    response({
      ...fundedInvoice,
      parent: {
        type: "subscription_details",
        subscription_details: { metadata: {}, subscription: "sub_other" },
        quote_details: null,
      },
    }),
  );
  expect(
    await readRenewalSource({
      stripe: f.stripe,
      guildId,
      subscriptionId: "sub_renewal",
    }),
  ).toMatchObject({ kind: "review" });
});
it("keeps the remaining monthly discount and its original end instead of restarting it", async () => {
  const f = fixture();
  f.provider = { ...f.provider, discounts: [remainingDiscount] };
  const line = renewalPreview.lines.data[0];
  f.preview.mockResolvedValue(
    response({
      ...renewalPreview,
      lines: {
        ...renewalPreview.lines,
        data: [
          {
            ...line,
            discount_amounts: [{ amount: 400, discount: remainingDiscount.id }],
          },
        ],
      },
    }),
  );
  const source = await readRenewalSource({
    stripe: f.stripe,
    guildId,
    subscriptionId: "sub_renewal",
  });
  expect(source).toMatchObject({
    kind: "verified",
    terms: {
      unitAmount: 600,
      discount: { endsAt: "2027-01-12T12:00:00.000Z", regularUnitAmount: 1000 },
    },
  });
  expect(f.update).not.toHaveBeenCalled();
});
it("requires the cancellation representation accepted for each billing mode", async () => {
  const f = fixture();
  f.provider = { ...f.provider, cancel_at_period_end: false };
  expect(
    await readRenewalSource({
      stripe: f.stripe,
      guildId,
      subscriptionId: "sub_renewal",
    }),
  ).toMatchObject({ kind: "review", reason: "unsupported_state" });
});
it("does not qualify a shortened initial paid stub as a natural full service period", async () => {
  const f = fixture();
  const paid = fundedInvoice.lines.data[0];
  f.invoice.mockResolvedValue(
    response({
      ...fundedInvoice,
      amount_paid: 500,
      total: 500,
      lines: { ...fundedInvoice.lines, data: [{ ...paid, amount: 500 }] },
    }),
  );
  expect(
    await readRenewalSource({
      stripe: f.stripe,
      guildId,
      subscriptionId: "sub_renewal",
    }),
  ).toMatchObject({ kind: "review" });
});
