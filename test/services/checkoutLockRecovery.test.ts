/** @jest-environment node */
jest.mock("../../src/services/runtimeApiOperationService", () => ({
  runRuntimeApiOperation: jest.fn(
    jest.requireActual("../fixtures/runtimeApiOperation").runTestApiOperation,
  ),
}));
jest.mock("../../src/services/analyticsService", () => ({
  captureEvent: jest.fn(),
}));
import { runRuntimeApiOperation } from "../../src/services/runtimeApiOperationService";
import { RuntimeAdmissionUnavailable } from "../../src/services/runtimeAdmissionError";
import { createCheckoutSession } from "../../src/services/billingService";
import { releaseExpiredPurchaseAttempt } from "../../src/services/initialPurchaseService";
import { prepareBillingChange } from "../../src/services/billingChangeService";
import { config } from "../../src/services/configService";
import { getMockStore, resetMockStore } from "../../src/repositories/mockStore";
import {
  initialPurchaseStripe,
  paidProvider,
  purchaseGuildId,
  sessionFields,
} from "../fixtures/initialPurchaseStripe";

const { stripe, client } = initialPurchaseStripe();
const retrieve = stripe.checkout.sessions.retrieve;
const request = {
  stripe: client,
  user: { id: "payer" },
  guildId: purchaseGuildId,
  priceId: "price_basic",
};
const release = () =>
  releaseExpiredPurchaseAttempt({ stripe: client, guildId: purchaseGuildId });
const attemptState = () =>
  getMockStore().purchaseAttempts.get(purchaseGuildId)?.state;
const providerExpired = () => ({
  ...sessionFields(),
  id: "cs_first",
  status: "expired",
  url: null,
  subscription: null,
});
const pastExpiry = () => {
  getMockStore().purchaseAttempts.get(purchaseGuildId)!.checkout.expires_at =
    Math.floor(Date.now() / 1000) - 1;
};

beforeEach(async () => {
  resetMockStore();
  jest.clearAllMocks();
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
  await createCheckoutSession(request);
  retrieve.mockClear();
});

test("billing read leaves a live open checkout untouched without calling Stripe", async () => {
  await release();
  expect(stripe.checkout.sessions.retrieve).not.toHaveBeenCalled();
  expect(attemptState()).toBe("open");
});

test("billing read releases a provider-confirmed expired checkout past its local expiry", async () => {
  pastExpiry();
  retrieve.mockResolvedValueOnce(providerExpired());
  await release();
  expect(retrieve).toHaveBeenCalledTimes(1);
  expect(attemptState()).toBe("expired");
});

test("billing read keeps a past-expiry session that Stripe still reports open", async () => {
  pastExpiry();
  await release();
  expect(attemptState()).toBe("open");
});

test("billing read reconciles a past-expiry session Stripe reports complete", async () => {
  pastExpiry();
  retrieve.mockResolvedValueOnce({
    ...sessionFields(),
    id: "cs_first",
    status: "complete",
    subscription: "sub_new",
  });
  Object.assign(stripe, paidProvider("sub_new"));
  await release();
  expect(
    getMockStore().subscriptions.get(purchaseGuildId)?.stripeSubscriptionId,
  ).toBe("sub_new");
  expect(attemptState()).toBe("completed");
});

test("billing read degrades when Stripe is unreachable", async () => {
  pastExpiry();
  retrieve.mockRejectedValueOnce(new Error("connection reset"));
  await expect(release()).resolves.toBeUndefined();
  expect(attemptState()).toBe("open");
  expect(console.warn).toHaveBeenCalledWith(
    "Expired checkout release deferred",
    expect.objectContaining({ guildId: purchaseGuildId }),
  );
});

test("billing read degrades when the runtime is not admitting billing work", async () => {
  pastExpiry();
  jest
    .mocked(runRuntimeApiOperation)
    .mockRejectedValueOnce(
      new RuntimeAdmissionUnavailable("Runtime is not accepting work"),
    );
  await expect(release()).resolves.toBeUndefined();
  expect(retrieve).not.toHaveBeenCalled();
});

test("billing read tolerates a concurrent writer winning the release", async () => {
  pastExpiry();
  retrieve.mockImplementationOnce(async () => {
    const row = getMockStore().purchaseAttempts.get(purchaseGuildId)!;
    getMockStore().purchaseAttempts.set(purchaseGuildId, {
      ...row,
      state: "expired",
      revision: "webhook",
    });
    return providerExpired();
  });
  await expect(release()).resolves.toBeUndefined();
  expect(getMockStore().purchaseAttempts.get(purchaseGuildId)).toMatchObject({
    state: "expired",
    revision: "webhook",
  });
});

test("billing read never touches an open attempt under incident review", async () => {
  pastExpiry();
  getMockStore().purchaseAttempts.get(purchaseGuildId)!.incidentKey =
    "PURCHASE#x#DUPLICATE#test#a#b";
  await release();
  expect(retrieve).not.toHaveBeenCalled();
});

describe("plan change", () => {
  const transitionsEnabled = config.stripe.subscriptionTransitionsEnabled;
  const change = () =>
    prepareBillingChange({
      stripe: client,
      guildId: purchaseGuildId,
      payerId: "payer",
      selection: { tier: "pro", interval: "month", expectedOffer: "none" },
    });

  beforeEach(() => {
    getMockStore().subscriptions.set(purchaseGuildId, {
      guildId: purchaseGuildId,
      tier: "basic",
      status: "active",
      subscriptionType: "stripe",
      startDate: "2026-01-01",
      stripeSubscriptionId: "sub_source",
    });
    config.stripe.subscriptionTransitionsEnabled = true;
    Object.assign(stripe, {
      subscriptions: {
        retrieve: jest.fn().mockRejectedValue(new Error("source read reached")),
      },
    });
  });

  afterEach(() => {
    config.stripe.subscriptionTransitionsEnabled = transitionsEnabled;
    Reflect.deleteProperty(stripe, "subscriptions");
  });

  test("releases a provider-expired checkout before its pending check", async () => {
    pastExpiry();
    retrieve.mockResolvedValueOnce(providerExpired());
    await expect(change()).rejects.toThrow("source read reached");
    expect(attemptState()).toBe("expired");
  });

  test("still blocks on a live open checkout without calling Stripe", async () => {
    await expect(change()).rejects.toMatchObject({
      reason: "purchase_pending",
    });
    expect(retrieve).not.toHaveBeenCalled();
  });

  test("keeps the pending error when expiry cannot be verified", async () => {
    pastExpiry();
    retrieve.mockRejectedValueOnce(new Error("connection reset"));
    await expect(change()).rejects.toMatchObject({
      reason: "purchase_pending",
    });
    expect(retrieve).toHaveBeenCalledTimes(1);
  });
});
