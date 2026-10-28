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
