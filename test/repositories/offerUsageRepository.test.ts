/** @jest-environment node */
import { getOfferUsageRepository } from "../../src/repositories/offerUsageRepository";
import { getMockStore, resetMockStore } from "../../src/repositories/mockStore";
import { advanceAttempt } from "../../src/repositories/purchaseAttemptRepository";
import type { PurchaseAttempt } from "../../src/types/purchase";

const guildId = "111111111111111111";
const operation: PurchaseAttempt = {
  guildId,
  attemptId: "op-one",
  revision: "op-r1",
  payerId: "payer-one",
  mode: "test",
  fingerprint: "terms",
  createdAt: 100,
  state: "preparing",
  checkout: {},
};
const monthly = {
  guildId,
  mode: "test" as const,
  offerId: "basic_intro_v1" as const,
  revision: "offer-r1",
  state: "reserved" as const,
  operationId: "op-one",
  reservedAt: 100,
  terms: {
    priceId: "price-basic-month",
    couponId: "coupon-month",
    currency: "usd" as const,
    interval: "month" as const,
    regularUnitAmount: 1000,
    discountedUnitAmount: 600,
    durationMonths: 3,
  },
};
const settled = {
  ...monthly,
  revision: "offer-r2",
  state: "used" as const,
  usedAt: 200,
  settlement: {
    customerId: "cus-one",
    subscriptionId: "sub-one",
    subscriptionItemId: "si-one",
    invoiceId: "in-one",
    priceId: "price-basic-month",
    status: "paid" as const,
    amountPaid: 0,
    amountRemaining: 0,
    settledAt: 200,
  },
};
const released = {
  guildId,
  mode: "test" as const,
  offerId: "basic_intro_v1" as const,
  revision: "offer-r2",
  state: "unused" as const,
  released: {
    operationId: "op-one",
    reason: "checkout_expired" as const,
    resourceId: "cs-expired",
    verifiedAt: 200,
  },
};
const repo = getOfferUsageRepository();
const pointer = () => getMockStore().subscriptions.get(guildId);
const write = (next: unknown, expected: unknown = undefined, op = operation) =>
  repo.compareAndWrite({ next, expected, pointer: pointer(), operation: op });

beforeEach(() => {
  resetMockStore();
  getMockStore().purchaseAttempts.set(guildId, structuredClone(operation));
});

test("only one competing operation can reserve an unused monthly offer", async () => {
  const [first, replay] = await Promise.all([
    write(monthly),
    write({ ...monthly, revision: "loser" }),
  ]);
  expect([first, replay].filter(Boolean)).toHaveLength(1);
  expect(await repo.get(guildId, "basic_intro_v1", "test")).toEqual(monthly);
});

test("settled credit-covered monthly use does not consume the separate annual offer", async () => {
  expect(await write(monthly)).toBe(true);
  expect(await write(settled, monthly)).toBe(true);
  const annual = {
    ...monthly,
    offerId: "basic_annual_intro_v1",
    revision: "annual-r1",
    terms: {
      priceId: "price-basic-year",
      couponId: "coupon-year",
      currency: "usd",
      interval: "year",
      regularUnitAmount: 10000,
      discountedUnitAmount: 6000,
      durationMonths: 12,
    },
  };
  expect(await write(annual)).toBe(true);
  expect(await repo.get(guildId, "basic_intro_v1", "test")).toEqual(settled);
  expect(await repo.get(guildId, "basic_annual_intro_v1", "test")).toEqual(
    annual,
  );
});

test("a used offer survives replacement of the subscription, payer and purchase operation", async () => {
  expect(await write(monthly)).toBe(true);
  expect(await write(settled, monthly)).toBe(true);
  getMockStore().subscriptions.set(guildId, {
    guildId,
    tier: "free",
    status: "canceled",
    subscriptionType: "stripe",
    startDate: "now",
    stripeSubscriptionId: "sub-replacement",
    stripeSyncRevision: "new",
  });
  const newOperation = {
    ...operation,
    attemptId: "op-two",
    payerId: "payer-two",
    revision: "op-r2",
  };
  getMockStore().purchaseAttempts.set(guildId, newOperation);
  expect(await repo.get(guildId, "basic_intro_v1", "test")).toEqual(settled);
  await expect(
    write(
      { ...monthly, operationId: "op-two", revision: "offer-r3" },
      settled,
      newOperation,
    ),
  ).rejects.toThrow("Invalid offer usage transition");
});

test("verified expiration releases the reservation and permits a later attempt", async () => {
  expect(await write(monthly)).toBe(true);
  expect(await write(released, monthly)).toBe(true);
  const replacement = { ...operation, attemptId: "op-two", revision: "op-r2" };
  getMockStore().purchaseAttempts.set(guildId, replacement);
  const reserved = { ...monthly, revision: "offer-r3", operationId: "op-two" };
  expect(await write(reserved, released, replacement)).toBe(true);
  expect(await repo.get(guildId, "basic_intro_v1", "test")).toEqual(reserved);
});

test("a stale operation cannot consume or release the current reservation", async () => {
  expect(await write(monthly)).toBe(true);
  getMockStore().purchaseAttempts.set(
    guildId,
    advanceAttempt(operation, { state: "needs_review" }),
  );
  expect(await write(settled, monthly)).toBe(false);
  expect(await write(released, monthly)).toBe(false);
  expect(await repo.get(guildId, "basic_intro_v1", "test")).toEqual(monthly);
});

test("a stale subscription revision cannot reserve or finalize use", async () => {
  const expected = pointer();
  getMockStore().subscriptions.set(guildId, {
    guildId,
    tier: "basic",
    status: "active",
    subscriptionType: "stripe",
    startDate: "now",
    stripeSubscriptionId: "sub-other",
    stripeSyncRevision: "r2",
  });
  expect(
    await repo.compareAndWrite({
      next: monthly,
      expected: undefined,
      pointer: expected,
      operation,
    }),
  ).toBe(false);
  expect(await repo.get(guildId, "basic_intro_v1", "test")).toBeUndefined();
});

test("a stale usage revision cannot overwrite a verified release", async () => {
  expect(await write(monthly)).toBe(true);
  expect(await write(released, monthly)).toBe(true);
  expect(await write(settled, monthly)).toBe(false);
  expect(await repo.get(guildId, "basic_intro_v1", "test")).toEqual(released);
});

test.each([
  [{ ...monthly, operationId: "wrong-operation" }],
  [{ ...monthly, guildId: "222222222222222222" }],
  [{ ...monthly, mode: "live" }],
])("reservation rejects an operation scope mismatch %p", async (next) => {
  await expect(write(next)).rejects.toThrow("Offer operation scope mismatch");
});

test.each([
  [
    {
      ...settled,
      terms: { ...monthly.terms, couponId: "rotated-after-reservation" },
    },
  ],
  [
    {
      ...settled,
      settlement: { ...settled.settlement, priceId: "wrong-price" },
    },
  ],
  [{ ...settled, settlement: { ...settled.settlement, amountRemaining: 1 } }],
  [{ ...settled, settlement: { ...settled.settlement, amountPaid: -1 } }],
])(
  "cannot consume an offer using changed terms or unsettled evidence %p",
  async (next) => {
    expect(await write(monthly)).toBe(true);
    await expect(write(next, monthly)).rejects.toThrow();
    expect(await repo.get(guildId, "basic_intro_v1", "test")).toEqual(monthly);
  },
);

test("reads return isolated records and a different server or mode has no use", async () => {
  expect(await write(monthly)).toBe(true);
  const read = await repo.get(guildId, "basic_intro_v1", "test");
  Object.assign(read!, { state: "used" });
  expect(await repo.get(guildId, "basic_intro_v1", "test")).toEqual(monthly);
  expect(await repo.get(guildId, "basic_intro_v1", "live")).toBeUndefined();
  expect(
    await repo.get("222222222222222222", "basic_intro_v1", "test"),
  ).toBeUndefined();
});

test("ordinary historical paid subscriptions have no offer usage", async () => {
  getMockStore().subscriptions.set(guildId, {
    guildId,
    tier: "basic",
    status: "canceled",
    subscriptionType: "stripe",
    startDate: "now",
    stripeSubscriptionId: "sub-ordinary",
    stripeSyncRevision: "ordinary",
  });
  expect(await repo.get(guildId, "basic_intro_v1", "test")).toBeUndefined();
  expect(
    await repo.get(guildId, "basic_annual_intro_v1", "test"),
  ).toBeUndefined();
});
