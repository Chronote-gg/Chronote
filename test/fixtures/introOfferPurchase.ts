import { seedUnusedOfferCoverage } from "./historyWriterBoundary";
import { basicMonthlyTestPrice } from "./stripePrices";
import { config } from "../../src/services/configService";
import { getMockStore } from "../../src/repositories/mockStore";
import type { StripeClient } from "../../src/types/stripe";

export const introNow = Date.parse("2026-10-12T12:00:00Z");
export const introSettings = {
  couponId: "coupon_intro",
  startsAt: "2026-10-01T00:00:00Z",
  enrollmentEndsAt: "2026-11-01T00:00:00Z",
  portalConfigurationId: "bpc_intro",
};
export function introOfferStripe() {
  seedUnusedOfferCoverage();
  const price = basicMonthlyTestPrice();
  const coupon = {
    id: "coupon_intro",
    valid: true,
    livemode: false,
    percent_off: 40,
    amount_off: null,
    currency: null,
    duration: "repeating",
    duration_in_months: 3,
    redeem_by: introSettings.enrollmentEndsAt
      ? Date.parse(introSettings.enrollmentEndsAt) / 1000 + 3600
      : null,
    applies_to: { products: ["prod_basic"] },
  };
  const portal = {
    id: "bpc_intro",
    active: true,
    livemode: false,
    features: {
      subscription_update: { enabled: false },
      payment_method_update: { enabled: true },
      subscription_cancel: { enabled: true },
    },
  };
  const stripe = {
    accounts: { retrieve: jest.fn(async () => ({ id: "acct-owned" })) },
    balance: { retrieve: jest.fn(async () => ({ livemode: false })) },
    prices: { retrieve: jest.fn(async () => price) },
    coupons: { retrieve: jest.fn(async () => coupon) },
    billingPortal: {
      configurations: { retrieve: jest.fn(async () => portal) },
    },
  };
  return {
    price,
    coupon,
    portal,
    stripe,
    client: stripe as unknown as StripeClient,
  };
}

/** `expire` marks a session expired at the provider, so later retrieves report it expired. */
export function introPurchaseFixture() {
  const offer = introOfferStripe();
  const guildId = "111111111111111111";
  const expired = new Set<string>();
  const session = (id: string, isExpired = expired.has(id)) => ({
    id,
    status: isExpired ? "expired" : "open",
    url: isExpired ? null : "https://checkout.stripe.com/intro",
    livemode: false,
    customer: "cus_intro",
    metadata: {
      guild_id: guildId,
      purchase_attempt_id:
        getMockStore().purchaseAttempts.get(guildId)?.attemptId,
    },
  });
  const checkout = {
    sessions: {
      create: jest.fn(async () => session("cs_intro", false)),
      retrieve: jest.fn(async (id = "cs_intro") => session(id)),
      expire: jest.fn(async (id: string) => {
        expired.add(id);
        return session(id);
      }),
    },
  };
  const stripe = {
    ...offer.stripe,
    prices: {
      ...offer.stripe.prices,
      retrieve: jest.fn(async (priceId: string) => {
        if (priceId === "price_pro")
          return {
            ...offer.price,
            id: priceId,
            lookup_key: config.stripe.lookupKeys.proMonthly,
          };
        if (priceId === "price_annual")
          return {
            ...offer.price,
            id: priceId,
            lookup_key: config.stripe.lookupKeys.basicAnnual,
            recurring: {
              interval: "year",
              interval_count: 1,
              usage_type: "licensed",
            },
          };
        return offer.price;
      }),
      list: jest.fn(async () => ({
        data: [
          { ...offer.price, lookup_key: config.stripe.lookupKeys.basicMonthly },
          {
            ...offer.price,
            id: "price_annual",
            lookup_key: config.stripe.lookupKeys.basicAnnual,
            recurring: {
              interval: "year",
              interval_count: 1,
              usage_type: "licensed",
            },
          },
          {
            ...offer.price,
            id: "price_pro",
            lookup_key: config.stripe.lookupKeys.proMonthly,
          },
        ],
      })),
    },
    promotionCodes: {
      list: jest.fn(async () => ({ data: [{ id: "promo_other" }] })),
    },
    customers: {
      list: jest.fn(async () => ({ data: [], has_more: false })),
      create: jest.fn(async () => ({ id: "cus_intro" })),
    },
    checkout,
  };
  return {
    ...offer,
    stripe,
    request: {
      stripe: stripe as unknown as StripeClient,
      guildId,
      user: { id: "payer" },
      priceId: "price_basic",
    },
  };
}
