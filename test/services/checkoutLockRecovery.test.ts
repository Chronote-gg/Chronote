/** @jest-environment node */
jest.mock("../../src/services/runtimeApiOperationService", () => ({
  runRuntimeApiOperation: jest.fn(
    jest.requireActual("../fixtures/runtimeApiOperation").runTestApiOperation,
  ),
}));
jest.mock("../../src/services/analyticsService", () => ({
  captureEvent: jest.fn(),
}));
import Stripe from "stripe";
import { runRuntimeApiOperation } from "../../src/services/runtimeApiOperationService";
import { UnresolvedBillingMutation } from "../../src/services/runtimeBillingOperationService";
import { expirePurchaseAttempt } from "../../src/services/purchaseReconciliation";
import * as purchaseRepository from "../../src/repositories/purchaseAttemptRepository";
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

// Rebuilt per test: the fixture's provider-expired set and persistent mock
// overrides must not leak between tests.
let { stripe, client } = initialPurchaseStripe();
let retrieve = stripe.checkout.sessions.retrieve;
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
  ({ stripe, client } = initialPurchaseStripe());
  retrieve = stripe.checkout.sessions.retrieve;
  request.stripe = client;
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

describe("supersede", () => {
  const otherPayer = { ...request, user: { id: "other" } };
  const refusedExpire = () =>
    new Stripe.errors.StripeInvalidRequestError({
      message: "Session is not open",
      statusCode: 400,
    });
  let firstAttemptId: string;
  beforeEach(() => {
    otherPayer.stripe = client;
    firstAttemptId =
      getMockStore().purchaseAttempts.get(purchaseGuildId)!.attemptId;
  });

  test("another payer supersedes a live open checkout with a fresh session", async () => {
    stripe.checkout.sessions.create.mockImplementationOnce(async () => ({
      ...sessionFields(),
      id: "cs_second",
      status: "open",
      url: "https://checkout.stripe.com/second",
    }));
    await expect(
      createCheckoutSession({ ...otherPayer, priceId: "price_pro" }),
    ).resolves.toBe("https://checkout.stripe.com/second");
    expect(stripe.checkout.sessions.expire).toHaveBeenCalledWith(
      "cs_first",
      undefined,
      { idempotencyKey: `purchase-supersede-${firstAttemptId}` },
    );
    expect(getMockStore().purchaseAttempts.get(purchaseGuildId)).toMatchObject({
      payerId: "other",
      state: "open",
      sessionId: "cs_second",
    });
  });

  test.each([
    { priceId: "price_pro" },
    { promotionCodeId: "promo_changed" },
    { allowPromotionCodes: false },
  ])(
    "the same payer changing payment terms %p supersedes the open checkout",
    async (change) => {
      await expect(
        createCheckoutSession({ ...request, ...change }),
      ).resolves.toContain("checkout.stripe.com");
      expect(stripe.checkout.sessions.expire).toHaveBeenCalledTimes(1);
      expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(2);
      expect(
        getMockStore().purchaseAttempts.get(purchaseGuildId)?.attemptId,
      ).not.toBe(firstAttemptId);
    },
  );

  test("a refused expire on a session completed in another tab returns billing, not a new checkout", async () => {
    Object.assign(stripe, paidProvider("sub_new"));
    stripe.checkout.sessions.expire.mockImplementationOnce(async () => {
      // payment completed in another tab between the first retrieve and the expire
      retrieve.mockResolvedValue({
        ...sessionFields(),
        id: "cs_first",
        status: "complete",
        subscription: "sub_new",
      });
      throw refusedExpire();
    });
    await expect(
      createCheckoutSession({ ...otherPayer, priceId: "price_pro" }),
    ).resolves.toBe(`/portal/server/${purchaseGuildId}/billing`);
    expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
  });

  test("a refused expire on a still-open session keeps purchase_pending", async () => {
    stripe.checkout.sessions.expire.mockRejectedValueOnce(refusedExpire());
    await expect(createCheckoutSession(otherPayer)).rejects.toThrow(
      "already in progress",
    );
    expect(getMockStore().purchaseAttempts.get(purchaseGuildId)).toMatchObject({
      attemptId: firstAttemptId,
      state: "open",
    });
    expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
  });

  test("an unknown expire outcome never releases the attempt", async () => {
    stripe.checkout.sessions.expire.mockRejectedValueOnce(
      new Error("socket hang up"),
    );
    await expect(createCheckoutSession(otherPayer)).rejects.toBeInstanceOf(
      UnresolvedBillingMutation,
    );
    expect(getMockStore().purchaseAttempts.get(purchaseGuildId)).toMatchObject({
      attemptId: firstAttemptId,
      state: "open",
    });
  });

  test("a webhook releasing the old attempt during supersede still yields one fresh checkout", async () => {
    stripe.checkout.sessions.expire.mockImplementationOnce(async (id) => {
      const expiredSession = {
        ...sessionFields(),
        id,
        status: "expired",
        url: null,
        subscription: null,
      };
      retrieve.mockResolvedValue(expiredSession);
      await expirePurchaseAttempt(client, expiredSession as never);
      return expiredSession;
    });
    await expect(createCheckoutSession(otherPayer)).resolves.toContain(
      "checkout.stripe.com",
    );
    expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(2);
  });

  test("a release write with a lost response is not mistaken for another writer", async () => {
    const real = purchaseRepository.getPurchaseRepository();
    const spy = jest
      .spyOn(purchaseRepository, "getPurchaseRepository")
      .mockReturnValue({
        ...real,
        compareAndWrite: async (...args) => {
          const written = await real.compareAndWrite(...args);
          if (args[0].state === "expired") throw new Error("response lost");
          return written;
        },
      });
    try {
      await expect(createCheckoutSession(otherPayer)).rejects.toBeInstanceOf(
        UnresolvedBillingMutation,
      );
      expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  test("an open attempt under incident review is never superseded", async () => {
    getMockStore().purchaseAttempts.get(purchaseGuildId)!.incidentKey =
      "PURCHASE#x#DUPLICATE#test#a#b";
    await expect(createCheckoutSession(otherPayer)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(stripe.checkout.sessions.expire).not.toHaveBeenCalled();
  });

  test("concurrent different choices leave one open attempt whose session is the only unexpired one", async () => {
    let n = 0;
    stripe.checkout.sessions.create.mockImplementation(
      async (params: { metadata: Record<string, string> }) => ({
        ...sessionFields(),
        metadata: params.metadata,
        id: `cs_${++n}`,
        status: "open",
        url: `https://checkout.stripe.com/${n}`,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      }),
    );
    await Promise.allSettled([
      createCheckoutSession({
        ...request,
        user: { id: "other" },
        priceId: "price_pro",
      }),
      createCheckoutSession({
        ...request,
        user: { id: "third" },
        priceId: "price_pro",
      }),
    ]);
    // includes cs_first from the setup call
    const created = (
      await Promise.all(
        stripe.checkout.sessions.create.mock.results.map((r) => r.value),
      )
    ).map((session) => session.id);
    const expired = stripe.checkout.sessions.expire.mock.calls.map(
      ([id]) => id,
    );
    const stored = getMockStore().purchaseAttempts.get(purchaseGuildId)!;
    expect(expired).toContain("cs_first");
    expect(stored.state).toBe("open");
    expect(created.filter((id) => !expired.includes(id))).toEqual([
      stored.sessionId,
    ]);
  });
});
