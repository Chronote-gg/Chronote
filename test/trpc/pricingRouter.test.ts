import * as offerService from "../../src/services/basicIntroOfferService";
/** @jest-environment node */
import { pricingRouter } from "../../src/trpc/routers/pricing";
import { config } from "../../src/services/configService";
import { getStripeClient } from "../../src/services/stripeClient";
import type { StripeClient } from "../../src/types/stripe";
import type { TrpcContext } from "../../src/trpc/context";
import { basicMonthlyTestPrice } from "../fixtures/stripePrices";

jest.mock("../../src/services/stripeClient", () => ({
  getStripeClient: jest.fn(),
}));
beforeEach(() => {
  config.stripe.introOfferLedgerEnabled = true;
});
const originalMock = config.mock.enabled;
const originalMode = config.subscription.stripeMode;
const originalSettings = { ...config.stripe.basicIntroOffer };
afterEach(() => {
  config.stripe.introOfferLedgerEnabled = false;
  config.mock.enabled = originalMock;
  config.subscription.stripeMode = originalMode;
  Object.assign(config.stripe.basicIntroOffer, originalSettings);
  jest.useRealTimers();
});
function publicOfferFixture(valid = true) {
  const providerValidity = { valid };
  const price = basicMonthlyTestPrice();
  const annualPrice = {
    ...price,
    id: "price_annual",
    unit_amount: 10000,
    lookup_key: config.stripe.lookupKeys.basicAnnual,
    recurring: { ...price.recurring, interval: "year" },
  };
  const stripe = {
    prices: {
      list: jest.fn(async () => ({ data: [price, annualPrice] })),
      retrieve: jest.fn(async (id: string) =>
        id === annualPrice.id ? annualPrice : price,
      ),
    },
    coupons: {
      retrieve: jest.fn(async (id: string) => ({
        id,
        valid: providerValidity.valid,
        livemode: false,
        percent_off: 40,
        amount_off: null,
        currency: null,
        duration: id === "coupon_annual" ? "once" : "repeating",
        duration_in_months: id === "coupon_annual" ? null : 3,
        redeem_by: null,
      })),
    },
    billingPortal: {
      configurations: {
        retrieve: jest.fn(async () => ({
          id: "bpc_intro",
          active: true,
          livemode: false,
          features: {
            subscription_update: { enabled: false },
            payment_method_update: { enabled: true },
            subscription_cancel: { enabled: true },
          },
        })),
      },
    },
  };
  return {
    stripe,
    client: stripe as unknown as StripeClient,
    providerValidity,
  };
}

const caller = () => pricingRouter.createCaller({} as TrpcContext);

test("mock pricing preserves regular fixtures with no active offer", async () => {
  config.mock.enabled = true;
  const result = await caller().plans();
  expect(
    result.plans.find(
      (plan) => plan.tier === "basic" && plan.interval === "month",
    )?.unitAmount,
  ).toBe(1200);
  expect(result.introOffer).toEqual({ status: "inactive" });
  expect(result.annualIntroOffer).toEqual({ status: "inactive" });
});

test.each([true, false])(
  "public pricing advertises only verified provider terms, coupon valid %s",
  async (valid) => {
    config.mock.enabled = false;
    jest.useFakeTimers({ now: Date.parse("2026-10-12T12:00:00Z") });
    Object.assign(config.stripe.basicIntroOffer, {
      couponId: "coupon_intro",
      annualCouponId: "coupon_annual",
      startsAt: "2026-10-01T00:00:00Z",
      enrollmentEndsAt: "",
      portalConfigurationId: "bpc_intro",
    });
    const { stripe } = publicOfferFixture(valid);
    jest
      .mocked(getStripeClient)
      .mockReturnValue(stripe as unknown as StripeClient);
    const result = await caller().plans();
    expect(result.introOffer).toMatchObject({
      status: valid ? "available" : "unavailable",
    });
    if (valid)
      expect(result.introOffer).toMatchObject({ enrollmentEndsAt: null });
    expect(result.introOffer).not.toHaveProperty("couponId");
    expect(result.annualIntroOffer).toMatchObject({
      status: valid ? "available" : "unavailable",
    });
    if (valid)
      expect(result.annualIntroOffer).toMatchObject({
        id: "basic_annual_intro_v1",
        discountedUnitAmount: 6000,
        enrollmentEndsAt: null,
      });
    expect(result.annualIntroOffer).not.toHaveProperty("couponId");
  },
);

function configuredPublicFixture() {
  config.mock.enabled = false;
  jest.useFakeTimers({ now: Date.parse("2026-10-12T12:00:00Z") });
  Object.assign(config.stripe.basicIntroOffer, {
    couponId: "coupon_intro",
    annualCouponId: "coupon_annual",
    startsAt: "2026-10-01T00:00:00Z",
    enrollmentEndsAt: "",
    portalConfigurationId: "bpc_intro",
  });
  const fixture = publicOfferFixture();
  jest.mocked(getStripeClient).mockReturnValue(fixture.client);
  return fixture;
}
test("concurrent anonymous pricing requests coalesce native offer verification", async () => {
  const { stripe } = configuredPublicFixture();
  const results = await Promise.all([
    caller().plans(),
    caller().plans(),
    caller().plans(),
  ]);
  for (const result of results)
    expect(result.introOffer.status).toBe("available");
  expect(stripe.prices.list).toHaveBeenCalledTimes(1);
  expect(stripe.coupons.retrieve).toHaveBeenCalledTimes(2);
  expect(stripe.billingPortal.configurations.retrieve).toHaveBeenCalledTimes(2);
});
test("public pricing verification expires after its bounded cache window", async () => {
  const { stripe } = configuredPublicFixture();
  await caller().plans();
  await caller().plans();
  expect(stripe.coupons.retrieve).toHaveBeenCalledTimes(2);
  jest.advanceTimersByTime(31000);
  await caller().plans();
  expect(stripe.coupons.retrieve).toHaveBeenCalledTimes(4);
});
test("rotating campaign configuration invalidates public verification immediately", async () => {
  const { stripe } = configuredPublicFixture();
  await caller().plans();
  config.stripe.basicIntroOffer.couponId = "coupon_rotated";
  await caller().plans();
  expect(stripe.coupons.retrieve).toHaveBeenCalledWith("coupon_rotated", {
    expand: ["applies_to"],
  });
});
test("provider mode changes cannot reuse verified test offers", async () => {
  configuredPublicFixture();
  await caller().plans();
  config.subscription.stripeMode = "live";
  expect((await caller().plans()).introOffer.status).toBe("unavailable");
});
test("cached offers stop at the exact enrollment cutoff", async () => {
  configuredPublicFixture();
  config.stripe.basicIntroOffer.enrollmentEndsAt = new Date(
    Date.now() + 10000,
  ).toISOString();
  expect((await caller().plans()).introOffer.status).toBe("available");
  jest.advanceTimersByTime(10000);
  expect((await caller().plans()).introOffer.status).toBe("expired");
});
test("failed public verification recovers promptly after provider repair", async () => {
  const { providerValidity } = configuredPublicFixture();
  providerValidity.valid = false;
  expect((await caller().plans()).introOffer.status).toBe("unavailable");
  providerValidity.valid = true;
  jest.advanceTimersByTime(1100);
  expect((await caller().plans()).introOffer.status).toBe("available");
});

test("cached pre-launch pricing switches at the exact campaign start", async () => {
  configuredPublicFixture();
  config.stripe.basicIntroOffer.startsAt = new Date(
    Date.now() + 10000,
  ).toISOString();
  expect((await caller().plans()).introOffer.status).toBe("inactive");
  jest.advanceTimersByTime(10000);
  expect((await caller().plans()).introOffer.status).toBe("available");
});
test("price lookup changes immediately invalidate verified public terms", async () => {
  const fixture = configuredPublicFixture();
  const originalKey = config.stripe.lookupKeys.basicMonthly;
  try {
    await caller().plans();
    config.stripe.lookupKeys.basicMonthly = "rotated_basic";
    expect((await caller().plans()).introOffer.status).toBe("unavailable");
    expect(fixture.stripe.prices.list).toHaveBeenCalledTimes(2);
  } finally {
    config.stripe.lookupKeys.basicMonthly = originalKey;
  }
});
test("in-flight config rotation cannot leave a reusable obsolete public result", async () => {
  const fixture = configuredPublicFixture();
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = fixture.stripe.coupons.retrieve.getMockImplementation()!;
  fixture.stripe.coupons.retrieve.mockImplementation(async (id) => {
    await hold;
    return original(id);
  });
  const pending = caller().plans();
  await Promise.resolve();
  await Promise.resolve();
  config.stripe.basicIntroOffer.couponId = "coupon_rotated";
  release();
  await pending;
  fixture.stripe.coupons.retrieve.mockImplementation(original);
  await caller().plans();
  expect(fixture.stripe.prices.list).toHaveBeenCalledTimes(2);
});
test("failed price inventory is not retained in the public cache", async () => {
  const fixture = configuredPublicFixture();
  fixture.stripe.prices.list.mockRejectedValueOnce(
    new Error("inventory failed"),
  );
  await expect(caller().plans()).rejects.toMatchObject({
    code: "INTERNAL_SERVER_ERROR",
  });
  expect((await caller().plans()).introOffer.status).toBe("available");
  expect(fixture.stripe.prices.list).toHaveBeenCalledTimes(2);
});

test("a monthly result completed before cutoff cannot stay available while annual verification finishes after cutoff", async () => {
  const fixture = configuredPublicFixture();
  config.stripe.basicIntroOffer.enrollmentEndsAt = new Date(
    Date.now() + 10000,
  ).toISOString();
  let finishAnnual!: () => void;
  const annualHold = new Promise<void>((resolve) => {
    finishAnnual = resolve;
  });
  const originalCoupon =
    fixture.stripe.coupons.retrieve.getMockImplementation()!;
  fixture.stripe.coupons.retrieve.mockImplementation(async (id) => {
    if (id === "coupon_annual") await annualHold;
    return originalCoupon(id);
  });
  let monthlyComplete!: () => void;
  const monthlyDone = new Promise<void>((resolve) => {
    monthlyComplete = resolve;
  });
  const originalOffer = offerService.getBasicIntroOffer;
  const spy = jest
    .spyOn(offerService, "getBasicIntroOffer")
    .mockImplementation(async (params) => {
      const result = await originalOffer(params);
      if (params.interval !== "year") monthlyComplete();
      return result;
    });
  try {
    const pending = caller().plans();
    await monthlyDone;
    jest.advanceTimersByTime(10000);
    finishAnnual();
    const result = await pending;
    expect(result.introOffer.status).toBe("expired");
    expect(result.annualIntroOffer.status).toBe("expired");
    expect((await caller().plans()).introOffer.status).toBe("expired");
  } finally {
    finishAnnual();
    spy.mockRestore();
  }
});

test("launch crossing while cadence results join requires new provider verification", async () => {
  const fixture = configuredPublicFixture();
  config.stripe.basicIntroOffer.startsAt = new Date(
    Date.now() + 10000,
  ).toISOString();
  let finishAnnual!: () => void;
  const annualHold = new Promise<void>((resolve) => {
    finishAnnual = resolve;
  });
  let monthlyComplete!: () => void;
  const monthlyDone = new Promise<void>((resolve) => {
    monthlyComplete = resolve;
  });
  const originalOffer = offerService.getBasicIntroOffer;
  const spy = jest
    .spyOn(offerService, "getBasicIntroOffer")
    .mockImplementation(async (params) => {
      const result = await originalOffer(params);
      if (params.interval === "year") await annualHold;
      else monthlyComplete();
      return result;
    });
  try {
    const pending = caller().plans();
    await monthlyDone;
    jest.advanceTimersByTime(10000);
    finishAnnual();
    const result = await pending;
    expect(result.introOffer.status).toBe("available");
    expect(result.annualIntroOffer.status).toBe("available");
    expect(fixture.stripe.coupons.retrieve).toHaveBeenCalledTimes(2);
  } finally {
    finishAnnual();
    spy.mockRestore();
  }
});
