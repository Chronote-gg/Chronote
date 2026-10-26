/** @jest-environment node */
import { readIntroOfferEligibility } from "../../src/services/introOfferEligibility";
import { getMockStore, resetMockStore } from "../../src/repositories/mockStore";
import { historyWriterBoundaryKey } from "../../src/types/historyWriterBoundary";
import { historicalOfferImportKey } from "../../src/types/historicalOfferImport";
import { offerUsageKey } from "../../src/types/offerUsage";
import {
  historyWriterBoundaryFixture,
  testWriterImageDigest,
  seedUnusedOfferCoverage,
} from "../fixtures/historyWriterBoundary";
const guildId = "111111111111111111";
const input = {
  guildId,
  accountId: "acct-owned",
  mode: "test" as const,
  offerId: "basic_intro_v1" as const,
  writerImageDigest: testWriterImageDigest,
};
const coverage = {
  guildId,
  accountId: "acct-owned",
  mode: "test" as const,
  offerId: "basic_intro_v1" as const,
  revision: "coverage",
  runId: "run",
  createdBefore: 1000,
  verifiedAt: 2000000,
  enumeration: "complete" as const,
  catchUp: "complete" as const,
  state: "unused" as const,
  writerBoundaryRevision: "boundary-r1",
};
beforeEach(() => resetMockStore());
function covered() {
  getMockStore().historyWriterBoundaries.set(
    historyWriterBoundaryKey(input.accountId, input.mode),
    historyWriterBoundaryFixture(),
  );
  getMockStore().historicalOfferImports.set(
    historicalOfferImportKey(
      guildId,
      input.offerId,
      input.mode,
      input.accountId,
    ),
    coverage,
  );
}
test("missing usage and missing coverage are unresolved, not unused", async () => {
  expect(await readIntroOfferEligibility(input)).toBe("unresolved");
});
test("complete scoped coverage makes the selected offer unused regardless of past regular subscriptions", async () => {
  covered();
  expect(await readIntroOfferEligibility(input)).toBe("unused");
});
test("monthly coverage cannot clear a missing annual history record", async () => {
  covered();
  expect(
    await readIntroOfferEligibility({
      ...input,
      offerId: "basic_annual_intro_v1",
    }),
  ).toBe("unresolved");
});
test("another account, mode or server does not inherit unused coverage", async () => {
  covered();
  expect(
    await readIntroOfferEligibility({ ...input, accountId: "other" }),
  ).toBe("unresolved");
  expect(await readIntroOfferEligibility({ ...input, mode: "live" })).toBe(
    "unresolved",
  );
  expect(
    await readIntroOfferEligibility({
      ...input,
      guildId: "222222222222222222",
    }),
  ).toBe("unresolved");
});
test("invalidated or changed writer deployment leaves coverage unresolved", async () => {
  covered();
  getMockStore().historyWriterBoundaries.clear();
  expect(await readIntroOfferEligibility(input)).toBe("unresolved");
  covered();
  expect(
    await readIntroOfferEligibility({
      ...input,
      writerImageDigest: "sha256:" + "b".repeat(64),
    }),
  ).toBe("unresolved");
});
test("a used offer remains consumed across payer/control replacement and boundary invalidation", async () => {
  getMockStore().offerUsages.set(
    offerUsageKey(guildId, input.offerId, input.mode),
    {
      guildId,
      mode: "test",
      offerId: input.offerId,
      revision: "used",
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
        customerId: "old-payer",
        subscriptionId: "old-sub",
        subscriptionItemId: "item",
        invoiceId: "paid",
        priceId: "price",
        status: "paid",
        amountPaid: 0,
        amountRemaining: 0,
        settledAt: 200,
      },
    },
  );
  expect(await readIntroOfferEligibility(input)).toBe("used");
  expect(
    await readIntroOfferEligibility({
      ...input,
      offerId: "basic_annual_intro_v1",
    }),
  ).toBe("unresolved");
});

test.each(["basic_intro_v1", "basic_annual_intro_v1"] as const)(
  "accepting %s leaves the other offer available, with no restart",
  async (first) => {
    seedUnusedOfferCoverage();
    const interval = first === "basic_intro_v1" ? "month" : "year";
    const unit = interval === "month" ? 1000 : 10000;
    getMockStore().offerUsages.set(offerUsageKey(guildId, first, "test"), {
      guildId,
      mode: "test",
      offerId: first,
      revision: "used",
      state: "used",
      operationId: "original",
      reservedAt: 100,
      usedAt: 200,
      terms: {
        priceId: "price",
        couponId: "coupon",
        currency: "usd",
        interval,
        regularUnitAmount: unit,
        discountedUnitAmount: unit * 0.6,
        durationMonths: interval === "month" ? 3 : 12,
      },
      settlement: {
        customerId: "old",
        subscriptionId: "old",
        subscriptionItemId: "item",
        invoiceId: "paid",
        priceId: "price",
        status: "paid",
        amountPaid: 0,
        amountRemaining: 0,
        settledAt: 200,
      },
    } as never);
    expect(await readIntroOfferEligibility({ ...input, offerId: first })).toBe(
      "used",
    );
    expect(
      await readIntroOfferEligibility({
        ...input,
        offerId:
          first === "basic_intro_v1"
            ? "basic_annual_intro_v1"
            : "basic_intro_v1",
      }),
    ).toBe("unused");
    getMockStore().subscriptions.delete(guildId);
    getMockStore().purchaseAttempts.clear();
    expect(await readIntroOfferEligibility({ ...input, offerId: first })).toBe(
      "used",
    );
  },
);
