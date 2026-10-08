/** @jest-environment node */
import { getMockStore } from "../../src/repositories/mockStore";

import { createCheckoutSession } from "../../src/services/billingService";
import { resetMockStore } from "../../src/repositories/mockStore";
import type { StripeClient } from "../../src/types/stripe";
import { captureEvent } from "../../src/services/analyticsService";
jest.mock("../../src/services/analyticsService", () => ({
  captureEvent: jest.fn(),
}));

const guildId = "111111111111111111";
function sessionFields() {
  const attempt = getMockStore().purchaseAttempts.get(guildId);
  return {
    customer: "cus_first",
    livemode: false,
    metadata: {
      guild_id: guildId,
      purchase_attempt_id: attempt?.attemptId ?? "",
    },
  };
}
function fixture() {
  const stripe = {
    customers: {
      list: jest.fn(async () => ({ data: [], has_more: false })),
      create: jest.fn(async () => ({ id: "cus_first" })),
      retrieve: jest.fn(async () => ({
        id: "cus_first",
        metadata: { discord_id: "payer" },
      })),
    },
    checkout: {
      sessions: {
        create: jest.fn(async () => ({
          ...sessionFields(),
          id: "cs_first",
          status: "open",
          url: "https://checkout.stripe.com/first",
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        })),
        retrieve: jest.fn(async () => ({
          ...sessionFields(),
          id: "cs_first",
          status: "open",
          url: "https://checkout.stripe.com/first",
          customer: "cus_first",
          subscription: null,
          metadata: sessionFields().metadata,
          livemode: false,
        })),
      },
    },
  };
  return { stripe, client: stripe as unknown as StripeClient };
}
beforeEach(() => {
  resetMockStore();
  jest.clearAllMocks();
});
test.each([2, 3])(
  "reservation handles %s conflicts before provider work",
  async (conflicts) => {
    const { stripe, client } = fixture();
    const repositoryModule =
      await import("../../src/repositories/purchaseAttemptRepository");
    const real = repositoryModule.getPurchaseRepository();
    const compare = jest.fn(real.compareAndWrite);
    for (let i = 0; i < conflicts; i++) compare.mockResolvedValueOnce(false);
    const spy = jest
      .spyOn(repositoryModule, "getPurchaseRepository")
      .mockReturnValue({
        ...real,
        compareAndWrite: compare,
      });
    try {
      const result = createCheckoutSession({
        stripe: client,
        user: { id: "payer" },
        guildId,
        priceId: "price_basic",
      });
      if (conflicts === 2) {
        await expect(result).resolves.toContain("checkout.stripe.com");
        expect(stripe.customers.create).toHaveBeenCalledTimes(1);
        expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
      } else {
        await expect(result).rejects.toMatchObject({ code: "BAD_REQUEST" });
        expect(compare).toHaveBeenCalledTimes(3);
        expect(stripe.customers.create).not.toHaveBeenCalled();
        expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
      }
    } finally {
      spy.mockRestore();
    }
  },
);
test("two different payers cannot obtain simultaneous first-purchase sessions", async () => {
  const { stripe, client } = fixture();
  const results = await Promise.allSettled(
    ["payer", "other"].map((id) =>
      createCheckoutSession({
        stripe: client,
        user: { id },
        guildId,
        priceId: "price_basic",
      }),
    ),
  );
  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
  expect(results.find((result) => result.status === "rejected")).toMatchObject({
    reason: { code: "BAD_REQUEST" },
  });
});

test("lost Checkout response replays exactly the original request and idempotency key", async () => {
  const { stripe, client } = fixture();
  stripe.checkout.sessions.create.mockRejectedValueOnce(
    new Error("lost response"),
  );
  const request = {
    stripe: client,
    user: { id: "payer" },
    guildId,
    priceId: "price_basic",
  };
  await expect(createCheckoutSession(request)).rejects.toThrow("lost response");
  await expect(createCheckoutSession(request)).resolves.toContain(
    "checkout.stripe.com",
  );
  expect(stripe.checkout.sessions.create.mock.calls[1]).toEqual(
    stripe.checkout.sessions.create.mock.calls[0],
  );
  expect(stripe.customers.create).toHaveBeenCalledTimes(1);
});

test("frozen customer create survives a lost response without relisting", async () => {
  const { stripe, client } = fixture();
  stripe.customers.create.mockRejectedValueOnce(
    new Error("customer response lost"),
  );
  const request = {
    stripe: client,
    user: { id: "payer", email: "payer@example.test" },
    guildId,
    priceId: "price_basic",
  };
  await expect(createCheckoutSession(request)).rejects.toThrow(
    "customer response lost",
  );
  await createCheckoutSession(request);
  expect(stripe.customers.list).toHaveBeenCalledTimes(1);
  expect(stripe.customers.create.mock.calls[1]).toEqual(
    stripe.customers.create.mock.calls[0],
  );
});

test("an open provider session is not released at the local deadline", async () => {
  const { stripe, client } = fixture();
  const request = {
    stripe: client,
    user: { id: "payer" },
    guildId,
    priceId: "price_basic",
  };
  await createCheckoutSession(request);
  const { getMockStore } = await import("../../src/repositories/mockStore");
  const attempt = getMockStore().purchaseAttempts.get(guildId)!;
  attempt.createdAt = Date.now() - 48 * 60 * 60 * 1000;
  await expect(createCheckoutSession(request)).resolves.toContain(
    "checkout.stripe.com",
  );
  expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
});

test("complete session with delayed webhook reconciles before directing to billing", async () => {
  const { stripe, client } = fixture();
  const request = {
    stripe: client,
    user: { id: "payer" },
    guildId,
    priceId: "price_basic",
  };
  await createCheckoutSession(request);
  const { getMockStore } = await import("../../src/repositories/mockStore");
  const attempt = getMockStore().purchaseAttempts.get(guildId)!;
  stripe.checkout.sessions.retrieve.mockResolvedValueOnce({
    ...sessionFields(),
    id: "cs_first",
    status: "complete",
    url: null,
    customer: "cus_first",
    subscription: "sub_new",
    metadata: { guild_id: guildId, purchase_attempt_id: attempt.attemptId },
    livemode: false,
  } as never);
  Object.assign(stripe, {
    subscriptions: {
      retrieve: jest.fn(async () => ({
        id: "sub_new",
        status: "active",
        customer: "cus_first",
        metadata: {
          guild_id: guildId,
          discord_id: "payer",
          purchase_attempt_id: attempt.attemptId,
        },
        livemode: false,
        created: 100,
        start_date: 100,
        items: {
          data: [{ price: { id: "price_basic" }, current_period_end: 200 }],
        },
      })),
    },
  });
  await expect(createCheckoutSession(request)).resolves.toBe(
    `/portal/server/${guildId}/billing`,
  );
  expect(getMockStore().subscriptions.get(guildId)?.stripeSubscriptionId).toBe(
    "sub_new",
  );
  expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
});

test("unknown create outcome becomes review-required after safe replay window", async () => {
  const { stripe, client } = fixture();
  stripe.checkout.sessions.create.mockRejectedValueOnce(new Error("unknown"));
  const request = {
    stripe: client,
    user: { id: "payer" },
    guildId,
    priceId: "price_basic",
  };
  await expect(createCheckoutSession(request)).rejects.toThrow();
  const { getMockStore } = await import("../../src/repositories/mockStore");
  getMockStore().purchaseAttempts.get(guildId)!.createdAt =
    Date.now() - 25 * 60 * 60 * 1000;
  await expect(createCheckoutSession(request)).rejects.toMatchObject({
    code: "BAD_REQUEST",
  });
  expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
  expect(getMockStore().purchaseAttempts.get(guildId)?.state).toBe(
    "needs_review",
  );
});

test("another payer can replace a provider-confirmed abandoned session", async () => {
  const { stripe, client } = fixture();
  await createCheckoutSession({
    stripe: client,
    user: { id: "payer" },
    guildId,
    priceId: "price_basic",
  });
  stripe.checkout.sessions.retrieve.mockResolvedValueOnce({
    ...sessionFields(),
    id: "cs_first",
    status: "expired",
    url: null,
    customer: "cus_first",
    subscription: null,
    metadata: sessionFields().metadata,
    livemode: false,
  } as never);
  await expect(
    createCheckoutSession({
      stripe: client,
      user: { id: "other" },
      guildId,
      priceId: "price_pro",
    }),
  ).resolves.toContain("checkout.stripe.com");
  expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(2);
});

test("a same-pointer revision change during provider creation prevents returning a payable URL", async () => {
  const { stripe, client } = fixture();
  const { getMockStore } = await import("../../src/repositories/mockStore");
  const pointer = {
    guildId,
    tier: "free" as const,
    status: "free",
    subscriptionType: "manual",
    startDate: "2026-01-01",
    stripeSyncRevision: "before",
  };
  getMockStore().subscriptions.set(guildId, pointer);
  stripe.checkout.sessions.create.mockImplementationOnce(async () => {
    getMockStore().subscriptions.set(guildId, {
      ...pointer,
      stripeSyncRevision: "after",
    });
    return {
      ...sessionFields(),
      id: "cs_first",
      status: "open",
      url: "https://checkout.stripe.com/first",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    };
  });
  await expect(
    createCheckoutSession({
      stripe: client,
      user: { id: "payer" },
      guildId,
      priceId: "price_basic",
    }),
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
});

test("webhook acceptance before Checkout response returns billing instead of a stale URL", async () => {
  const { stripe, client } = fixture();
  const { getMockStore } = await import("../../src/repositories/mockStore");
  const { reconcileSubscription } =
    await import("../../src/services/subscriptionReconciliation");
  Object.assign(stripe, {
    subscriptions: {
      retrieve: jest.fn(async () => {
        const attempt = getMockStore().purchaseAttempts.get(guildId)!;
        return {
          id: "sub_fast",
          status: "active",
          customer: "cus_first",
          metadata: {
            guild_id: guildId,
            discord_id: "payer",
            purchase_attempt_id: attempt.attemptId,
          },
          livemode: false,
          created: 100,
          start_date: 100,
          items: {
            data: [{ price: { id: "price_basic" }, current_period_end: 200 }],
          },
        };
      }),
    },
  });
  stripe.checkout.sessions.create.mockImplementationOnce(async () => {
    await reconcileSubscription(client, guildId, "sub_fast");
    return {
      ...sessionFields(),
      id: "cs_first",
      status: "open",
      url: "https://checkout.stripe.com/first",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    };
  });
  await expect(
    createCheckoutSession({
      stripe: client,
      user: { id: "payer" },
      guildId,
      priceId: "price_basic",
    }),
  ).resolves.toBe(`/portal/server/${guildId}/billing`);
  expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
  expect(getMockStore().purchaseAttempts.get(guildId)?.state).toBe("completed");
});

test("provider-confirmed expiry cannot release an attempt when its pointer changed during the read", async () => {
  const { stripe, client } = fixture();
  const { getMockStore } = await import("../../src/repositories/mockStore");
  const request = {
    stripe: client,
    user: { id: "payer" },
    guildId,
    priceId: "price_basic",
  };
  await createCheckoutSession(request);
  stripe.checkout.sessions.retrieve.mockImplementationOnce(async () => {
    getMockStore().subscriptions.set(guildId, {
      guildId,
      tier: "basic",
      status: "active",
      subscriptionType: "stripe",
      startDate: "2026-01-01",
      stripeSubscriptionId: "sub_raced",
      stripeSyncRevision: "new",
    });
    return {
      ...sessionFields(),
      id: "cs_first",
      status: "expired",
      url: null,
      customer: "cus_first",
      subscription: null,
      metadata: sessionFields().metadata,
      livemode: false,
    } as never;
  });
  await expect(createCheckoutSession(request)).rejects.toMatchObject({
    code: "BAD_REQUEST",
  });
  expect(getMockStore().purchaseAttempts.get(guildId)?.state).toBe("open");
  expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
});

test("a completed attempt permits repurchase only after the linked provider subscription is terminal", async () => {
  const { stripe, client } = fixture();
  const { getMockStore } = await import("../../src/repositories/mockStore");
  const { config } = await import("../../src/services/configService");
  const { acceptPurchaseSubscription } =
    await import("../../src/services/purchaseReconciliation");
  const original = config.stripe.subscriptionTransitionsEnabled;
  config.stripe.subscriptionTransitionsEnabled = true;
  try {
    const request = {
      stripe: client,
      user: { id: "payer" },
      guildId,
      priceId: "price_basic",
    };
    await createCheckoutSession(request);
    const old = structuredClone(getMockStore().purchaseAttempts.get(guildId)!);
    const subscription = {
      id: "sub_old",
      status: "canceled",
      customer: "cus_first",
      metadata: {
        guild_id: guildId,
        discord_id: "payer",
        purchase_attempt_id: old.attemptId,
      },
      livemode: false,
    };
    getMockStore().subscriptions.set(guildId, {
      guildId,
      tier: "free",
      status: "canceled",
      subscriptionType: "stripe",
      startDate: "2026-01-01",
      stripeSubscriptionId: "sub_old",
      stripeCustomerId: "cus_first",
      stripeSyncRevision: "terminal",
    });
    getMockStore().purchaseAttempts.set(guildId, {
      ...old,
      state: "completed",
      subscriptionId: "sub_old",
    });
    Object.assign(stripe, {
      subscriptions: { retrieve: jest.fn(async () => subscription) },
    });
    await expect(createCheckoutSession(request)).resolves.toContain(
      "checkout.stripe.com",
    );
    const next = getMockStore().purchaseAttempts.get(guildId)!;
    expect(next.attemptId).not.toBe(old.attemptId);
    await acceptPurchaseSubscription(guildId, subscription as never);
    expect(getMockStore().purchaseAttempts.get(guildId)?.attemptId).toBe(
      next.attemptId,
    );
    expect(getMockStore().purchaseAttempts.get(guildId)?.state).toBe("open");
  } finally {
    config.stripe.subscriptionTransitionsEnabled = original;
  }
});

test("matching purchase metadata with the wrong customer cannot mutate the subscription pointer", async () => {
  const { stripe, client } = fixture();
  const { getMockStore } = await import("../../src/repositories/mockStore");
  const { reconcileSubscription } =
    await import("../../src/services/subscriptionReconciliation");
  await createCheckoutSession({
    stripe: client,
    user: { id: "payer" },
    guildId,
    priceId: "price_basic",
  });
  const attempt = getMockStore().purchaseAttempts.get(guildId)!;
  Object.assign(stripe, {
    subscriptions: {
      retrieve: jest.fn(async () => ({
        id: "sub_wrong",
        status: "active",
        customer: "cus_wrong",
        metadata: {
          guild_id: guildId,
          discord_id: "payer",
          purchase_attempt_id: attempt.attemptId,
        },
        livemode: false,
        created: 100,
        start_date: 100,
        items: {
          data: [{ price: { id: "price_basic" }, current_period_end: 200 }],
        },
      })),
    },
  });
  const before = structuredClone(getMockStore().subscriptions.get(guildId));
  await expect(
    reconcileSubscription(client, guildId, "sub_wrong"),
  ).rejects.toThrow();
  expect(getMockStore().subscriptions.get(guildId)).toEqual(before);
});

test("a returned Checkout from another guild cannot be exposed as this purchase", async () => {
  const { stripe, client } = fixture();
  stripe.checkout.sessions.create.mockResolvedValueOnce({
    id: "cs_other",
    status: "open",
    url: "https://checkout.stripe.com/other",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    metadata: { guild_id: "222222222222222222" },
  } as never);
  await expect(
    createCheckoutSession({
      stripe: client,
      user: { id: "payer" },
      guildId,
      priceId: "price_basic",
    }),
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
});

test.each([false, true])(
  "a review-blocked customer selection winner cannot issue provider calls (customer persisted: %s)",
  async (hasCustomer) => {
    const { stripe, client } = fixture();
    const repositoryModule =
      await import("../../src/repositories/purchaseAttemptRepository");
    const real = repositoryModule.getPurchaseRepository();
    const spy = jest
      .spyOn(repositoryModule, "getPurchaseRepository")
      .mockImplementation(() => ({
        ...real,
        compareAndWrite: async (next, expected, pointer, incident) => {
          if (next.customerOperation && !expected?.customerOperation) {
            getMockStore().purchaseAttempts.set(guildId, {
              ...next,
              state: "needs_review",
              incidentKey: "concurrent-incident",
              ...(hasCustomer ? { customerId: "cus_frozen" } : {}),
            });
            return false;
          }
          return real.compareAndWrite(next, expected, pointer, incident);
        },
      }));
    try {
      await expect(
        createCheckoutSession({
          stripe: client,
          user: { id: "payer" },
          guildId,
          priceId: "price_basic",
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(stripe.customers.create).not.toHaveBeenCalled();
      expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  },
);

test("duplicate replay preserves first observation and attempt provenance", async () => {
  const { recordDuplicatePurchase } =
    await import("../../src/services/purchaseReconciliation");
  const pointer = {
    guildId,
    tier: "basic" as const,
    status: "active",
    subscriptionType: "stripe",
    startDate: "2026-01-01",
    stripeSubscriptionId: "sub_a",
  };
  getMockStore().subscriptions.set(guildId, pointer);
  const a = {
    id: "sub_a",
    status: "active",
    livemode: false,
    metadata: { guild_id: guildId },
  };
  const b = {
    id: "sub_b",
    status: "trialing",
    livemode: false,
    metadata: { guild_id: guildId, purchase_attempt_id: "original_attempt" },
  };
  jest.useFakeTimers();
  try {
    jest.setSystemTime(new Date("2026-09-08T00:00:00Z"));
    await recordDuplicatePurchase(guildId, a as never, b as never);
    jest.setSystemTime(new Date("2026-09-08T00:01:00Z"));
    await recordDuplicatePurchase(
      guildId,
      a as never,
      {
        ...b,
        metadata: { ...b.metadata, purchase_attempt_id: "later_metadata" },
      } as never,
    );
    expect([...getMockStore().purchaseIncidents.values()]).toEqual([
      expect.objectContaining({
        firstObservedAt: "2026-09-08T00:00:00.000Z",
        lastObservedAt: "2026-09-08T00:01:00.000Z",
        incomingAttemptId: "original_attempt",
        reason: "competing_nonterminal_subscription",
      }),
    ]);
  } finally {
    jest.useRealTimers();
  }
});

test.each([28, 29, 35, 59])(
  "lost Checkout response recovery at %i minutes respects Stripe's minimum expiry",
  async (minutes) => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date("2026-10-08T00:00:00Z"));
      const { stripe, client } = fixture();
      stripe.checkout.sessions.create.mockRejectedValueOnce(
        new Error("lost response"),
      );
      const request = {
        stripe: client,
        user: { id: "payer" },
        guildId,
        priceId: "price_basic",
      };
      await expect(createCheckoutSession(request)).rejects.toThrow(
        "lost response",
      );
      const attempt = getMockStore().purchaseAttempts.get(guildId)!;
      expect(attempt.checkout.expires_at).toBe(
        Math.floor(Date.now() / 1000) + 3600,
      );
      jest.setSystemTime(new Date(Date.now() + minutes * 60 * 1000));
      if (minutes < 29) {
        await expect(createCheckoutSession(request)).resolves.toContain(
          "checkout.stripe.com",
        );
        expect(stripe.checkout.sessions.create.mock.calls[1]).toEqual(
          stripe.checkout.sessions.create.mock.calls[0],
        );
        expect(
          attempt.checkout.expires_at! - Math.floor(Date.now() / 1000),
        ).toBeGreaterThan(30 * 60);
      } else {
        await expect(createCheckoutSession(request)).rejects.toThrow(
          "needs review",
        );
        expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
        expect(getMockStore().purchaseAttempts.get(guildId)?.state).toBe(
          "needs_review",
        );
      }
    } finally {
      jest.useRealTimers();
    }
  },
);

test("customer lookup cannot carry a frozen Checkout past its replay deadline", async () => {
  jest.useFakeTimers();
  try {
    jest.setSystemTime(new Date("2026-10-08T00:00:00Z"));
    const { stripe, client } = fixture();
    stripe.customers.create.mockImplementationOnce(async () => {
      jest.setSystemTime(new Date(Date.now() + 29 * 60 * 1000));
      return { id: "cus_first" };
    });
    await expect(
      createCheckoutSession({
        stripe: client,
        user: { id: "payer" },
        guildId,
        priceId: "price_basic",
      }),
    ).rejects.toThrow("needs review");
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
    expect(getMockStore().purchaseAttempts.get(guildId)?.state).toBe(
      "needs_review",
    );
  } finally {
    jest.useRealTimers();
  }
});

test.each(["open", "lost_response"])(
  "source and username changes recover an %s purchase with its original metadata",
  async (state) => {
    const { stripe, client } = fixture();
    const request = {
      stripe: client,
      user: { id: "payer", username: "original" },
      guildId,
      priceId: "price_basic",
      source: "discord_notes" as const,
    };
    if (state === "lost_response") {
      stripe.checkout.sessions.create.mockRejectedValueOnce(
        new Error("lost response"),
      );
      await expect(createCheckoutSession(request)).rejects.toThrow(
        "lost response",
      );
    } else {
      await createCheckoutSession(request);
    }
    const frozen = structuredClone(
      getMockStore().purchaseAttempts.get(guildId)!.checkout,
    );
    await expect(
      createCheckoutSession({
        ...request,
        user: { id: "payer", username: "renamed" },
        source: "homepage_pricing",
      }),
    ).resolves.toContain("checkout.stripe.com");
    expect(getMockStore().purchaseAttempts.get(guildId)!.checkout).toEqual(
      frozen,
    );
    expect(frozen.metadata).toMatchObject({
      discord_username: "original",
      purchase_source: "discord_notes",
    });
    if (state === "lost_response")
      expect(stripe.checkout.sessions.create.mock.calls[1]).toEqual(
        stripe.checkout.sessions.create.mock.calls[0],
      );
    else expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
    expect(captureEvent).toHaveBeenCalledTimes(1);
    expect(captureEvent).toHaveBeenCalledWith(
      "billing_checkout_created",
      expect.objectContaining({
        properties: expect.objectContaining({ source: "discord_notes" }),
      }),
    );
  },
);

test.each([true, false])(
  "changing analyticsAllowed from %s does not block recovery or clear an opt-out",
  async (originalAllowed) => {
    const { stripe, client } = fixture();
    stripe.checkout.sessions.create.mockRejectedValueOnce(
      new Error("lost response"),
    );
    const request = {
      stripe: client,
      user: { id: "payer" },
      guildId,
      priceId: "price_basic",
      analyticsAllowed: originalAllowed,
    };
    await expect(createCheckoutSession(request)).rejects.toThrow(
      "lost response",
    );
    const frozen = structuredClone(
      getMockStore().purchaseAttempts.get(guildId)!.checkout,
    );
    await expect(
      createCheckoutSession({ ...request, analyticsAllowed: !originalAllowed }),
    ).resolves.toContain("checkout.stripe.com");
    expect(stripe.checkout.sessions.create.mock.calls[1]).toEqual(
      stripe.checkout.sessions.create.mock.calls[0],
    );
    expect(getMockStore().purchaseAttempts.get(guildId)).toMatchObject({
      checkout: frozen,
      analyticsOptOut: true,
    });
    await expect(
      createCheckoutSession({ ...request, analyticsAllowed: true }),
    ).resolves.toContain("checkout.stripe.com");
    expect(getMockStore().purchaseAttempts.get(guildId)!.analyticsOptOut).toBe(
      true,
    );
    expect(captureEvent).not.toHaveBeenCalled();
  },
);

test.each([
  { priceId: "price_pro" },
  { promotionCodeId: "promo_changed" },
  { allowPromotionCodes: false },
])("a change to payment terms %p still blocks reuse", async (change) => {
  const { stripe, client } = fixture();
  const request = {
    stripe: client,
    user: { id: "payer" },
    guildId,
    priceId: "price_basic",
  };
  await createCheckoutSession(request);
  await expect(
    createCheckoutSession({ ...request, ...change }),
  ).rejects.toThrow("already in progress");
  expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
});
