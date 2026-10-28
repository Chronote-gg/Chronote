/** @jest-environment node */
import "../fixtures/admittedApi";
import { testWriterImageDigest } from "../fixtures/historyWriterBoundary";
jest.mock("../../src/services/ledgerWriterRuntime", () => ({
  readLedgerWriterRuntime: jest.fn(async () => ({
    taskArn: "arn:aws:ecs:us-east-1:123456789012:task/test/task-one",
    imageDigest: testWriterImageDigest,
  })),
}));
jest.mock("../../src/services/analyticsService", () => ({
  captureEvent: jest.fn(),
}));
import { getOfferUsageRepository } from "../../src/repositories/offerUsageRepository";
import { config } from "../../src/services/configService";
import {
  createCheckoutSession,
  getBillingSnapshot,
} from "../../src/services/billingService";
import { expirePurchaseAttempt } from "../../src/services/purchaseReconciliation";
import { getGuildBasicIntroOffer } from "../../src/services/basicIntroOfferService";
import { getMockStore, resetMockStore } from "../../src/repositories/mockStore";
import { clearGuildSubscriptionCache } from "../../src/services/subscriptionService";
import {
  introNow,
  introSettings,
  introPurchaseFixture,
} from "../fixtures/introOfferPurchase";

beforeEach(() => {
  config.stripe.introOfferLedgerEnabled = true;
  resetMockStore();
  clearGuildSubscriptionCache();
  jest.clearAllMocks();
  jest.useFakeTimers({ now: introNow });
  Object.assign(config.stripe.basicIntroOffer, introSettings);
});
afterEach(() => {
  jest.useRealTimers();
  config.subscription.forceTier = "";
  clearGuildSubscriptionCache();
});

const introUsage = (guildId: string) =>
  getOfferUsageRepository().get(guildId, "basic_intro_v1", "test");

async function abandonIntroCheckout() {
  const fixture = introPurchaseFixture();
  await createCheckoutSession({
    ...fixture.request,
    expectedOffer: "basic_intro_v1",
  });
  jest.setSystemTime(introNow + 3601 * 1000);
  const expiredSession =
    await fixture.request.stripe.checkout.sessions.expire("cs_intro");
  return { ...fixture, expiredSession };
}

test("billing snapshot after an abandoned introductory checkout quotes the offer again and releases its reservation", async () => {
  const { request } = await abandonIntroCheckout();
  const snapshot = await getBillingSnapshot({
    stripe: request.stripe,
    guildId: request.guildId,
    payerId: "payer",
  });
  expect(snapshot.introOffer).toMatchObject({
    status: "available",
    id: "basic_intro_v1",
  });
  expect(getMockStore().purchaseAttempts.get(request.guildId)?.state).toBe(
    "expired",
  );
  expect(await introUsage(request.guildId)).toMatchObject({
    state: "unused",
    released: { resourceId: "cs_intro", reason: "checkout_expired" },
  });
});

test("webhook and read-path expiry release the introductory reservation exactly once", async () => {
  const { request, stripe, expiredSession } = await abandonIntroCheckout();
  stripe.checkout.sessions.retrieve.mockClear();
  await expirePurchaseAttempt(request.stripe, expiredSession);
  const before = await introUsage(request.guildId);
  await getBillingSnapshot({
    stripe: request.stripe,
    guildId: request.guildId,
    payerId: "payer",
  });
  expect(await introUsage(request.guildId)).toEqual(before);
  expect(stripe.checkout.sessions.retrieve).toHaveBeenCalledTimes(1);
});

test("another payer superseding an introductory checkout releases the old reservation once and reserves it afresh", async () => {
  const { request } = introPurchaseFixture();
  await createCheckoutSession({ ...request, expectedOffer: "basic_intro_v1" });
  const first = getMockStore().purchaseAttempts.get(request.guildId)!;
  await expect(
    createCheckoutSession({ ...request, user: { id: "other" } }),
  ).resolves.toContain("checkout.stripe.com");
  const next = getMockStore().purchaseAttempts.get(request.guildId)!;
  expect(next.attemptId).not.toBe(first.attemptId);
  expect(await introUsage(request.guildId)).toMatchObject({
    state: "reserved",
    operationId: next.attemptId,
  });
});

test("the same payer switching from the intro offer to a promotion supersedes it", async () => {
  const { request } = introPurchaseFixture();
  await createCheckoutSession({ ...request, expectedOffer: "basic_intro_v1" });
  await expect(
    createCheckoutSession({
      ...request,
      promotionCodeId: "promo_other",
      promotionCode: "OTHER",
      offerChoice: "promotion",
      expectedOffer: "none",
    }),
  ).resolves.toContain("checkout.stripe.com");
  expect(
    getMockStore().purchaseAttempts.get(request.guildId)?.checkout.metadata,
  ).toMatchObject({ purchase_offer_choice: "promotion" });
  expect(await introUsage(request.guildId)).toMatchObject({
    state: "unused",
    released: { reason: "checkout_expired" },
  });
});

test("an expiry webhook landing during an introductory supersede still yields one fresh checkout", async () => {
  const { request, stripe } = introPurchaseFixture();
  await createCheckoutSession({ ...request, expectedOffer: "basic_intro_v1" });
  const first = getMockStore().purchaseAttempts.get(request.guildId)!;
  const expire = stripe.checkout.sessions.expire.getMockImplementation()!;
  let releasedByWebhook: unknown;
  stripe.checkout.sessions.expire.mockImplementationOnce(async (id) => {
    const expiredSession = await expire(id);
    // Stripe emits checkout.session.expired; the webhook commits first.
    await expirePurchaseAttempt(request.stripe, expiredSession as never);
    releasedByWebhook = await introUsage(request.guildId);
    return expiredSession;
  });
  await expect(
    createCheckoutSession({ ...request, user: { id: "other" } }),
  ).resolves.toContain("checkout.stripe.com");
  expect(releasedByWebhook).toMatchObject({
    state: "unused",
    released: { operationId: first.attemptId, reason: "checkout_expired" },
  });
  const next = getMockStore().purchaseAttempts.get(request.guildId)!;
  expect(next).toMatchObject({ payerId: "other", state: "open" });
  expect(await introUsage(request.guildId)).toMatchObject({
    state: "reserved",
    operationId: next.attemptId,
  });
});

test("an open Pro checkout does not make the Basic offer unavailable", async () => {
  const { request } = introPurchaseFixture();
  await createCheckoutSession({
    ...request,
    priceId: "price_pro",
    tier: "pro",
    interval: "month",
  });
  expect(
    await getGuildBasicIntroOffer({
      stripe: request.stripe,
      guildId: request.guildId,
      payerId: "other",
    }),
  ).toMatchObject({ status: "available", id: "basic_intro_v1" });
});

test("another payer is quoted the reserved offer and the superseding checkout accepts that quote", async () => {
  const { request } = introPurchaseFixture();
  await createCheckoutSession({ ...request, expectedOffer: "basic_intro_v1" });
  const quote = await getGuildBasicIntroOffer({
    stripe: request.stripe,
    guildId: request.guildId,
    payerId: "other",
  });
  expect(quote).toMatchObject({ status: "available", id: "basic_intro_v1" });
  expect(quote).not.toHaveProperty("reservedForCheckout");
  await expect(
    createCheckoutSession({
      ...request,
      user: { id: "other" },
      expectedOffer: "basic_intro_v1",
    }),
  ).resolves.toContain("checkout.stripe.com");
});

test("a preparing attempt still makes the offer unavailable to another payer", async () => {
  const { request, stripe } = introPurchaseFixture();
  // A lost create response leaves the attempt `preparing`.
  stripe.checkout.sessions.create.mockRejectedValueOnce(
    new Error("lost response"),
  );
  await expect(
    createCheckoutSession({ ...request, expectedOffer: "basic_intro_v1" }),
  ).rejects.toThrow("lost response");
  expect(getMockStore().purchaseAttempts.get(request.guildId)?.state).toBe(
    "preparing",
  );
  expect(
    await getGuildBasicIntroOffer({
      stripe: request.stripe,
      guildId: request.guildId,
      payerId: "other",
    }),
  ).toEqual({ status: "unavailable" });
});
