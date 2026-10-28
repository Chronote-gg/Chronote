/** @jest-environment node */
import "../fixtures/admittedApi";
import { testWriterImageDigest } from "../fixtures/historyWriterBoundary";
jest.mock("../../src/services/ledgerWriterRuntime", () => ({
  readLedgerWriterRuntime: jest.fn(async () => ({
    taskArn: "arn:aws:ecs:us-east-1:123456789012:task/test/task-one",
    imageDigest: testWriterImageDigest,
  })),
}));
beforeEach(() => {
  config.stripe.introOfferLedgerEnabled = true;
});
import { getOfferUsageRepository } from "../../src/repositories/offerUsageRepository";
import { getPublicPricingSnapshot } from "../../src/services/publicPricingService";
import { config } from "../../src/services/configService";
import { captureEvent } from "../../src/services/analyticsService";
jest.mock("../../src/services/analyticsService", () => ({
  captureEvent: jest.fn(),
}));
it("keeps the introductory offer inactive with no environment configuration", () => {
  expect(config.stripe).toMatchObject({
    basicIntroOffer: {
      couponId: "",
      annualCouponId: "",
      startsAt: "",
      enrollmentEndsAt: "",
      portalConfigurationId: "",
    },
  });
});
import {
  getBasicIntroOffer,
  getGuildBasicIntroOffer,
  getProviderSubscriptionDetails,
} from "../../src/services/basicIntroOfferService";
import type { StripeClient } from "../../src/types/stripe";
import type { PaidPlan } from "../../src/types/pricing";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MantineProvider } from "@mantine/core";
import SubscriptionDetails from "../../src/frontend/components/SubscriptionDetails";

import {
  introNow as now,
  introSettings as settings,
  introOfferStripe as fixture,
  introPurchaseFixture as purchaseFixture,
} from "../fixtures/introOfferPurchase";
const plans: PaidPlan[] = [
  {
    tier: "basic",
    interval: "month",
    priceId: "price_basic",
    currency: "usd",
    unitAmount: 1000,
  },
];
const empty = {
  couponId: "",
  startsAt: "",
  enrollmentEndsAt: "",
  portalConfigurationId: "",
};
afterEach(() => {
  Object.assign(config.stripe.basicIntroOffer, empty);
  config.stripe.introOfferLedgerEnabled = false;
});

test("verifies native terms before exposing the exact public offer", async () => {
  Object.assign(config.stripe.basicIntroOffer, settings);
  const { client } = fixture();
  await expect(
    getBasicIntroOffer({ stripe: client, plans, now }),
  ).resolves.toEqual({
    status: "available",
    id: "basic_intro_v1",
    priceId: "price_basic",
    currency: "usd",
    regularUnitAmount: 1000,
    discountedUnitAmount: 600,
    percentOff: 40,
    durationMonths: 3,
    enrollmentEndsAt: settings.enrollmentEndsAt,
  });
});

test.each(["couponId", "startsAt", "portalConfigurationId"])(
  "partial config missing %s is unavailable",
  async (missing) => {
    Object.assign(config.stripe.basicIntroOffer, settings, { [missing]: "" });
    await expect(
      getBasicIntroOffer({ stripe: fixture().client, plans, now }),
    ).resolves.toEqual({ status: "unavailable" });
  },
);

test.each(["invalid", "2026-10-01T00:00:00Z"])(
  "invalid or inverted end %s is unavailable",
  async (enrollmentEndsAt) => {
    Object.assign(config.stripe.basicIntroOffer, settings, {
      enrollmentEndsAt,
    });
    await expect(
      getBasicIntroOffer({ stripe: fixture().client, plans, now }),
    ).resolves.toEqual({ status: "unavailable" });
  },
);

test.each([
  ["not started", Date.parse("2026-09-30T23:59:59Z"), "inactive"],
  ["cutoff", Date.parse(settings.enrollmentEndsAt), "expired"],
] as const)("%s offer cannot enroll", async (_, instant, status) => {
  Object.assign(config.stripe.basicIntroOffer, settings);
  await expect(
    getBasicIntroOffer({ stripe: fixture().client, plans, now: instant }),
  ).resolves.toEqual({ status });
});

test.each([
  { active: false },
  { livemode: true },
  { currency: "eur" },
  { unit_amount: 1200 },
  { billing_scheme: "tiered" },
  {
    recurring: { interval: "year", interval_count: 1, usage_type: "licensed" },
  },
  {
    recurring: { interval: "month", interval_count: 2, usage_type: "licensed" },
  },
  {
    recurring: { interval: "month", interval_count: 1, usage_type: "metered" },
  },
])("rejects wrong native price %p", async (change) => {
  Object.assign(config.stripe.basicIntroOffer, settings);
  const { price, client } = fixture();
  Object.assign(price, change);
  await expect(
    getBasicIntroOffer({ stripe: client, plans, now }),
  ).resolves.toEqual({ status: "unavailable" });
});

test.each([
  { valid: false },
  { livemode: true },
  { percent_off: 39 },
  { amount_off: 400 },
  { duration: "forever" },
  { duration_in_months: 2 },
  { redeem_by: Date.parse(settings.enrollmentEndsAt) / 1000 + 3599 },
  { applies_to: { products: ["prod_pro"] } },
  { deleted: true },
])("rejects malformed native coupon %p", async (change) => {
  Object.assign(config.stripe.basicIntroOffer, settings);
  const { coupon, client } = fixture();
  Object.assign(coupon, change);
  await expect(
    getBasicIntroOffer({ stripe: client, plans, now }),
  ).resolves.toEqual({ status: "unavailable" });
});

test.each([
  { active: false },
  { livemode: true },
  {
    features: {
      subscription_update: { enabled: true },
      payment_method_update: { enabled: true },
      subscription_cancel: { enabled: true },
    },
  },
  {
    features: {
      subscription_update: { enabled: false },
      payment_method_update: { enabled: false },
      subscription_cancel: { enabled: true },
    },
  },
])("rejects unsafe native portal %p", async (change) => {
  Object.assign(config.stripe.basicIntroOffer, settings);
  const { portal, client } = fixture();
  Object.assign(portal, change);
  await expect(
    getBasicIntroOffer({ stripe: client, plans, now }),
  ).resolves.toEqual({ status: "unavailable" });
});

test("provider failure and missing Basic price never advertise an offer", async () => {
  Object.assign(config.stripe.basicIntroOffer, settings);
  const { stripe, client } = fixture();
  stripe.coupons.retrieve.mockRejectedValue(new Error("provider down"));
  await expect(
    getBasicIntroOffer({ stripe: client, plans, now }),
  ).resolves.toEqual({ status: "unavailable" });
  await expect(
    getBasicIntroOffer({ stripe: fixture().client, plans: [], now }),
  ).resolves.toEqual({ status: "unavailable" });
});
import { createCheckoutSession } from "../../src/services/billingService";
import { getMockStore, resetMockStore } from "../../src/repositories/mockStore";
import { clearGuildSubscriptionCache } from "../../src/services/subscriptionService";
import { createManualEntitlementGrant } from "../../src/services/entitlementService";

describe("authoritative initial-purchase offer", () => {
  beforeEach(() => {
    resetMockStore();
    clearGuildSubscriptionCache();
    jest.clearAllMocks();
    jest.useFakeTimers({ now });
    Object.assign(config.stripe.basicIntroOffer, settings);
  });
  afterEach(() => {
    jest.useRealTimers();
    config.subscription.forceTier = "";
    clearGuildSubscriptionCache();
  });

  test("introductory Checkout reserves the server offer before provider purchase writes", async () => {
    const { request, stripe } = purchaseFixture();
    stripe.checkout.sessions.create.mockImplementationOnce(async () => {
      const attempt = getMockStore().purchaseAttempts.get(request.guildId);
      expect(
        await getOfferUsageRepository().get(
          request.guildId,
          "basic_intro_v1",
          "test",
        ),
      ).toMatchObject({
        state: "reserved",
        operationId: attempt?.attemptId,
        terms: { priceId: "price_basic", couponId: "coupon_intro" },
      });
      return {
        id: "cs_intro",
        status: "open",
        url: "https://checkout.stripe.com/intro",
        livemode: false,
        customer: "cus_intro",
        metadata: {
          guild_id: request.guildId,
          purchase_attempt_id: attempt?.attemptId,
        },
      };
    });
    await expect(
      createCheckoutSession({
        ...request,
        expectedOffer: "basic_intro_v1",
        tier: "basic",
        interval: "month",
      }),
    ).resolves.toContain("checkout.stripe.com");
    expect(
      await getOfferUsageRepository().get(
        request.guildId,
        "basic_annual_intro_v1",
        "test",
      ),
    ).toBeUndefined();
  });

  test("unknown introductory provider outcome retains the durable reservation", async () => {
    const { request, stripe } = purchaseFixture();
    stripe.checkout.sessions.create.mockRejectedValueOnce(
      new Error("lost response"),
    );
    await expect(
      createCheckoutSession({
        ...request,
        expectedOffer: "basic_intro_v1",
        tier: "basic",
        interval: "month",
      }),
    ).rejects.toThrow("lost response");
    jest.setSystemTime(new Date(Date.now() + 35 * 60000));
    await expect(
      createCheckoutSession({ ...request, expectedOffer: "none" }),
    ).rejects.toMatchObject({ cause: { reason: "purchase_needs_review" } });
    expect(
      await getOfferUsageRepository().get(
        request.guildId,
        "basic_intro_v1",
        "test",
      ),
    ).toMatchObject({ state: "reserved" });
  });

  test("verified expired introductory checkout releases use before a replacement purchase", async () => {
    const { request, stripe } = purchaseFixture();
    await createCheckoutSession({
      ...request,
      expectedOffer: "basic_intro_v1",
    });
    const prior = getMockStore().purchaseAttempts.get(request.guildId)!;
    const native = await stripe.checkout.sessions.retrieve();
    stripe.checkout.sessions.retrieve.mockResolvedValueOnce({
      ...native,
      status: "expired",
    });
    await createCheckoutSession({
      ...request,
      expectedOffer: "basic_intro_v1",
    });
    const replacement = getMockStore().purchaseAttempts.get(request.guildId)!;
    expect(replacement.attemptId).not.toBe(prior.attemptId);
    expect(
      await getOfferUsageRepository().get(
        request.guildId,
        "basic_intro_v1",
        "test",
      ),
    ).toMatchObject({ state: "reserved", operationId: replacement.attemptId });
  });

  test("an expired Checkout response releases only the verified session reservation", async () => {
    const { request, stripe } = purchaseFixture();
    stripe.checkout.sessions.create.mockImplementationOnce(async () => ({
      id: "cs_intro",
      status: "expired",
      url: "",
      livemode: false,
      customer: "cus_intro",
      metadata: {
        guild_id: request.guildId,
        purchase_attempt_id: getMockStore().purchaseAttempts.get(
          request.guildId,
        )?.attemptId,
      },
    }));
    await expect(
      createCheckoutSession({
        ...request,
        expectedOffer: "basic_intro_v1",
        tier: "basic",
        interval: "month",
      }),
    ).rejects.toMatchObject({ cause: { reason: "purchase_expired" } });
    expect(
      await getOfferUsageRepository().get(
        request.guildId,
        "basic_intro_v1",
        "test",
      ),
    ).toMatchObject({
      state: "unused",
      released: { resourceId: "cs_intro", reason: "checkout_expired" },
    });
  });

  test("a new comp grant preserves the same payer's reusable frozen offer", async () => {
    const { request, stripe } = purchaseFixture();
    await createCheckoutSession({
      ...request,
      expectedOffer: "basic_intro_v1",
    });
    await createManualEntitlementGrant({
      guildId: request.guildId,
      tier: "basic",
      createdBy: "admin",
    });
    expect(
      await getGuildBasicIntroOffer({
        stripe: request.stripe,
        guildId: request.guildId,
        payerId: "payer",
      }),
    ).toMatchObject({ status: "available", id: "basic_intro_v1" });
    await expect(
      createCheckoutSession({
        ...request,
        expectedOffer: "basic_intro_v1",
        tier: "basic",
        interval: "month",
      }),
    ).resolves.toContain("checkout.stripe.com");
    expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
    expect(
      await getGuildBasicIntroOffer({
        stripe: request.stripe,
        guildId: request.guildId,
        payerId: "other",
      }),
    ).toEqual({ status: "unavailable" });
    expect(
      await getGuildBasicIntroOffer({
        stripe: request.stripe,
        guildId: request.guildId,
        payerId: "payer",
        interval: "year",
      }),
    ).toEqual({ status: "unavailable" });
  });
  test("Checkout revalidates provider terms even while public pricing stays cached", async () => {
    const { request, coupon, stripe } = purchaseFixture();
    expect(
      (await getPublicPricingSnapshot(request.stripe)).introOffer.status,
    ).toBe("available");
    coupon.valid = false;
    expect(
      (await getPublicPricingSnapshot(request.stripe)).introOffer.status,
    ).toBe("available");
    await expect(
      createCheckoutSession({
        ...request,
        expectedOffer: "basic_intro_v1",
        tier: "basic",
        interval: "month",
      }),
    ).rejects.toMatchObject({ reason: "offer_unavailable" });
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
    expect(stripe.customers.create).not.toHaveBeenCalled();
  });

  test.each([29, 35, 59])(
    "stale unknown introductory checkout is classified before a fresh-page quote at %i minutes",
    async (minutes) => {
      const { request, stripe } = purchaseFixture();
      stripe.checkout.sessions.create.mockRejectedValueOnce(
        new Error("lost response"),
      );
      await expect(
        createCheckoutSession({
          ...request,
          expectedOffer: "basic_intro_v1",
          tier: "basic",
          interval: "month",
        }),
      ).rejects.toThrow("lost response");
      jest.setSystemTime(new Date(Date.now() + minutes * 60000));
      expect(
        await getGuildBasicIntroOffer({
          stripe: request.stripe,
          guildId: request.guildId,
          payerId: "payer",
        }),
      ).toEqual({ status: "unavailable" });
      await expect(
        createCheckoutSession({ ...request, expectedOffer: "none" }),
      ).rejects.toMatchObject({
        cause: { reason: "purchase_needs_review" },
        message: expect.stringContaining("needs review"),
      });
      expect(getMockStore().purchaseAttempts.get(request.guildId)?.state).toBe(
        "needs_review",
      );
      expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
      expect(stripe.customers.create).toHaveBeenCalledTimes(1);
    },
  );

  test("eligible Free purchase freezes native coupon and cohort, preserving promotion analytics meaning", async () => {
    const { request } = purchaseFixture();
    await expect(
      createCheckoutSession({
        ...request,
        expectedOffer: "basic_intro_v1",
        tier: "basic",
        interval: "month",
      }),
    ).resolves.toContain("checkout.stripe.com");
    expect(
      getMockStore().purchaseAttempts.get(request.guildId)?.checkout,
    ).toMatchObject({
      discounts: [{ coupon: "coupon_intro" }],
      allow_promotion_codes: undefined,
      metadata: { intro_offer_id: "basic_intro_v1" },
      subscription_data: { metadata: { intro_offer_id: "basic_intro_v1" } },
    });
    expect(
      getMockStore().purchaseAttempts.get(request.guildId)?.checkout.metadata
        ?.promo_code,
    ).toBeUndefined();
    expect(captureEvent).toHaveBeenCalledWith(
      "billing_checkout_created",
      expect.objectContaining({
        properties: expect.objectContaining({
          promo_present: false,
          offer: "basic_intro_v1",
        }),
      }),
    );
  });
  test("saved code preserves return and analytics intent while only the intro coupon is redeemed", async () => {
    const { request } = purchaseFixture();
    const input = {
      ...request,
      expectedOffer: "basic_intro_v1" as const,
      offerChoice: "automatic" as const,
      savedPromotionCode: "SAVE20",
      tier: "basic" as const,
      interval: "month" as const,
      source: "discord_limit" as const,
      limitType: "weekly_recording" as const,
      limitSurface: "manual_start" as const,
    };
    await createCheckoutSession(input);
    const checkout = getMockStore().purchaseAttempts.get(
      request.guildId,
    )?.checkout;
    expect(checkout).toMatchObject({
      discounts: [{ coupon: "coupon_intro" }],
      metadata: { purchase_promo_present: "true" },
    });
    expect(checkout?.metadata?.promo_code).toBeUndefined();
    for (const link of [checkout?.success_url, checkout?.cancel_url]) {
      const url = new URL(link!);
      expect(Object.fromEntries(url.searchParams)).toMatchObject({
        promo: "SAVE20",
        offerChoice: "automatic",
        plan: "basic",
        interval: "month",
        source: "discord_limit",
        limitType: "weekly_recording",
        limitSurface: "manual_start",
      });
    }
    expect(captureEvent).toHaveBeenCalledWith(
      "billing_checkout_created",
      expect.objectContaining({
        properties: expect.objectContaining({ promo_present: true }),
      }),
    );
    await createCheckoutSession(input);
    expect(
      getMockStore().purchaseAttempts.get(request.guildId)?.checkout,
    ).toEqual(checkout);
  });

  test.each([
    "manual_comp",
    "forced",
    "legacy",
    "canceled",
    "customer_pointer",
  ])(
    "%s preserves offer eligibility while purchase ownership remains enforced",
    async (kind) => {
      const { request } = purchaseFixture();
      if (kind === "manual_comp")
        await createManualEntitlementGrant({
          guildId: request.guildId,
          tier: "basic",
          createdBy: "admin",
        });
      else if (kind === "forced") config.subscription.forceTier = "basic";
      else
        getMockStore().subscriptions.set(request.guildId, {
          guildId: request.guildId,
          subscriptionType: "legacy",
          tier: "free",
          status: kind === "canceled" ? "canceled" : "free",
          startDate: "2026-01-01",
          ...(kind === "customer_pointer"
            ? { stripeCustomerId: "cus_old" }
            : {}),
        });
      if (kind === "forced" || kind === "customer_pointer") {
        await expect(
          createCheckoutSession({
            ...request,
            expectedOffer: "basic_intro_v1",
          }),
        ).rejects.toThrow();
        expect(getMockStore().purchaseAttempts.size).toBe(0);
      } else {
        await createCheckoutSession({
          ...request,
          expectedOffer: "basic_intro_v1",
        });
        expect(
          getMockStore().purchaseAttempts.get(request.guildId)?.checkout
            .discounts,
        ).toEqual([{ coupon: "coupon_intro" }]);
      }
    },
  );

  test.each(["price_annual", "price_pro"])(
    "%s remains a regular purchase",
    async (priceId) => {
      const { request } = purchaseFixture();
      await createCheckoutSession({ ...request, priceId });
      expect(
        getMockStore().purchaseAttempts.get(request.guildId)?.checkout
          .discounts,
      ).toBeUndefined();
    },
  );

  test("unverified configured sale blocks relevant Basic purchase rather than charging regular price", async () => {
    const { request, coupon } = purchaseFixture();
    coupon.percent_off = 39;
    await expect(createCheckoutSession(request)).rejects.toThrow("unavailable");
    expect(getMockStore().purchaseAttempts.size).toBe(0);
  });

  test("automatic offer plus manual promotion requires explicit choice", async () => {
    const { request } = purchaseFixture();
    await expect(
      createCheckoutSession({
        ...request,
        promotionCodeId: "promo_other",
        promotionCode: "OTHER",
      }),
    ).rejects.toThrow("Choose");
    expect(getMockStore().purchaseAttempts.size).toBe(0);
    await createCheckoutSession({
      ...request,
      promotionCodeId: "promo_other",
      promotionCode: "OTHER",
      offerChoice: "promotion",
      expectedOffer: "none",
    });
    expect(
      getMockStore().purchaseAttempts.get(request.guildId)?.checkout,
    ).toMatchObject({
      discounts: [{ promotion_code: "promo_other" }],
      metadata: { purchase_offer_choice: "promotion", promo_code: "OTHER" },
    });
  });

  test("stale expected regular terms reject newly available automatic offer", async () => {
    const { request } = purchaseFixture();
    await expect(
      createCheckoutSession({ ...request, expectedOffer: "none" }),
    ).rejects.toThrow("changed");
    expect(getMockStore().purchaseAttempts.size).toBe(0);
  });

  test("lost-response retry replays frozen request after cutoff or config rotation", async () => {
    const { request, stripe } = purchaseFixture();
    jest.setSystemTime(Date.parse(settings.enrollmentEndsAt) - 1000);
    stripe.checkout.sessions.create.mockRejectedValueOnce(
      new Error("lost response"),
    );
    await expect(createCheckoutSession(request)).rejects.toThrow(
      "lost response",
    );
    const frozen = structuredClone(
      getMockStore().purchaseAttempts.get(request.guildId)?.checkout,
    );
    expect(frozen?.discounts).toEqual([{ coupon: "coupon_intro" }]);
    jest.setSystemTime(Date.parse(settings.enrollmentEndsAt) + 1000);
    Object.assign(config.stripe.basicIntroOffer, {
      couponId: "coupon_rotated",
    });
    await createCheckoutSession({
      ...request,
      analyticsAllowed: false,
      source: "discord_limit",
      limitType: "weekly_recording",
      limitSurface: "manual_start",
    });
    expect(
      getMockStore().purchaseAttempts.get(request.guildId)?.checkout,
    ).toEqual(frozen);
    expect(
      getMockStore().purchaseAttempts.get(request.guildId)?.analyticsOptOut,
    ).toBe(true);
    expect(stripe.checkout.sessions.create.mock.calls[1]).toEqual(
      stripe.checkout.sessions.create.mock.calls[0],
    );
  });

  test("new reservation at the cutoff cannot obtain the coupon", async () => {
    const { request } = purchaseFixture();
    jest.setSystemTime(Date.parse(settings.enrollmentEndsAt));
    await expect(
      createCheckoutSession({
        ...request,
        expectedOffer: "basic_intro_v1",
        tier: "basic",
        interval: "month",
      }),
    ).rejects.toThrow("changed");
    expect(getMockStore().purchaseAttempts.size).toBe(0);
    await createCheckoutSession(request);
    expect(
      getMockStore().purchaseAttempts.get(request.guildId)?.checkout.discounts,
    ).toBeUndefined();
  });

  test("another payer and competing promotion cannot rewrite the frozen offer", async () => {
    const { request } = purchaseFixture();
    await createCheckoutSession(request);
    const attempt = structuredClone(
      getMockStore().purchaseAttempts.get(request.guildId),
    );
    await expect(
      createCheckoutSession({ ...request, user: { id: "other" } }),
    ).rejects.toThrow("already in progress");
    await expect(
      createCheckoutSession({
        ...request,
        promotionCodeId: "promo_other",
        offerChoice: "promotion",
      }),
    ).rejects.toThrow();
    expect(getMockStore().purchaseAttempts.get(request.guildId)).toEqual(
      attempt,
    );
  });
});
import {
  createPortalSession,
  getBillingSnapshot,
} from "../../src/services/billingService";

describe("existing native introductory discount", () => {
  function subscriberFixture() {
    const base = purchaseFixture();
    const discount = {
      id: "di_intro",
      end: Date.parse("2027-01-12T12:00:00Z") / 1000,
      start: now / 1000,
      source: { type: "coupon", coupon: base.coupon },
      promotion_code: null,
    };
    const subscription = {
      id: "sub_intro",
      status: "active",
      livemode: false,
      customer: "cus_intro",
      metadata: {
        guild_id: base.request.guildId,
        intro_offer_id: "basic_intro_v1",
        intro_offer_coupon_id: "coupon_intro",
        intro_offer_portal_configuration_id: "bpc_intro",
      },
      discounts: [discount],
      items: {
        data: [
          {
            id: "si_intro",
            quantity: 1,
            price: base.price,
            current_period_end: Date.parse("2026-11-12T12:00:00Z") / 1000,
            discounts: [],
          },
        ],
      },
    };
    const stripe = {
      ...base.stripe,
      subscriptions: {
        retrieve: jest.fn(async () => subscription),
        list: jest.fn(async () => ({ data: [subscription], has_more: false })),
      },
      customers: {
        ...base.stripe.customers,
        retrieve: jest.fn(async () => ({
          id: "cus_intro",
          metadata: { discord_id: "payer" },
        })),
      },
      billingPortal: {
        ...base.stripe.billingPortal,
        sessions: {
          create: jest.fn(async () => ({
            url: "https://billing.stripe.com/manage",
          })),
        },
      },
    };
    getMockStore().subscriptions.set(base.request.guildId, {
      guildId: base.request.guildId,
      subscriptionType: "stripe",
      tier: "basic",
      status: "active",
      stripeCustomerId: "cus_intro",
      stripeSubscriptionId: "sub_intro",
      startDate: "2026-10-12T12:00:00Z",
    });
    return {
      ...base,
      discount,
      subscription,
      stripe,
      request: { ...base.request, stripe: stripe as unknown as StripeClient },
    };
  }
  beforeEach(() => {
    resetMockStore();
    clearGuildSubscriptionCache();
    jest.useFakeTimers({ now });
    Object.assign(config.stripe.basicIntroOffer, settings);
    config.stripe.subscriptionTransitionsEnabled = true;
  });
  afterEach(() => {
    jest.useRealTimers();
    config.stripe.subscriptionTransitionsEnabled = false;
    clearGuildSubscriptionCache();
  });

  test("existing selections go to an explicit offer review before any provider change", async () => {
    const { request, stripe, subscription } = subscriberFixture();
    subscription.discounts = [];
    await expect(
      createCheckoutSession({
        ...request,
        expectedOffer: "basic_intro_v1",
        tier: "basic",
        interval: "month",
      }),
    ).resolves.toContain("plan=basic");
    expect(stripe.billingPortal.sessions.create).not.toHaveBeenCalled();
  });

  test("expanded provider customer works when the local customer pointer is absent", async () => {
    const { request, stripe, subscription } = subscriberFixture();
    const pointer = getMockStore().subscriptions.get(request.guildId)!;
    delete pointer.stripeCustomerId;
    Object.assign(subscription, { customer: { id: "cus_intro" } });
    await expect(createPortalSession(request)).resolves.toContain(
      "billing.stripe.com",
    );
    expect(stripe.customers.retrieve).toHaveBeenCalledWith("cus_intro");
  });

  test("snapshot uses actual native price, discount and renewal", async () => {
    const { request } = subscriberFixture();
    const result = await getBillingSnapshot({
      stripe: request.stripe,
      guildId: request.guildId,
      payerId: "payer",
    });
    expect(result.introOffer).toMatchObject({ status: "available" });
    expect(result.subscriptionDetails).toMatchObject({
      status: "available",
      priceId: "price_basic",
      currency: "usd",
      unitAmount: 1000,
      discountedUnitAmount: 600,
      interval: "month",
      renewalAt: "2026-11-12T12:00:00.000Z",
      discount: {
        percentOff: 40,
        durationMonths: 3,
        endsAt: "2027-01-12T12:00:00.000Z",
        introductory: true,
      },
      planChangesRestricted: false,
    });
  });

  test.each(["applicable", "inapplicable", "unrestricted"])(
    "displays only a natively %s product discount",
    async (applicability) => {
      const f = subscriberFixture();
      Object.assign(f.subscription, { metadata: {} });
      Object.assign(f.price, {
        id: "price_pro",
        product: "prod_pro",
        unit_amount: 2400,
      });
      if (applicability === "unrestricted")
        Reflect.deleteProperty(f.coupon, "applies_to");
      else
        f.coupon.applies_to.products = [
          applicability === "applicable" ? "prod_pro" : "prod_basic",
        ];
      const result = await getProviderSubscriptionDetails(
        f.request.stripe,
        await f.request.stripe.subscriptions.retrieve("sub_intro"),
      );
      expect(result).toMatchObject({
        status: "available",
        unitAmount: 2400,
        discountedUnitAmount: applicability === "inapplicable" ? null : 1440,
        discount:
          applicability === "inapplicable"
            ? null
            : expect.objectContaining({ percentOff: 40 }),
      });
      if (applicability === "unrestricted")
        expect(f.stripe.coupons.retrieve).toHaveBeenCalledWith("coupon_intro", {
          expand: ["applies_to"],
        });
    },
  );

  test("inapplicable amount-off coupon does not obscure the native price in another currency", async () => {
    const f = subscriberFixture();
    Object.assign(f.price, {
      id: "price_pro",
      product: "prod_pro",
      unit_amount: 2400,
    });
    Object.assign(f.coupon, {
      percent_off: null,
      amount_off: 400,
      currency: "eur",
    });
    const result = await getBillingSnapshot({
      stripe: f.request.stripe,
      guildId: f.request.guildId,
    });
    expect(result.subscriptionDetails).toMatchObject({
      status: "available",
      unitAmount: 2400,
      discountedUnitAmount: null,
      discount: null,
    });
  });

  test.each(["string coupon", "expanded product", "missing product"])(
    "resolves native applicability with %s",
    async (representation) => {
      const f = subscriberFixture();
      if (representation === "string coupon")
        Object.assign(f.discount.source, { coupon: "coupon_intro" });
      if (representation === "expanded product")
        Object.assign(f.price, {
          product: { id: "prod_basic", object: "product" },
        });
      if (representation === "missing product")
        Reflect.deleteProperty(f.price, "product");
      const result = await getBillingSnapshot({
        stripe: f.request.stripe,
        guildId: f.request.guildId,
      });
      expect(result.subscriptionDetails).toMatchObject(
        representation === "missing product"
          ? { status: "unavailable" }
          : { status: "available", discountedUnitAmount: 600 },
      );
      if (representation === "string coupon")
        expect(f.stripe.coupons.retrieve).toHaveBeenCalledWith("coupon_intro", {
          expand: ["applies_to"],
        });
    },
  );

  test.each(["resolved", "failed", "mismatched"])(
    "retrieves omitted coupon applicability before display: %s",
    async (outcome) => {
      const f = subscriberFixture();
      const omitted = { ...f.coupon };
      Reflect.deleteProperty(omitted, "applies_to");
      Object.assign(f.discount.source, { coupon: omitted });
      if (outcome === "failed")
        f.stripe.coupons.retrieve.mockRejectedValue(
          new Error("eligibility unavailable"),
        );
      if (outcome === "mismatched") f.coupon.id = "wrong-coupon";
      const result = await getBillingSnapshot({
        stripe: f.request.stripe,
        guildId: f.request.guildId,
      });
      expect(result.subscriptionDetails).toMatchObject(
        outcome === "resolved"
          ? { status: "available", discountedUnitAmount: 600 }
          : { status: "unavailable" },
      );
      expect(f.stripe.coupons.retrieve).toHaveBeenCalledWith("coupon_intro", {
        expand: ["applies_to"],
      });
    },
  );

  test.each([-86400, 86400])(
    "custom cancel_at offset %i does not promise a normal renewal",
    async (offset) => {
      const f = subscriberFixture();
      Object.assign(f.subscription, {
        cancel_at: f.subscription.items.data[0].current_period_end + offset,
        cancel_at_period_end: false,
      });
      expect(
        await getProviderSubscriptionDetails(
          f.request.stripe,
          await f.request.stripe.subscriptions.retrieve("sub_intro"),
        ),
      ).toEqual({ status: "unavailable" });
    },
  );
  test("native dated period-end cancellation keeps the date and no-renewal display", async () => {
    const f = subscriberFixture();
    const cancellationAt = "2026-11-12T12:00:00.000Z";
    getMockStore().subscriptions.get(f.request.guildId)!.nextBillingDate =
      cancellationAt;
    Object.assign(f.subscription, {
      cancel_at: f.subscription.items.data[0].current_period_end,
      cancel_at_period_end: false,
    });
    const snapshot = await getBillingSnapshot({
      stripe: f.request.stripe,
      guildId: f.request.guildId,
    });
    expect(snapshot).toMatchObject({ cancellationAt, nextBillingDate: null });
    expect(snapshot.subscriptionDetails).toMatchObject({
      status: "available",
      cancelAtPeriodEnd: true,
      renewalAt: cancellationAt,
    });
    const html = renderToStaticMarkup(
      createElement(
        MantineProvider,
        {},
        createElement(SubscriptionDetails, {
          details: snapshot.subscriptionDetails,
        }),
      ),
    );
    expect(html).toContain("Cancels on");
    expect(html).toContain("No automatic renewal.");
    expect(html).not.toContain("Next renewal:");
  });

  test.each([-86400, 86400])(
    "keeps a custom cancellation date when price details are unavailable (%i)",
    async (offset) => {
      const f = subscriberFixture();
      const cancelAt = f.subscription.items.data[0].current_period_end + offset;
      Object.assign(f.subscription, {
        cancel_at: cancelAt,
        cancel_at_period_end: false,
      });
      const snapshot = await getBillingSnapshot({
        stripe: f.request.stripe,
        guildId: f.request.guildId,
      });
      expect(snapshot).toMatchObject({
        cancellationAt: new Date(cancelAt * 1000).toISOString(),
        subscriptionDetails: { status: "unavailable" },
      });
    },
  );

  test("saved cancellation date survives a provider outage without promising renewal", async () => {
    const f = subscriberFixture();
    const cancellationAt = "2026-11-12T12:00:00.000Z";
    Object.assign(getMockStore().subscriptions.get(f.request.guildId)!, {
      cancellationAt,
      nextBillingDate: cancellationAt,
    });
    f.stripe.subscriptions.retrieve.mockRejectedValue(
      new Error("provider unavailable"),
    );
    const snapshot = await getBillingSnapshot({
      stripe: f.request.stripe,
      guildId: f.request.guildId,
    });
    expect(snapshot).toMatchObject({
      cancellationAt,
      nextBillingDate: null,
      subscriptionDetails: { status: "unavailable" },
    });
  });

  test("mismatched provider identity cannot supply a cancellation date", async () => {
    const f = subscriberFixture();
    Object.assign(f.subscription, {
      customer: "cus_another",
      cancel_at: f.subscription.items.data[0].current_period_end,
    });
    const snapshot = await getBillingSnapshot({
      stripe: f.request.stripe,
      guildId: f.request.guildId,
    });
    expect(snapshot).toMatchObject({
      cancellationAt: null,
      subscriptionDetails: { status: "unavailable" },
    });
  });

  test("a verified provider removal clears a stale saved cancellation date", async () => {
    const f = subscriberFixture();
    getMockStore().subscriptions.set(f.request.guildId, {
      ...getMockStore().subscriptions.get(f.request.guildId),
      guildId: f.request.guildId,
      subscriptionType: "stripe",
      tier: "basic",
      status: "active",
      startDate: "2026-10-12T12:00:00Z",
      cancellationAt: "2026-11-12T12:00:00.000Z",
      nextBillingDate: "2026-11-12T12:00:00.000Z",
    });
    const snapshot = await getBillingSnapshot({
      stripe: f.request.stripe,
      guildId: f.request.guildId,
    });
    expect(snapshot).toMatchObject({
      cancellationAt: null,
      nextBillingDate: "2026-11-12T12:00:00.000Z",
    });
  });

  test("known native cancellation period survives the snapshot and actual display", async () => {
    const f = subscriberFixture();
    Object.assign(f.subscription, { cancel_at_period_end: true });
    const snapshot = await getBillingSnapshot({
      stripe: f.request.stripe,
      guildId: f.request.guildId,
    });
    expect(snapshot.subscriptionDetails).toMatchObject({
      cancelAtPeriodEnd: true,
      renewalAt: "2026-11-12T12:00:00.000Z",
    });
    const html = renderToStaticMarkup(
      createElement(
        MantineProvider,
        {},
        createElement(SubscriptionDetails, {
          details: snapshot.subscriptionDetails,
        }),
      ),
    );
    expect(html).toContain("Cancels on");
    expect(html).toContain(
      new Date("2026-11-12T12:00:00.000Z").toLocaleDateString(),
    );
    expect(html).toContain("No automatic renewal.");
    expect(html).not.toContain("Next renewal:");
    expect(html).not.toContain("has not supplied the end date");
  });

  test.each(["disabled", "rotated"])(
    "%s enrollment retains subscriber details and safe management",
    async (change) => {
      const { request, stripe, portal } = subscriberFixture();
      if (change === "rotated") portal.id = "bpc_next";
      Object.assign(
        config.stripe.basicIntroOffer,
        change === "disabled"
          ? empty
          : {
              ...settings,
              couponId: "coupon_next",
              portalConfigurationId: "bpc_next",
            },
      );
      const result = await getBillingSnapshot({
        stripe: request.stripe,
        guildId: request.guildId,
      });
      expect(result.subscriptionDetails).toMatchObject({
        status: "available",
        discountedUnitAmount: 600,
        planChangesRestricted: false,
      });
      await createPortalSession(request);
      expect(stripe.billingPortal.sessions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          configuration: change === "rotated" ? "bpc_next" : "bpc_intro",
        }),
      );
    },
  );

  test.each(["price_pro", "price_annual"])(
    "active introductory discount can review a move to %s",
    async (priceId) => {
      const { request, stripe } = subscriberFixture();
      await expect(
        createCheckoutSession({
          ...request,
          priceId,
          tier: priceId === "price_pro" ? "pro" : "basic",
          interval: priceId === "price_annual" ? "year" : "month",
        }),
      ).resolves.toContain("/billing?");
      expect(stripe.billingPortal.sessions.create).not.toHaveBeenCalled();
      expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
    },
  );

  test("discount expiry keeps payment management separate from plan review", async () => {
    const { request, stripe, discount } = subscriberFixture();
    jest.setSystemTime(discount.end * 1000);
    const snapshot = await getBillingSnapshot({
      stripe: request.stripe,
      guildId: request.guildId,
    });
    expect(snapshot.subscriptionDetails).toMatchObject({
      status: "available",
      discountedUnitAmount: null,
      discount: null,
      planChangesRestricted: false,
    });
    await createPortalSession(request);
    expect(
      stripe.billingPortal.sessions.create.mock.calls[0][0],
    ).toHaveProperty("configuration", "bpc_intro");
    await expect(
      createCheckoutSession({
        ...request,
        priceId: "price_pro",
        tier: "pro",
        interval: "month",
      }),
    ).resolves.toContain("plan=pro");
    expect(stripe.billingPortal.sessions.create).toHaveBeenCalledTimes(1);
  });

  test("provider detail failure is unavailable, never a fabricated regular price", async () => {
    const { request, stripe } = subscriberFixture();
    stripe.subscriptions.retrieve.mockRejectedValue(
      new Error("provider unavailable"),
    );
    const result = await getBillingSnapshot({
      stripe: request.stripe,
      guildId: request.guildId,
    });
    expect(result.subscriptionDetails).toEqual({ status: "unavailable" });
    await expect(createPortalSession(request)).rejects.toThrow();
    expect(stripe.billingPortal.sessions.create).not.toHaveBeenCalled();
  });

  test("another server discount does not prevent this server from reviewing a change", async () => {
    const { request, stripe, subscription, discount } = subscriberFixture();
    const otherSubscription = {
      ...subscription,
      id: "sub_other_intro",
      metadata: { ...subscription.metadata, guild_id: "222222222222222222" },
      discounts: [discount],
    };
    subscription.discounts = [];
    stripe.subscriptions.list.mockResolvedValue({
      data: [subscription, otherSubscription],
      has_more: false,
    });
    const snapshot = await getBillingSnapshot({
      stripe: request.stripe,
      guildId: request.guildId,
    });
    expect(snapshot.subscriptionDetails).toMatchObject({
      status: "available",
      discount: null,
      discountedUnitAmount: null,
      planChangesRestricted: false,
      planChangeRestrictionEndsAt: null,
    });
    expect(JSON.stringify(snapshot.subscriptionDetails)).not.toContain(
      "222222222222222222",
    );
    await createPortalSession(request);
    expect(stripe.billingPortal.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({ configuration: "bpc_intro" }),
    );
    await expect(
      createCheckoutSession({
        ...request,
        priceId: "price_pro",
        tier: "pro",
        interval: "month",
      }),
    ).resolves.toContain("plan=pro");
    expect(stripe.billingPortal.sessions.create).toHaveBeenCalledTimes(1);
    jest.setSystemTime(discount.end * 1000);
    await createCheckoutSession({
      ...request,
      priceId: "price_pro",
      tier: "pro",
      interval: "month",
    });
    expect(stripe.billingPortal.sessions.create).toHaveBeenCalledTimes(1);
  });

  test("payment management does not scan unrelated customer subscriptions", async () => {
    const { request, stripe, subscription, discount } = subscriberFixture();
    const otherSubscription = {
      ...subscription,
      id: "sub_other_intro",
      metadata: { ...subscription.metadata, guild_id: "222222222222222222" },
      discounts: [discount],
    };
    subscription.discounts = [];
    stripe.subscriptions.list
      .mockResolvedValueOnce({ data: [subscription], has_more: true })
      .mockResolvedValueOnce({ data: [otherSubscription], has_more: false });
    await createPortalSession(request);
    expect(stripe.subscriptions.list).not.toHaveBeenCalled();
    expect(stripe.billingPortal.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({ configuration: "bpc_intro" }),
    );
  });

  test("unrelated subscription reads do not block safe payment management", async () => {
    const { request, stripe } = subscriberFixture();
    stripe.subscriptions.list.mockRejectedValue(
      new Error("provider unavailable"),
    );
    await expect(createPortalSession(request)).resolves.toContain(
      "billing.stripe.com",
    );
    await expect(
      createCheckoutSession({
        ...request,
        priceId: "price_pro",
        tier: "pro",
        interval: "month",
      }),
    ).resolves.toContain("plan=pro");
    expect(stripe.billingPortal.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({ configuration: "bpc_intro" }),
    );
  });

  test.each(["invalid", "deleted", "retrieval_failed"])(
    "applied coupon %s retains actual term and safe management",
    async (lifecycle) => {
      const { request, stripe, coupon, discount } = subscriberFixture();
      if (lifecycle === "invalid") coupon.valid = false;
      else if (lifecycle === "deleted")
        Object.assign(discount.source, {
          coupon: { id: "coupon_intro", object: "coupon", deleted: true },
        });
      else {
        Object.assign(discount.source, { coupon: "coupon_intro" });
        stripe.coupons.retrieve.mockRejectedValue(
          new Error("coupon details unavailable"),
        );
      }
      const result = await getBillingSnapshot({
        stripe: request.stripe,
        guildId: request.guildId,
      });
      if (lifecycle === "invalid")
        expect(result.subscriptionDetails).toMatchObject({
          status: "available",
          discount: { endsAt: "2027-01-12T12:00:00.000Z", introductory: true },
          planChangesRestricted: false,
          planChangeRestrictionEndsAt: null,
        });
      else
        expect(result.subscriptionDetails).toEqual({ status: "unavailable" });
      await createPortalSession(request);
      expect(stripe.billingPortal.sessions.create).toHaveBeenCalledWith(
        expect.objectContaining({ configuration: "bpc_intro" }),
      );
      await expect(
        createCheckoutSession({
          ...request,
          priceId: "price_pro",
          tier: "pro",
          interval: "month",
        }),
      ).resolves.toContain("plan=pro");
      expect(discount.end).toBe(Date.parse("2027-01-12T12:00:00Z") / 1000);
    },
  );

  test("unsafe remaining-term portal never falls back to default management", async () => {
    const { request, stripe, portal } = subscriberFixture();
    portal.features.subscription_update.enabled = true;
    await expect(createPortalSession(request)).rejects.toThrow("configuration");
    expect(stripe.billingPortal.sessions.create).not.toHaveBeenCalled();
  });
});

describe("remaining offer boundary cases", () => {
  beforeEach(() => {
    resetMockStore();
    clearGuildSubscriptionCache();
    jest.useFakeTimers({ now });
    Object.assign(config.stripe.basicIntroOffer, settings);
  });
  afterEach(() => {
    jest.useRealTimers();
    clearGuildSubscriptionCache();
  });

  test.each([
    { lookup_key: "pro_monthly" },
    { transform_quantity: { divide_by: 2, round: "up" } },
  ])("native Price mismatch %p cannot qualify", async (change) => {
    const { price, client } = fixture();
    Object.assign(price, change);
    await expect(
      getBasicIntroOffer({ stripe: client, plans }),
    ).resolves.toEqual({ status: "unavailable" });
  });

  test("non-ISO dates do not activate an offer", async () => {
    config.stripe.basicIntroOffer.startsAt = "October 1, 2026";
    await expect(
      getBasicIntroOffer({ stripe: fixture().client, plans }),
    ).resolves.toEqual({ status: "unavailable" });
  });

  test("provider validation crossing cutoff cannot authorize a new coupon reservation", async () => {
    const { stripe, client } = fixture();
    stripe.prices.retrieve.mockImplementation(async () => {
      jest.setSystemTime(Date.parse(settings.enrollmentEndsAt));
      return fixture().price;
    });
    await expect(
      getBasicIntroOffer({ stripe: client, plans }),
    ).resolves.toEqual({ status: "expired" });
  });

  test("shared caller resolves its manual promotion instead of silently losing it", async () => {
    const { request } = purchaseFixture();
    await createCheckoutSession({
      ...request,
      promotionCode: "OTHER",
      offerChoice: "promotion",
      expectedOffer: "none",
    });
    expect(
      getMockStore().purchaseAttempts.get(request.guildId)?.checkout.discounts,
    ).toEqual([{ promotion_code: "promo_other" }]);
  });

  test("unavailable sale cannot block an actual Pro price mislabeled by a caller", async () => {
    const { request, coupon } = purchaseFixture();
    coupon.percent_off = 39;
    await createCheckoutSession({
      ...request,
      priceId: "price_pro",
      tier: "basic",
      interval: "month",
    });
    expect(
      getMockStore().purchaseAttempts.get(request.guildId)?.checkout.discounts,
    ).toBeUndefined();
  });

  test("matching reservation remains available to its payer after the enrollment off-switch", async () => {
    const { request } = purchaseFixture();
    await createCheckoutSession(request);
    Object.assign(config.stripe.basicIntroOffer, empty);
    await expect(
      getGuildBasicIntroOffer({
        stripe: request.stripe,
        guildId: request.guildId,
        payerId: "payer",
      }),
    ).resolves.toMatchObject({ status: "available", id: "basic_intro_v1" });
    await expect(
      getGuildBasicIntroOffer({
        stripe: request.stripe,
        guildId: request.guildId,
        payerId: "other",
      }),
    ).resolves.toEqual({ status: "unavailable" });
  });
});

test("a native account read crossing cutoff cannot create a new introductory reservation", async () => {
  resetMockStore();
  clearGuildSubscriptionCache();
  jest.useFakeTimers({ now });
  Object.assign(config.stripe.basicIntroOffer, settings);
  const { request, stripe } = purchaseFixture();
  stripe.accounts.retrieve.mockImplementationOnce(async () => {
    jest.setSystemTime(Date.parse(settings.enrollmentEndsAt));
    return { id: "acct-owned" };
  });
  try {
    await expect(
      createCheckoutSession({
        ...request,
        expectedOffer: "basic_intro_v1",
        tier: "basic",
        interval: "month",
      }),
    ).rejects.toThrow("changed");
    expect(getMockStore().purchaseAttempts.size).toBe(0);
  } finally {
    jest.useRealTimers();
  }
});

describe("configured-offer price classification failures", () => {
  const originalFallback = config.stripe.priceBasic;
  beforeEach(() => {
    resetMockStore();
    clearGuildSubscriptionCache();
    jest.useFakeTimers({ now });
    Object.assign(config.stripe.basicIntroOffer, settings);
    config.stripe.priceBasic = "";
  });
  afterEach(() => {
    jest.useRealTimers();
    config.stripe.priceBasic = originalFallback;
    clearGuildSubscriptionCache();
  });

  test("priceId-only Basic caller cannot lose its offer during catalog failure", async () => {
    const { request, stripe } = purchaseFixture();
    stripe.prices.list.mockRejectedValue(new Error("catalog unavailable"));
    await expect(createCheckoutSession(request)).rejects.toThrow("unavailable");
    expect(getMockStore().purchaseAttempts.size).toBe(0);
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  test("Pro-only catalog cannot let an actual Basic price fall through at regular price", async () => {
    const { request, stripe, price } = purchaseFixture();
    stripe.prices.list.mockResolvedValue({
      data: [
        {
          ...price,
          id: "price_pro",
          lookup_key: config.stripe.lookupKeys.proMonthly,
        },
      ],
    });
    await expect(
      createCheckoutSession({ ...request, tier: "basic", interval: "month" }),
    ).rejects.toThrow("unavailable");
    expect(getMockStore().purchaseAttempts.size).toBe(0);
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  test.each([
    ["price_pro", "proMonthly", "month"],
    ["price_basic_annual", "basicAnnual", "year"],
    ["price_pro_annual", "proAnnual", "year"],
  ] as const)(
    "native %s remains purchasable during catalog failure",
    async (priceId, lookup, interval) => {
      const { request, stripe, price } = purchaseFixture();
      stripe.prices.list.mockRejectedValue(new Error("catalog unavailable"));
      Object.assign(price, {
        id: priceId,
        lookup_key: config.stripe.lookupKeys[lookup],
        recurring: { interval, interval_count: 1, usage_type: "licensed" },
      });
      await createCheckoutSession({
        ...request,
        priceId,
        tier: "basic",
        interval: "month",
      });
      expect(
        getMockStore().purchaseAttempts.get(request.guildId)?.checkout
          .discounts,
      ).toBeUndefined();
      expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
    },
  );

  test("ambiguous Basic and Pro lookup configuration cannot authorize regular-price fallback", async () => {
    const previous = config.stripe.lookupKeys.proMonthly;
    config.stripe.lookupKeys.proMonthly = config.stripe.lookupKeys.basicMonthly;
    try {
      const { request, stripe } = purchaseFixture();
      stripe.prices.list.mockRejectedValue(new Error("catalog unavailable"));
      await expect(createCheckoutSession(request)).rejects.toThrow(
        "unavailable",
      );
      expect(getMockStore().purchaseAttempts.size).toBe(0);
      expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
    } finally {
      config.stripe.lookupKeys.proMonthly = previous;
    }
  });

  test("unclassifiable selected native price fails closed during catalog failure", async () => {
    const { request, stripe } = purchaseFixture();
    stripe.prices.list.mockRejectedValue(new Error("catalog unavailable"));
    stripe.prices.retrieve.mockRejectedValue(new Error("price unavailable"));
    await expect(createCheckoutSession(request)).rejects.toThrow("unavailable");
    expect(getMockStore().purchaseAttempts.size).toBe(0);
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });
});

describe("open-ended introductory enrollment", () => {
  beforeEach(() => {
    resetMockStore();
    clearGuildSubscriptionCache();
    jest.useFakeTimers({ now });
    Object.assign(config.stripe.basicIntroOffer, settings, {
      enrollmentEndsAt: "",
    });
  });
  afterEach(() => {
    jest.useRealTimers();
    clearGuildSubscriptionCache();
  });
  function openFixture() {
    const value = purchaseFixture();
    value.coupon.redeem_by = null;
    return value;
  }

  test("no enrollment end means a verified open-ended offer, with a three-month individual term", async () => {
    const { request } = openFixture();
    await expect(
      getBasicIntroOffer({ stripe: request.stripe, plans }),
    ).resolves.toMatchObject({
      status: "available",
      enrollmentEndsAt: null,
      durationMonths: 3,
      percentOff: 40,
    });
    jest.setSystemTime(Date.parse("2030-01-01T00:00:00Z"));
    await expect(
      getBasicIntroOffer({ stripe: request.stripe, plans }),
    ).resolves.toMatchObject({
      status: "available",
      enrollmentEndsAt: null,
      durationMonths: 3,
    });
  });

  test("a finite provider redemption deadline is unsafe for open-ended enrollment", async () => {
    const { request, coupon, stripe } = openFixture();
    coupon.redeem_by = Date.parse(settings.enrollmentEndsAt) / 1000 + 3600;
    await expect(
      getBasicIntroOffer({ stripe: request.stripe, plans }),
    ).resolves.toEqual({ status: "unavailable" });
    await expect(createCheckoutSession(request)).rejects.toThrow("unavailable");
    expect(getMockStore().purchaseAttempts.size).toBe(0);
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  test.each(["disabled", "ended"])(
    "deliberately %s enrollment preserves frozen attempts and refuses a fresh coupon",
    async (decision) => {
      const { request, stripe } = openFixture();
      stripe.checkout.sessions.create.mockRejectedValueOnce(
        new Error("lost response"),
      );
      await expect(
        createCheckoutSession({
          ...request,
          expectedOffer: "basic_intro_v1",
          tier: "basic",
          interval: "month",
        }),
      ).rejects.toThrow("lost response");
      const frozen = structuredClone(
        getMockStore().purchaseAttempts.get(request.guildId)?.checkout,
      );
      expect(frozen?.discounts).toEqual([{ coupon: "coupon_intro" }]);
      expect(frozen?.metadata).not.toHaveProperty(
        "intro_offer_enrollment_ends_at",
      );
      expect(frozen?.subscription_data?.metadata).not.toHaveProperty(
        "intro_offer_enrollment_ends_at",
      );
      if (decision === "disabled")
        Object.assign(config.stripe.basicIntroOffer, empty);
      else
        config.stripe.basicIntroOffer.enrollmentEndsAt = new Date(
          now,
        ).toISOString();
      await expect(
        getGuildBasicIntroOffer({
          stripe: request.stripe,
          guildId: request.guildId,
          payerId: "payer",
        }),
      ).resolves.toMatchObject({ status: "available", enrollmentEndsAt: null });
      await expect(
        createCheckoutSession({
          ...request,
          expectedOffer: "basic_intro_v1",
          tier: "basic",
          interval: "month",
        }),
      ).resolves.toContain("checkout.stripe.com");
      expect(
        getMockStore().purchaseAttempts.get(request.guildId)?.checkout,
      ).toEqual(frozen);
      expect(stripe.checkout.sessions.create.mock.calls[1]).toEqual(
        stripe.checkout.sessions.create.mock.calls[0],
      );
      await expect(
        createCheckoutSession({
          ...request,
          guildId: "222222222222222222",
          expectedOffer: "basic_intro_v1",
        }),
      ).rejects.toThrow(decision === "disabled" ? "changed" : "unavailable");
      expect(getMockStore().purchaseAttempts.has("222222222222222222")).toBe(
        false,
      );
      expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(2);
    },
  );
});

describe("annual first-year offer", () => {
  function annualFixture() {
    const base = purchaseFixture();
    const price = {
      ...base.price,
      id: "price_annual",
      unit_amount: 10000,
      lookup_key: config.stripe.lookupKeys.basicAnnual,
      recurring: {
        interval: "year",
        interval_count: 1,
        usage_type: "licensed",
      },
    };
    const coupon = {
      ...base.coupon,
      id: "coupon_annual",
      duration: "once",
      duration_in_months: null,
      redeem_by: null,
    };
    base.coupon.redeem_by = null;
    base.stripe.prices.retrieve.mockImplementation(async (id) =>
      id === price.id ? price : base.price,
    );
    base.stripe.prices.list.mockResolvedValue({ data: [base.price, price] });
    base.stripe.coupons.retrieve.mockImplementation(async (id) =>
      id === coupon.id ? coupon : base.coupon,
    );
    return {
      ...base,
      price,
      coupon,
      request: { ...base.request, priceId: price.id },
      plans: [
        ...plans,
        {
          tier: "basic",
          interval: "year",
          priceId: price.id,
          unitAmount: 10000,
          currency: "usd",
        },
      ],
    };
  }
  beforeEach(() => {
    resetMockStore();
    clearGuildSubscriptionCache();
    jest.useFakeTimers({ now });
    Object.assign(config.stripe.basicIntroOffer, settings, {
      annualCouponId: "coupon_annual",
      enrollmentEndsAt: "",
    });
  });
  afterEach(() => {
    jest.useRealTimers();
    Object.assign(config.stripe.basicIntroOffer, { annualCouponId: "" });
  });
  test("each new server qualifies even when its payer already paid for another server", async () => {
    const f = annualFixture();
    const customer = { id: "cus_intro", metadata: { discord_id: "payer" } };
    f.stripe.customers.list.mockResolvedValue({
      data: [customer],
      has_more: false,
    });
    Object.assign(f.stripe.customers, {
      retrieve: jest.fn(async () => customer),
    });
    Object.assign(f.request.user, { email: "payer@example.test" });
    getMockStore().subscriptions.set("another_server", {
      guildId: "another_server",
      tier: "basic",
      status: "active",
      subscriptionType: "stripe",
      stripeCustomerId: "cus_intro",
      stripeSubscriptionId: "sub_other",
      startDate: "2026-01-01",
    });
    await expect(
      createCheckoutSession({
        ...f.request,
        expectedOffer: "basic_annual_intro_v1",
      }),
    ).resolves.toContain("checkout.stripe.com");
    expect(
      getMockStore().purchaseAttempts.get(f.request.guildId)?.checkout
        .discounts,
    ).toEqual([{ coupon: "coupon_annual" }]);
    expect(captureEvent).toHaveBeenCalledWith(
      "billing_checkout_created",
      expect.objectContaining({
        properties: expect.objectContaining({
          offer: "basic_annual_intro_v1",
          promo_present: false,
        }),
      }),
    );
  });
  test.each(["disabled", "ended"])(
    "new annual enrollment after %s cannot silently accept stale offer",
    async (decision) => {
      const f = annualFixture();
      if (decision === "disabled")
        Object.assign(config.stripe.basicIntroOffer, empty, {
          annualCouponId: "",
        });
      else
        config.stripe.basicIntroOffer.enrollmentEndsAt = new Date(
          now,
        ).toISOString();
      await expect(
        createCheckoutSession({
          ...f.request,
          expectedOffer: "basic_annual_intro_v1",
        }),
      ).rejects.toThrow("changed");
      expect(getMockStore().purchaseAttempts.size).toBe(0);
      expect(f.stripe.checkout.sessions.create).not.toHaveBeenCalled();
    },
  );
  test("wrong client labels cannot change actual annual coupon identity", async () => {
    const f = annualFixture();
    await createCheckoutSession({
      ...f.request,
      tier: "pro",
      interval: "month",
      expectedOffer: "basic_annual_intro_v1",
    });
    expect(
      getMockStore().purchaseAttempts.get(f.request.guildId)?.checkout
        .discounts,
    ).toEqual([{ coupon: "coupon_annual" }]);
  });
  test("a selected stale Basic annual Price cannot silently become a regular purchase", async () => {
    const f = annualFixture();
    const oldPrice = { ...f.price, id: "price_old" };
    f.stripe.prices.retrieve.mockImplementation(async (id) =>
      id === oldPrice.id ? oldPrice : f.price,
    );
    await expect(
      createCheckoutSession({ ...f.request, priceId: oldPrice.id }),
    ).rejects.toThrow("changed");
    expect(getMockStore().purchaseAttempts.size).toBe(0);
  });
  test("each cadence can be enabled alone and missing annual stays inactive", async () => {
    const f = annualFixture();
    config.stripe.basicIntroOffer.annualCouponId = "";
    await expect(
      getBasicIntroOffer({
        stripe: f.request.stripe,
        plans: f.plans,
        interval: "year",
      }),
    ).resolves.toEqual({ status: "inactive" });
    config.stripe.basicIntroOffer.annualCouponId = "coupon_annual";
    config.stripe.basicIntroOffer.couponId = "";
    await expect(
      getBasicIntroOffer({ stripe: f.request.stripe, plans: f.plans }),
    ).resolves.toEqual({ status: "inactive" });
    await expect(
      createCheckoutSession({
        ...f.request,
        expectedOffer: "basic_annual_intro_v1",
      }),
    ).resolves.toContain("checkout.stripe.com");
  });
  test.each([
    "amount",
    "mode",
    "lookup",
    "quantity transform",
    "duration",
    "coupon amount",
    "product",
    "deadline",
    "portal",
    "missing shared start",
  ])("annual %s mismatch fails closed", async (kind) => {
    const f = annualFixture();
    if (kind === "amount") f.price.unit_amount = 9999;
    if (kind === "mode") f.price.livemode = true;
    if (kind === "lookup")
      f.price.lookup_key = config.stripe.lookupKeys.proAnnual;
    if (kind === "quantity transform")
      Object.assign(f.price, {
        transform_quantity: { divide_by: 2, round: "up" },
      });
    if (kind === "duration") f.coupon.duration = "repeating";
    if (kind === "coupon amount") f.coupon.percent_off = 50;
    if (kind === "product") f.coupon.applies_to.products = ["prod_other"];
    if (kind === "deadline") f.coupon.redeem_by = now / 1000 + 3600;
    if (kind === "portal") f.portal.features.subscription_update.enabled = true;
    if (kind === "missing shared start")
      config.stripe.basicIntroOffer.startsAt = "";
    await expect(
      getBasicIntroOffer({
        stripe: f.request.stripe,
        plans: f.plans,
        interval: "year",
      }),
    ).resolves.toEqual({ status: "unavailable" });
  });
  test("alternate promotion is explicit and frozen independently of annual terms", async () => {
    const f = annualFixture();
    await createCheckoutSession({
      ...f.request,
      promotionCode: "OTHER",
      offerChoice: "promotion",
      expectedOffer: "none",
    });
    expect(
      getMockStore().purchaseAttempts.get(f.request.guildId)?.checkout
        .discounts,
    ).toEqual([{ promotion_code: "promo_other" }]);
    await expect(
      createCheckoutSession({
        ...f.request,
        expectedOffer: "basic_annual_intro_v1",
      }),
    ).rejects.toThrow("Choose");
  });
  test("verifies separate native once annual terms and leaves monthly independently available", async () => {
    const f = annualFixture();
    await expect(
      getBasicIntroOffer({
        stripe: f.request.stripe,
        plans: f.plans,
        interval: "year",
      }),
    ).resolves.toMatchObject({
      status: "available",
      id: "basic_annual_intro_v1",
      regularUnitAmount: 10000,
      discountedUnitAmount: 6000,
      durationMonths: 12,
      enrollmentEndsAt: null,
    });
    f.coupon.duration = "repeating";
    await expect(
      getBasicIntroOffer({
        stripe: f.request.stripe,
        plans: f.plans,
        interval: "year",
      }),
    ).resolves.toEqual({ status: "unavailable" });
    await expect(
      getBasicIntroOffer({ stripe: f.request.stripe, plans: f.plans }),
    ).resolves.toMatchObject({ status: "available", id: "basic_intro_v1" });
  });
  test.each(["disabled", "ended", "rotated"])(
    "frozen annual response-loss survives %s and cadence switch cannot rewrite",
    async (decision) => {
      const f = annualFixture();
      f.stripe.checkout.sessions.create.mockRejectedValueOnce(
        new Error("lost response"),
      );
      await expect(
        createCheckoutSession({
          ...f.request,
          expectedOffer: "basic_annual_intro_v1",
        }),
      ).rejects.toThrow("lost response");
      const frozen = structuredClone(
        getMockStore().purchaseAttempts.get(f.request.guildId)?.checkout,
      );
      expect(frozen?.discounts).toEqual([{ coupon: "coupon_annual" }]);
      expect(frozen?.subscription_data?.metadata).toMatchObject({
        intro_offer_id: "basic_annual_intro_v1",
      });
      if (decision === "disabled")
        Object.assign(config.stripe.basicIntroOffer, empty, {
          annualCouponId: "",
        });
      if (decision === "ended")
        config.stripe.basicIntroOffer.enrollmentEndsAt = new Date(
          now,
        ).toISOString();
      if (decision === "rotated")
        Object.assign(config.stripe.basicIntroOffer, {
          annualCouponId: "coupon_new",
          portalConfigurationId: "bpc_new",
        });
      await expect(
        getGuildBasicIntroOffer({
          stripe: f.request.stripe,
          guildId: f.request.guildId,
          payerId: "payer",
          interval: "year",
        }),
      ).resolves.toMatchObject({
        status: "available",
        id: "basic_annual_intro_v1",
      });
      await expect(
        createCheckoutSession({
          ...f.request,
          expectedOffer: "basic_annual_intro_v1",
        }),
      ).resolves.toContain("checkout.stripe.com");
      expect(
        getMockStore().purchaseAttempts.get(f.request.guildId)?.checkout,
      ).toEqual(frozen);
      await expect(
        createCheckoutSession({
          ...f.request,
          priceId: "price_basic",
          expectedOffer: "basic_intro_v1",
        }),
      ).rejects.toThrow();
      expect(f.stripe.checkout.sessions.create).toHaveBeenCalledTimes(2);
    },
  );
  test("annual stale monthly expectation and promotion stacking fail before reservation", async () => {
    const f = annualFixture();
    await expect(
      createCheckoutSession({ ...f.request, expectedOffer: "basic_intro_v1" }),
    ).rejects.toThrow("changed");
    await expect(
      createCheckoutSession({ ...f.request, promotionCode: "OTHER" }),
    ).rejects.toThrow("Choose");
    expect(getMockStore().purchaseAttempts.size).toBe(0);
  });
  test.each(["failed", "partial"])(
    "annual unavailable cannot bypass with %s catalog",
    async (kind) => {
      const f = annualFixture();
      if (kind === "failed")
        f.stripe.prices.list.mockRejectedValue(new Error("catalog"));
      else
        f.stripe.prices.list.mockResolvedValue({
          data: [f.price].filter(() => false),
        });
      await expect(createCheckoutSession(f.request)).rejects.toThrow(
        "unavailable",
      );
      expect(getMockStore().purchaseAttempts.size).toBe(0);
    },
  );
});

import { getProviderSubscriptionDetails } from "../../src/services/basicIntroOfferService";
describe("consumed annual once invoice evidence", () => {
  beforeEach(() =>
    jest.useFakeTimers({ now: Date.parse("2026-10-12T12:00:00Z") }),
  );
  afterEach(() => jest.useRealTimers());
  function annualInvoiceFixture() {
    const price = {
      ...fixture().price,
      id: "price_annual",
      unit_amount: 10000,
      lookup_key: config.stripe.lookupKeys.basicAnnual,
      recurring: {
        interval: "year",
        interval_count: 1,
        usage_type: "licensed",
      },
    };
    const end = Date.parse("2027-10-12T12:00:00Z") / 1000;
    const coupon = {
      ...fixture().coupon,
      id: "coupon_annual",
      duration: "once",
      duration_in_months: null,
    };
    const discount = {
      id: "di_annual",
      source: { type: "coupon", coupon },
      promotion_code: null,
      end: null,
    };
    const invoice = {
      id: "in_first",
      status: "paid",
      livemode: false,
      customer: "cus_intro",
      currency: "usd",
      billing_reason: "subscription_create",
      parent: { subscription_details: { subscription: "sub_annual" } },
      subtotal: 10000,
      total_excluding_tax: 6000,
      total: 6420,
      amount_paid: 6420,
      amount_remaining: 0,
      starting_balance: 0,
      ending_balance: 0,
      pre_payment_credit_notes_amount: 0,
      post_payment_credit_notes_amount: 0,
      discounts: [discount],
      total_discount_amounts: [{ amount: 4000, discount: "di_annual" }],
      lines: {
        has_more: false,
        data: [
          {
            id: "il_annual",
            invoice: "in_first",
            currency: "usd",
            livemode: false,
            subtotal: 10000,
            quantity: 1,
            pricing: { price_details: { price: "price_annual" } },
            parent: {
              subscription_item_details: {
                subscription: "sub_annual",
                subscription_item: "si_annual",
                proration: false,
              },
            },
            period: { start: now / 1000, end },
            discount_amounts: [{ amount: 4000, discount: "di_annual" }],
            pretax_credit_amounts: [],
          },
        ],
      },
    };
    const subscription = {
      id: "sub_annual",
      status: "active",
      livemode: false,
      customer: "cus_intro",
      metadata: {
        intro_offer_id: "basic_annual_intro_v1",
        intro_offer_coupon_id: "coupon_annual",
        intro_offer_portal_configuration_id: "bpc_intro",
      },
      discounts: [],
      latest_invoice: "in_first",
      items: {
        data: [
          {
            id: "si_annual",
            price,
            quantity: 1,
            discounts: [],
            current_period_start: now / 1000,
            current_period_end: end,
          },
        ],
      },
    };
    const stripe = {
      ...fixture().stripe,
      invoices: { retrieve: jest.fn(async () => invoice) },
      subscriptions: {
        list: jest.fn(async () => ({ data: [subscription], has_more: false })),
      },
    };
    return {
      invoice,
      subscription,
      stripe,
      client: stripe as unknown as StripeClient,
      native: subscription as unknown as import("stripe").default.Subscription,
    };
  }
  test.each([true, false])(
    "native annual portal configuration follows actual unconsumed discount: %s",
    async (unconsumed) => {
      resetMockStore();
      const f = annualInvoiceFixture();
      const guildId = "111111111111111111";
      Object.assign(f.subscription.metadata, { guild_id: guildId });
      if (unconsumed)
        Object.assign(f.subscription, { discounts: f.invoice.discounts });
      Object.assign(f.stripe.subscriptions, {
        retrieve: jest.fn(async () => f.subscription),
      });
      Object.assign(f.stripe, {
        customers: {
          retrieve: jest.fn(async () => ({
            id: "cus_intro",
            metadata: { discord_id: "payer" },
          })),
        },
      });
      const sessions = {
        create: jest.fn(async () => ({
          url: "https://billing.stripe.com/manage",
        })),
      };
      Object.assign(f.stripe.billingPortal, { sessions });
      getMockStore().subscriptions.set(guildId, {
        guildId,
        tier: "basic",
        status: "active",
        subscriptionType: "stripe",
        stripeCustomerId: "cus_intro",
        stripeSubscriptionId: f.subscription.id,
        startDate: "2026-10-12",
      });
      await expect(
        createPortalSession({
          stripe: f.client,
          user: { id: "payer" },
          guildId,
        }),
      ).resolves.toContain("billing.stripe.com");
      expect(sessions.create).toHaveBeenCalledWith(
        expect.objectContaining({ configuration: "bpc_intro" }),
      );
    },
  );
  test("expanded invoice reference is read with native discount expansion", async () => {
    const f = annualInvoiceFixture();
    Object.assign(f.subscription, { latest_invoice: f.invoice });
    await expect(
      getProviderSubscriptionDetails(f.client, f.native),
    ).resolves.toMatchObject({ firstYearPayment: { status: "available" } });
    expect(f.stripe.invoices.retrieve).toHaveBeenCalledWith("in_first", {
      expand: ["discounts.source.coupon"],
    });
  });
  function regularRenewalFixture() {
    const f = annualInvoiceFixture();
    f.invoice.id = "in_renewal";
    f.subscription.latest_invoice = "in_renewal";
    f.invoice.billing_reason = "subscription_cycle";
    f.invoice.discounts = [];
    f.invoice.total_discount_amounts = [];
    f.invoice.total_excluding_tax = 10000;
    f.invoice.total = 10000;
    f.invoice.amount_paid = 10000;
    const line = f.invoice.lines.data[0];
    line.invoice = "in_renewal";
    line.discount_amounts = [];
    line.period = {
      start: line.period.end,
      end: line.period.end + 366 * 86400,
    };
    f.subscription.items.data[0].current_period_start = line.period.start;
    f.subscription.items.data[0].current_period_end = line.period.end;
    return f;
  }
  test("a verified regular annual renewal is not unavailable first-year evidence", async () => {
    const f = regularRenewalFixture();
    await expect(
      getProviderSubscriptionDetails(f.client, f.native),
    ).resolves.toMatchObject({
      status: "available",
      unitAmount: 10000,
      discountedUnitAmount: null,
      firstYearPayment: null,
    });
    expect(f.stripe.coupons.retrieve).not.toHaveBeenCalled();
  });
  test.each(["customer", "subscription", "price", "period"])(
    "a mismatched regular-cycle %s cannot hide unavailable evidence",
    async (kind) => {
      const f = regularRenewalFixture();
      if (kind === "customer") f.invoice.customer = "cus_other";
      if (kind === "subscription")
        f.invoice.parent.subscription_details.subscription = "sub_other";
      if (kind === "price")
        f.invoice.lines.data[0].pricing.price_details.price = "price_other";
      if (kind === "period") f.invoice.lines.data[0].period.end += 86400;
      await expect(
        getProviderSubscriptionDetails(f.client, f.native),
      ).resolves.toMatchObject({
        status: "available",
        firstYearPayment: { status: "unavailable" },
      });
    },
  );
  test.each([
    { interval: "month", count: 3 },
    { interval: "year", count: 2 },
  ])(
    "does not label a $count-$interval price as one standard interval",
    async ({ interval, count }) => {
      const f = annualInvoiceFixture();
      f.subscription.items.data[0].price.recurring.interval = interval;
      f.subscription.items.data[0].price.recurring.interval_count = count;
      await expect(
        getProviderSubscriptionDetails(f.client, f.native),
      ).resolves.toEqual({ status: "unavailable" });
      expect(f.stripe.invoices.retrieve).not.toHaveBeenCalled();
    },
  );

  test("string invoice retains paid first-year subtotal and actual tax-inclusive payment after coupon is consumed", async () => {
    const f = annualInvoiceFixture();
    await expect(
      getProviderSubscriptionDetails(f.client, f.native),
    ).resolves.toMatchObject({
      status: "available",
      unitAmount: 10000,
      discountedUnitAmount: null,
      planChangesRestricted: false,
      firstYearPayment: {
        status: "available",
        currency: "usd",
        discountedSubtotal: 6000,
        amountPaid: 6420,
        periodStartsAt: "2026-10-12T12:00:00.000Z",
        periodEndsAt: "2027-10-12T12:00:00.000Z",
      },
    });
  });
  test.each([
    "unpaid",
    "other subscription",
    "wrong price",
    "proration",
    "missing discount",
    "multiple lines",
    "credit",
    "other period",
    "inaccessible",
  ])(
    "%s cannot fabricate paid first-year detail or restrict consumed portal",
    async (kind) => {
      const f = annualInvoiceFixture();
      if (kind === "unpaid") f.invoice.status = "open";
      if (kind === "other subscription")
        f.invoice.parent.subscription_details.subscription = "sub_other";
      if (kind === "wrong price")
        f.invoice.lines.data[0].pricing.price_details.price = "price_other";
      if (kind === "proration")
        f.invoice.lines.data[0].parent.subscription_item_details.proration = true;
      if (kind === "missing discount") f.invoice.discounts = [];
      if (kind === "multiple lines") f.invoice.lines.has_more = true;
      if (kind === "credit") f.invoice.starting_balance = -100;
      if (kind === "other period") f.invoice.lines.data[0].period.end += 86400;
      if (kind === "inaccessible")
        f.stripe.invoices.retrieve.mockRejectedValue(new Error("offline"));
      await expect(
        getProviderSubscriptionDetails(f.client, f.native),
      ).resolves.toMatchObject({
        status: "available",
        unitAmount: 10000,
        firstYearPayment: { status: "unavailable" },
        planChangesRestricted: false,
      });
    },
  );
});

describe("per-offer history authorization", () => {
  beforeEach(() => {
    resetMockStore();
    clearGuildSubscriptionCache();
    jest.useFakeTimers({ now });
    Object.assign(config.stripe.basicIntroOffer, settings);
  });
  afterEach(() => {
    jest.useRealTimers();
  });
  test("rollout off keeps configured offers inactive", async () => {
    const f = purchaseFixture();
    config.stripe.introOfferLedgerEnabled = false;
    expect(
      await getBasicIntroOffer({ stripe: f.request.stripe, plans, now }),
    ).toEqual({ status: "inactive" });
    expect(
      await getGuildBasicIntroOffer({
        stripe: f.request.stripe,
        guildId: f.request.guildId,
      }),
    ).toEqual({ status: "inactive" });
    await expect(
      createCheckoutSession({ ...f.request, expectedOffer: "basic_intro_v1" }),
    ).rejects.toMatchObject({ reason: "offer_changed_terms" });
    expect(f.stripe.customers.create).not.toHaveBeenCalled();
  });
  test("missing history cannot silently charge regular price for automatic Basic", async () => {
    const f = purchaseFixture();
    getMockStore().historicalOfferImports.clear();
    expect(
      await getGuildBasicIntroOffer({
        stripe: f.request.stripe,
        guildId: f.request.guildId,
      }),
    ).toEqual({ status: "unavailable" });
    await expect(createCheckoutSession(f.request)).rejects.toMatchObject({
      reason: "offer_unavailable",
    });
    expect(f.stripe.customers.create).not.toHaveBeenCalled();
    expect(f.stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });
  test.each(["coverage", "boundary"])(
    "changing %s before reservation prevents all provider writes",
    async (which) => {
      const f = purchaseFixture();
      const repository =
        await import("../../src/repositories/purchaseAttemptRepository");
      const real = repository.getPurchaseRepository();
      const spy = jest
        .spyOn(repository, "getPurchaseRepository")
        .mockReturnValue({
          ...real,
          compareAndWrite: async (...args) => {
            if (which === "coverage")
              getMockStore().historicalOfferImports.clear();
            else getMockStore().historyWriterBoundaries.clear();
            return real.compareAndWrite(...args);
          },
        });
      try {
        await expect(createCheckoutSession(f.request)).rejects.toMatchObject({
          reason: "offer_unavailable",
        });
      } finally {
        spy.mockRestore();
      }
      expect(getMockStore().purchaseAttempts.size).toBe(0);
      expect(getMockStore().offerUsages.size).toBe(0);
      expect(f.stripe.customers.create).not.toHaveBeenCalled();
      expect(f.stripe.checkout.sessions.create).not.toHaveBeenCalled();
    },
  );
  test("a completed regular purchase and changed payer preserve unused offer", async () => {
    const f = purchaseFixture();
    getMockStore().purchaseAttempts.set(f.request.guildId, {
      guildId: f.request.guildId,
      attemptId: "old-regular",
      revision: "r",
      payerId: "other",
      mode: "test",
      fingerprint: "f",
      createdAt: 100,
      state: "completed",
      checkout: {},
      customerId: "old",
      subscriptionId: "old",
    });
    expect(
      await getGuildBasicIntroOffer({
        stripe: f.request.stripe,
        guildId: f.request.guildId,
        payerId: "payer",
        plans,
      }),
    ).toMatchObject({ status: "available", id: "basic_intro_v1" });
  });
});

test("frozen introductory checkout without its reservation cannot resume provider work", async () => {
  resetMockStore();
  clearGuildSubscriptionCache();
  jest.useFakeTimers({ now });
  Object.assign(config.stripe.basicIntroOffer, settings);
  const f = purchaseFixture();
  try {
    await createCheckoutSession(f.request);
    getMockStore().offerUsages.clear();
    await expect(createCheckoutSession(f.request)).rejects.toMatchObject({
      reason: "offer_unavailable",
    });
    expect(f.stripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
  } finally {
    jest.useRealTimers();
  }
});
