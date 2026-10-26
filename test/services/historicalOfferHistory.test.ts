/** @jest-environment node */
import { assessHistoricalOfferHistory } from "../../src/services/historicalOfferHistory";
import type {
  HistoricalOfferEvidence,
  HistoricalOfferScope,
} from "../../src/services/historicalOfferEvidence";

const scope: HistoricalOfferScope = {
  guildId: "111111111111111111",
  mode: "test",
  accountId: "acct-owned",
  createdBefore: 1000,
};
const terms = {
  priceId: "price",
  couponId: "coupon",
  currency: "usd",
  interval: "month",
  regularUnitAmount: 1000,
  discountedUnitAmount: 600,
  durationMonths: 3,
};
const settled: HistoricalOfferEvidence = {
  kind: "settled",
  offerId: "basic_intro_v1",
  originalOperationId: "old-op",
  originalPayerId: "old-payer",
  productId: "prod",
  customerId: "old-customer",
  subscriptionId: "old-sub",
  invoiceId: "in-paid",
  createdAt: 100,
  terms: { ...terms, currency: "usd", interval: "month" },
  settlement: {
    customerId: "old-customer",
    subscriptionId: "old-sub",
    subscriptionItemId: "old-item",
    invoiceId: "in-paid",
    priceId: "price",
    status: "paid",
    amountPaid: 0,
    amountRemaining: 0,
    settledAt: 200,
  },
};
const batch = (
  entries: Array<{
    invoiceId: string;
    evidence: HistoricalOfferEvidence;
    scope: HistoricalOfferScope;
  }> = [],
) => ({
  scope,
  runId: "run",
  enumeration: "complete" as const,
  catchUp: "complete" as const,
  entries,
});
const entry = (evidence: HistoricalOfferEvidence, invoiceId = "in-paid") => ({
  scope,
  invoiceId,
  evidence,
});

test("complete ordinary history consumes neither offer", () => {
  expect(
    assessHistoricalOfferHistory(batch([entry({ kind: "ordinary" })])),
  ).toMatchObject({ monthly: { kind: "unused" }, annual: { kind: "unused" } });
});
test("empty incomplete enumeration cannot prove either offer unused", () => {
  expect(
    assessHistoricalOfferHistory({ ...batch(), enumeration: "incomplete" }),
  ).toMatchObject({
    monthly: { kind: "unresolved" },
    annual: { kind: "unresolved" },
  });
});
test("all pages without pending-payment catch-up cannot prove unused", () => {
  expect(
    assessHistoricalOfferHistory({ ...batch(), catchUp: "pending" }),
  ).toMatchObject({
    monthly: { kind: "unresolved" },
    annual: { kind: "unresolved" },
  });
});
test("credit-covered paid Basic monthly history consumes monthly only", () => {
  expect(assessHistoricalOfferHistory(batch([entry(settled)]))).toMatchObject({
    monthly: { kind: "used", evidence: settled },
    annual: { kind: "unused" },
  });
});
test("verified use dominates failed attempts and incomplete scanning", () => {
  const failed: HistoricalOfferEvidence = {
    ...settled,
    kind: "unpaid_void",
    voidedAt: 250,
    invoiceId: "in-void",
  };
  expect(
    assessHistoricalOfferHistory({
      ...batch([entry(failed, "in-void"), entry(settled)]),
      enumeration: "incomplete",
    }),
  ).toMatchObject({
    monthly: { kind: "used" },
    annual: { kind: "unresolved" },
  });
});
test("an unresolved known monthly attempt does not consume or block annual", () => {
  expect(
    assessHistoricalOfferHistory(
      batch([
        entry({
          kind: "unresolved",
          offerId: "basic_intro_v1",
          invoiceId: "in-paid",
          reason: "unsettled",
        }),
      ]),
    ),
  ).toMatchObject({
    monthly: { kind: "unresolved" },
    annual: { kind: "unused" },
  });
});
test("unattributed evidence blocks both offers", () => {
  expect(
    assessHistoricalOfferHistory(
      batch([
        entry({
          kind: "unresolved",
          offerId: null,
          invoiceId: "in-paid",
          reason: "missing_snapshot",
        }),
      ]),
    ),
  ).toMatchObject({
    monthly: { kind: "unresolved" },
    annual: { kind: "unresolved" },
  });
});
test.each(["guildId", "mode", "accountId", "createdBefore"] as const)(
  "rejects evidence from a different %s scope",
  (key) => {
    const other = { ...scope, [key]: key === "createdBefore" ? 999 : "other" };
    expect(() =>
      assessHistoricalOfferHistory({
        ...batch(),
        entries: [{ invoiceId: "in-paid", evidence: settled, scope: other }],
      }),
    ).toThrow();
  },
);
test("rejects duplicate or mismatched invoice identities", () => {
  expect(() =>
    assessHistoricalOfferHistory(batch([entry(settled), entry(settled)])),
  ).toThrow();
  expect(() =>
    assessHistoricalOfferHistory(batch([entry(settled, "in-other")])),
  ).toThrow();
});
test("paid evidence choice is deterministic across scan order and payer changes", () => {
  const later: HistoricalOfferEvidence = {
    ...settled,
    invoiceId: "in-later",
    createdAt: 300,
    customerId: "new-customer",
    settlement: {
      ...settled.settlement,
      invoiceId: "in-later",
      customerId: "new-customer",
      settledAt: 400,
    },
  };
  expect(
    assessHistoricalOfferHistory(
      batch([entry(later, "in-later"), entry(settled)]),
    ),
  ).toEqual(
    assessHistoricalOfferHistory(
      batch([entry(settled), entry(later, "in-later")]),
    ),
  );
});
