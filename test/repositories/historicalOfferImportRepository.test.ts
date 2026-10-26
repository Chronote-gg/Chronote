/** @jest-environment node */
import { historyWriterBoundaryFixture } from "../fixtures/historyWriterBoundary";
import { historyWriterBoundaryKey } from "../../src/types/historyWriterBoundary";
import { getHistoricalOfferImportRepository } from "../../src/repositories/historicalOfferImportRepository";
import { getMockStore, resetMockStore } from "../../src/repositories/mockStore";
import type { PurchaseAttempt } from "../../src/types/purchase";
import type { OfferUsage } from "../../src/types/offerUsage";

const guildId = "111111111111111111";
const currentOperation: PurchaseAttempt = {
  guildId,
  attemptId: "current",
  revision: "current-r1",
  payerId: "new-payer",
  mode: "test",
  fingerprint: "new",
  createdAt: 300,
  state: "open",
  checkout: {},
};
const used: OfferUsage = {
  guildId,
  mode: "test",
  offerId: "basic_intro_v1",
  revision: "historical-r1",
  state: "used",
  operationId: "original",
  reservedAt: 100,
  usedAt: 200,
  terms: {
    priceId: "price",
    couponId: "coupon",
    currency: "usd",
    interval: "month",
    regularUnitAmount: 1000,
    discountedUnitAmount: 600,
    durationMonths: 3,
  },
  settlement: {
    customerId: "original-payer",
    subscriptionId: "original-sub",
    subscriptionItemId: "item",
    invoiceId: "invoice",
    priceId: "price",
    status: "paid",
    amountPaid: 0,
    amountRemaining: 0,
    settledAt: 200,
  },
};
const record = {
  guildId,
  mode: "test",
  accountId: "acct-owned",
  offerId: "basic_intro_v1",
  revision: "import-r1",
  runId: "run",
  createdBefore: 1000,
  verifiedAt: 2000000,
  enumeration: "complete",
  catchUp: "complete",
  state: "used",
  sourceInvoiceId: "invoice",
};
const repo = getHistoricalOfferImportRepository();
const write = (overrides = {}) =>
  repo.compareAndWrite({
    next: record,
    expected: undefined,
    usageNext: used,
    usageExpected: undefined,
    pointer: undefined,
    operation: currentOperation,
    ...overrides,
  });
beforeEach(() => {
  resetMockStore();
  getMockStore().subscriptions.delete(guildId);
  getMockStore().purchaseAttempts.set(
    guildId,
    structuredClone(currentOperation),
  );
});
test("imports zero-cash use without replacing active purchase control", async () => {
  expect(await write()).toBe(true);
  expect(
    await repo.get(guildId, "basic_intro_v1", "test", "acct-owned"),
  ).toEqual(record);
  expect(getMockStore().purchaseAttempts.get(guildId)).toEqual(
    currentOperation,
  );
  expect(
    getMockStore().offerUsages.get("OFFER#test#" + guildId + "#basic_intro_v1"),
  ).toEqual(used);
});
test("a concurrent normal reservation wins over stale historical import", async () => {
  const reserved: OfferUsage = {
    ...used,
    state: "reserved",
    operationId: "current",
  };
  getMockStore().offerUsages.set(
    "OFFER#test#" + guildId + "#basic_intro_v1",
    reserved,
  );
  expect(await write()).toBe(false);
  expect(
    await repo.get(guildId, "basic_intro_v1", "test", "acct-owned"),
  ).toBeUndefined();
});
test("absence of an operation is fenced against a new operation", async () => {
  expect(await write({ operation: undefined })).toBe(false);
});
test("operation replacement prevents an old import writing", async () => {
  getMockStore().purchaseAttempts.set(guildId, {
    ...currentOperation,
    revision: "new-revision",
  });
  expect(await write()).toBe(false);
});
test("a subscription appearing after read prevents import", async () => {
  getMockStore().subscriptions.set(guildId, {
    guildId,
    stripeSubscriptionId: "new-sub",
  });
  expect(await write()).toBe(false);
});
test("two import attempts cannot both apply the same absent history", async () => {
  const results = await Promise.all([write(), write()]);
  expect(results.filter(Boolean)).toHaveLength(1);
});
test("existing used history is immutable, including a different successful source", async () => {
  getMockStore().offerUsages.set(
    "OFFER#test#" + guildId + "#basic_intro_v1",
    used,
  );
  await expect(
    write({
      usageExpected: used,
      usageNext: { ...used, revision: "replacement" },
    }),
  ).rejects.toThrow();
  expect(
    await write({
      usageExpected: used,
      usageNext: undefined,
      next: { ...record, sourceInvoiceId: "another-paid-source" },
    }),
  ).toBe(true);
  expect(
    getMockStore().offerUsages.get("OFFER#test#" + guildId + "#basic_intro_v1"),
  ).toEqual(used);
});
test("full ordinary history publishes coverage without fabricating unused usage", async () => {
  const base = withoutSource();
  const boundary = historyWriterBoundaryFixture();
  getMockStore().historyWriterBoundaries.set(
    historyWriterBoundaryKey(boundary.accountId, boundary.mode),
    boundary,
  );
  const unused = {
    ...base,
    state: "unused",
    writerBoundaryRevision: boundary.revision,
  };
  expect(await write({ next: unused, usageNext: undefined, boundary })).toBe(
    true,
  );
  expect(getMockStore().offerUsages.size).toBe(0);
});
test.each([{ enumeration: "incomplete" }, { catchUp: "pending" }])(
  "incomplete history cannot publish unused coverage %o",
  async (change) => {
    const base = withoutSource();
    await expect(
      write({
        next: { ...base, ...change, state: "unused" },
        usageNext: undefined,
      }),
    ).rejects.toThrow();
  },
);
test("unused coverage cannot erase a reserved offer", async () => {
  const reserved: OfferUsage = { ...used, state: "reserved" };
  Reflect.deleteProperty(reserved, "settlement");
  Reflect.deleteProperty(reserved, "usedAt");
  const r = withoutSource();
  await expect(
    write({
      next: { ...r, state: "unused" },
      usageNext: undefined,
      usageExpected: reserved,
    }),
  ).rejects.toThrow();
});
test("wrong server or mode cannot write an imported use", async () => {
  await expect(
    write({ next: { ...record, guildId: "222222222222222222" } }),
  ).rejects.toThrow();
  await expect(write({ next: { ...record, mode: "live" } })).rejects.toThrow();
});

function withoutSource() {
  const copy = { ...record };
  Reflect.deleteProperty(copy, "sourceInvoiceId");
  return copy;
}

test("used history cannot be imported from a future verification cutoff", async () => {
  await expect(
    write({ next: { ...record, verifiedAt: 999999 } }),
  ).rejects.toThrow();
  await expect(
    write({
      next: { ...record, verifiedAt: 1000000 },
      usageNext: {
        ...used,
        settlement: { ...used.settlement, settledAt: 1000001 },
      },
    }),
  ).rejects.toThrow();
});
test("older coverage cannot overwrite a newer run", async () => {
  expect(await write()).toBe(true);
  await expect(
    write({
      expected: record,
      next: { ...record, revision: "older", createdBefore: 999 },
      usageNext: undefined,
      usageExpected: used,
    }),
  ).rejects.toThrow();
});
