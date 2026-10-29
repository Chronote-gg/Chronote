/** @jest-environment node */
import { UnresolvedBillingMutation } from "../../src/services/runtimeBillingOperationService";
jest.mock("../../src/services/runtimeApiOperationService", () => ({
  runRuntimeApiOperation: jest.requireActual("../fixtures/runtimeApiOperation")
    .runTestApiOperation,
}));
import * as renewalCoverage from "../../src/services/renewalRecoveryService";
import { getMockStore } from "../../src/repositories/mockStore";

import { createCheckoutSession } from "../../src/services/billingService";
import { resetMockStore } from "../../src/repositories/mockStore";
import { captureEvent } from "../../src/services/analyticsService";
jest.mock("../../src/services/analyticsService", () => ({
  captureEvent: jest.fn(),
}));

import {
  purchaseGuildId as guildId,
  sessionFields,
  paidProvider,
  initialPurchaseStripe as fixture,
} from "../fixtures/initialPurchaseStripe";
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
  expect(stripe.checkout.sessions.expire).not.toHaveBeenCalled();
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
  Object.assign(stripe, paidProvider("sub_new"));
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
    cause: { code: "BAD_REQUEST" },
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
  ).rejects.toBeInstanceOf(UnresolvedBillingMutation);
});

test("webhook acceptance before Checkout response returns billing instead of a stale URL", async () => {
  const { stripe, client } = fixture();
  const { getMockStore } = await import("../../src/repositories/mockStore");
  const { reconcileSubscription } =
    await import("../../src/services/subscriptionReconciliation");
  Object.assign(stripe, paidProvider("sub_fast"));
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
  expect(getMockStore().renewalRecoveryRecords.size).toBe(1);
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
    await acceptPurchaseSubscription(guildId, subscription as never, client);
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
  ).rejects.toMatchObject({
    cause: { code: "BAD_REQUEST", reason: "purchase_needs_review" },
  });
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
      ).rejects.toMatchObject({
        cause: { code: "BAD_REQUEST", reason: "purchase_needs_review" },
      });
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

test("recording-limit context survives checkout and remains frozen across retries", async () => {
  const { stripe, client } = fixture();
  stripe.checkout.sessions.create.mockRejectedValueOnce(
    new Error("lost response"),
  );
  const request = {
    stripe: client,
    user: { id: "payer" },
    guildId,
    priceId: "price_basic",
    source: "discord_limit" as const,
    limitType: "weekly_recording" as const,
    limitSurface: "manual_start" as const,
  };
  await expect(createCheckoutSession(request)).rejects.toThrow("lost response");
  const frozen = getMockStore().purchaseAttempts.get(guildId)?.checkout;
  expect(frozen?.metadata).toMatchObject({
    recording_limit_type: "weekly_recording",
    recording_limit_surface: "manual_start",
  });
  expect(frozen?.success_url).toContain("limitType=weekly_recording");
  expect(frozen?.cancel_url).toContain("limitSurface=manual_start");
  await expect(
    createCheckoutSession({
      ...request,
      limitType: "meeting_duration" as const,
      limitSurface: "duration_stop" as const,
    }),
  ).resolves.toContain("checkout.stripe.com");
  expect(stripe.checkout.sessions.create.mock.calls[1]).toEqual(
    stripe.checkout.sessions.create.mock.calls[0],
  );
  expect(captureEvent).toHaveBeenCalledWith(
    "billing_checkout_created",
    expect.objectContaining({
      properties: expect.objectContaining({
        limit_type: "weekly_recording",
        limit_surface: "manual_start",
      }),
    }),
  );
});

test("completed purchase acknowledgment waits for renewal coverage and retries registration", async () => {
  const { stripe, client } = fixture();
  const request = {
    stripe: client,
    user: { id: "payer" },
    guildId,
    priceId: "price_basic",
  };
  await createCheckoutSession(request);
  Object.assign(stripe, paidProvider("sub_new"));
  stripe.checkout.sessions.retrieve.mockResolvedValue({
    ...sessionFields(),
    id: "cs_first",
    status: "complete",
    url: null,
    customer: "cus_first",
    subscription: "sub_new",
    metadata: sessionFields().metadata,
    livemode: false,
  } as never);
  const tracking = jest
    .spyOn(renewalCoverage, "trackPaidRenewalPeriod")
    .mockRejectedValueOnce(new Error("Coverage unavailable"));
  try {
    await expect(createCheckoutSession(request)).rejects.toThrow(
      "Coverage unavailable",
    );
    expect(getMockStore().purchaseAttempts.get(guildId)?.state).not.toBe(
      "completed",
    );
  } finally {
    tracking.mockRestore();
  }
  expect(await createCheckoutSession(request)).toBe(
    `/portal/server/${guildId}/billing`,
  );
  expect(getMockStore().renewalRecoveryRecords.size).toBe(1);
  expect(getMockStore().purchaseAttempts.get(guildId)?.state).toBe("completed");
});

test("only the original payer can resume a paid purchase awaiting coverage", async () => {
  const { stripe, client } = fixture();
  const request = {
    stripe: client,
    user: { id: "payer" },
    guildId,
    priceId: "price_basic",
  };
  await createCheckoutSession(request);
  Object.assign(stripe, paidProvider("sub_new"));
  getMockStore().subscriptions.set(guildId, {
    guildId,
    status: "active",
    tier: "basic",
    subscriptionType: "stripe",
    startDate: "2026-10-12",
    stripeSubscriptionId: "sub_new",
    stripeCustomerId: "cus_first",
  });
  await expect(
    createCheckoutSession({ ...request, user: { id: "another-payer" } }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect(getMockStore().purchaseAttempts.get(guildId)?.state).not.toBe(
    "completed",
  );
  expect(getMockStore().renewalRecoveryRecords.size).toBe(0);
});
