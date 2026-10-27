/** @jest-environment node */
import {
  afterAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
jest.mock("../../src/services/runtimeApiOperationService", () => ({
  runRuntimeApiOperation: jest.requireActual("../fixtures/runtimeApiOperation")
    .runTestApiOperation,
}));
import { config } from "../../src/services/configService";
import {
  createCheckoutSession,
  createPortalSession,
} from "../../src/services/billingService";
import { getMockStore, resetMockStore } from "../../src/repositories/mockStore";
import type { StripeClient } from "../../src/types/stripe";
import { captureEvent } from "../../src/services/analyticsService";
jest.mock("../../src/services/analyticsService", () => ({
  captureEvent: jest.fn(),
}));

const guildId = "111111111111111111";
const user = { id: "payer", email: "payer@example.test" };
const originalTransitionsEnabled = config.stripe.subscriptionTransitionsEnabled;
const originalPortal = config.stripe.basicIntroOffer.portalConfigurationId;
afterAll(() => {
  config.stripe.subscriptionTransitionsEnabled = originalTransitionsEnabled;
  config.stripe.basicIntroOffer.portalConfigurationId = originalPortal;
});

function fixture() {
  const subscription = {
    id: "sub_existing",
    livemode: false,
    status: "active",
    customer: "cus_existing",
    metadata: { guild_id: guildId, discord_id: user.id },
    items: {
      data: [{ id: "si_existing", quantity: 1, price: { id: "price_basic" } }],
    },
  };
  const stripe = {
    subscriptions: {
      retrieve: jest.fn(async () => subscription),
      list: jest.fn(async () => ({ data: [subscription], has_more: false })),
    },
    customers: {
      retrieve: jest.fn(async () => ({
        id: "cus_existing",
        metadata: { discord_id: user.id },
      })),
      list: jest.fn(
        async (): Promise<{
          data: Array<{ id: string; metadata: { discord_id: string } }>;
          has_more?: boolean;
        }> => ({ data: [] }),
      ),
      create: jest.fn(async () => ({ id: "cus_new" })),
    },
    checkout: {
      sessions: {
        create: jest.fn(async () => ({
          metadata: {
            guild_id: guildId,
            purchase_attempt_id:
              getMockStore().purchaseAttempts.get(guildId)?.attemptId,
          },
          customer: "cus_new",
          livemode: false,
          id: "cs_new",
          status: "open",
          url: "https://checkout.stripe.com/new",
        })),
      },
    },
    billingPortal: {
      configurations: {
        retrieve: jest.fn(async () => ({
          id: "bpc_changes",
          active: true,
          livemode: false,
          features: {
            subscription_update: { enabled: false },
            payment_method_update: { enabled: true },
            subscription_cancel: { enabled: true },
          },
        })),
      },
      sessions: {
        create: jest.fn(async () => ({
          url: "https://billing.stripe.com/confirm",
        })),
      },
    },
  };
  return { subscription, stripe, client: stripe as unknown as StripeClient };
}

beforeEach(() => {
  config.stripe.basicIntroOffer.portalConfigurationId = originalPortal;
  jest.clearAllMocks();
  config.stripe.subscriptionTransitionsEnabled = true;
  resetMockStore();
  getMockStore().subscriptions.set(guildId, {
    guildId,
    tier: "basic",
    status: "active",
    subscriptionType: "stripe",
    startDate: "2026-08-01T00:00:00Z",
    stripeSubscriptionId: "sub_existing",
    stripeCustomerId: "cus_existing",
  });
});

describe("existing server subscription checkout", () => {
  it("blocks active plan changes after verifying the provider while activation is disabled", async () => {
    config.stripe.subscriptionTransitionsEnabled = false;
    const { stripe, client } = fixture();
    await expect(
      createCheckoutSession({
        stripe: client,
        user,
        guildId,
        priceId: "price_pro",
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message:
        "Plan changes are not available yet. Your current subscription is unchanged; contact support for help.",
    });
    expect(stripe.subscriptions.retrieve).toHaveBeenCalledTimes(1);
    expect(stripe.customers.retrieve).not.toHaveBeenCalled();
    expect(stripe.customers.list).not.toHaveBeenCalled();
    expect(stripe.customers.create).not.toHaveBeenCalled();
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
    expect(stripe.billingPortal.sessions.create).not.toHaveBeenCalled();
    expect(getMockStore().subscriptions.get(guildId)?.tier).toBe("basic");
  });

  it("retains initial purchase Checkout while existing transitions are disabled", async () => {
    config.stripe.subscriptionTransitionsEnabled = false;
    getMockStore().subscriptions.delete(guildId);
    const { stripe, client } = fixture();
    await expect(
      createCheckoutSession({
        stripe: client,
        user,
        guildId,
        priceId: "price_basic",
        source: "discord_summary",
        tier: "basic",
        interval: "year",
      }),
    ).resolves.toBe("https://checkout.stripe.com/new");
    expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
    expect(stripe.billingPortal.sessions.create).not.toHaveBeenCalled();
    expect(captureEvent).toHaveBeenCalledWith(
      "billing_checkout_created",
      expect.objectContaining({
        userId: user.id,
        guildId,
        properties: expect.objectContaining({
          source: "discord_summary",
          tier: "basic",
          interval: "year",
        }),
      }),
    );
    expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          purchase_source: "discord_summary",
          purchase_tier: "basic",
          purchase_interval: "year",
        }),
        success_url: expect.stringContaining("source=discord_summary"),
        cancel_url: expect.stringContaining("source=discord_summary"),
      }),
      expect.objectContaining({ idempotencyKey: expect.any(String) }),
    );
  });

  it("keeps checkout working under browser opt-out without capturing provider entry", async () => {
    getMockStore().subscriptions.delete(guildId);
    const { stripe, client } = fixture();
    await createCheckoutSession({
      stripe: client,
      user,
      guildId,
      priceId: "price_basic",
      analyticsAllowed: false,
    });
    expect(captureEvent).not.toHaveBeenCalled();
    expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        subscription_data: {
          metadata: expect.objectContaining({ analytics_opt_out: "true" }),
        },
      }),
      expect.objectContaining({ idempotencyKey: expect.any(String) }),
    );
  });

  it("does not count a checkout when the provider returns no URL", async () => {
    getMockStore().subscriptions.delete(guildId);
    const { stripe, client } = fixture();
    stripe.checkout.sessions.create.mockImplementation(async () => ({
      metadata: {
        guild_id: guildId,
        purchase_attempt_id:
          getMockStore().purchaseAttempts.get(guildId)?.attemptId,
      },
      customer: "cus_new",
      livemode: false,
      id: "cs_new",
      status: "open",
      url: "",
    }));
    await expect(
      createCheckoutSession({
        stripe: client,
        user,
        guildId,
        priceId: "price_basic",
      }),
    ).rejects.toMatchObject({ cause: { code: "BAD_REQUEST" } });
    expect(captureEvent).not.toHaveBeenCalled();
  });

  it("does not count a resumed Checkout URL as another created checkout", async () => {
    getMockStore().subscriptions.delete(guildId);
    const { stripe, client } = fixture();
    const request = { stripe: client, user, guildId, priceId: "price_basic" };
    await createCheckoutSession(request);
    const session = await stripe.checkout.sessions.create.mock.results[0].value;
    Object.assign(stripe.checkout.sessions, {
      retrieve: jest.fn(async () => session),
    });
    await expect(createCheckoutSession(request)).resolves.toBe(session.url);
    expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
    expect(captureEvent).toHaveBeenCalledTimes(1);
  });

  it("returns general billing management to the selected server Billing page", async () => {
    const { stripe, client } = fixture();
    config.stripe.basicIntroOffer.portalConfigurationId = "bpc_changes";
    await createPortalSession({ stripe: client, user, guildId });
    expect(stripe.billingPortal.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: "cus_existing",
        configuration: "bpc_changes",
        return_url: new URL(
          `/portal/server/${guildId}/billing`,
          config.frontend.siteUrl,
        ).toString(),
      }),
    );
  });

  it("retains payer-checked general management while transitions are disabled", async () => {
    config.stripe.subscriptionTransitionsEnabled = false;
    const { stripe, client } = fixture();
    await createPortalSession({ stripe: client, user, guildId });
    expect(stripe.customers.retrieve).toHaveBeenCalledWith("cus_existing");
    expect(stripe.billingPortal.sessions.create).toHaveBeenCalledWith(
      expect.not.objectContaining({ flow_data: expect.anything() }),
    );
  });
  it("routes an existing subscription to its server review without creating a hosted update or Checkout", async () => {
    const { stripe, client } = fixture();
    const url = await createCheckoutSession({
      stripe: client,
      user,
      guildId,
      priceId: "price_pro",
      tier: "pro",
      interval: "year",
    });
    const parsed = new URL(url);
    expect(parsed.pathname).toBe(`/portal/server/${guildId}/billing`);
    expect(parsed.searchParams.get("plan")).toBe("pro");
    expect(parsed.searchParams.get("interval")).toBe("year");
    expect(stripe.billingPortal.sessions.create).not.toHaveBeenCalled();
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
    expect(getMockStore().subscriptions.get(guildId)?.tier).toBe("basic");
  });
  it("never falls through to Checkout when a target selection is missing", async () => {
    const { stripe, client } = fixture();
    await expect(
      createCheckoutSession({
        stripe: client,
        user,
        guildId,
        priceId: "price_pro",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it("rejects a subscription belonging to another server", async () => {
    const { subscription, stripe, client } = fixture();
    subscription.metadata.guild_id = "another-server";
    await expect(
      createCheckoutSession({
        stripe: client,
        user,
        guildId,
        priceId: "price_pro",
      }),
    ).rejects.toThrow();
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
    expect(stripe.billingPortal.sessions.create).not.toHaveBeenCalled();
  });

  it("does not let another server manager modify the payer's subscription", async () => {
    const { stripe, client } = fixture();
    await expect(
      createCheckoutSession({
        stripe: client,
        user: { id: "other-manager" },
        guildId,
        priceId: "price_pro",
      }),
    ).rejects.toThrow();
    expect(stripe.billingPortal.sessions.create).not.toHaveBeenCalled();
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it.each(["past_due", "unpaid", "incomplete", "paused"])(
    "does not replace a %s subscription with new Checkout",
    async (status) => {
      const { subscription, stripe, client } = fixture();
      subscription.status = status;
      await expect(
        createCheckoutSession({
          stripe: client,
          user,
          guildId,
          priceId: "price_pro",
        }),
      ).rejects.toThrow();
      expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
    },
  );

  it("keeps first-time purchases on Stripe Checkout", async () => {
    getMockStore().subscriptions.delete(guildId);
    const { stripe, client } = fixture();
    await expect(
      createCheckoutSession({
        stripe: client,
        user,
        guildId,
        priceId: "price_basic",
      }),
    ).resolves.toBe("https://checkout.stripe.com/new");
    expect(stripe.billingPortal.sessions.create).not.toHaveBeenCalled();
  });

  it.each(["canceled", "incomplete_expired"])(
    "allows a new purchase after provider-confirmed %s",
    async (status) => {
      const { subscription, stripe, client } = fixture();
      subscription.status = status;
      await expect(
        createCheckoutSession({
          stripe: client,
          user,
          guildId,
          priceId: "price_pro",
        }),
      ).resolves.toBe("https://checkout.stripe.com/new");
      expect(stripe.billingPortal.sessions.create).not.toHaveBeenCalled();
    },
  );

  it.each(["canceled", "incomplete_expired"])(
    "allows provider-confirmed %s repurchase while plan transitions are disabled",
    async (status) => {
      config.stripe.subscriptionTransitionsEnabled = false;
      const { subscription, stripe, client } = fixture();
      subscription.status = status;
      await expect(
        createCheckoutSession({
          stripe: client,
          user,
          guildId,
          priceId: "price_pro",
        }),
      ).resolves.toBe("https://checkout.stripe.com/new");
      expect(stripe.subscriptions.retrieve).toHaveBeenCalled();
      expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
      expect(stripe.billingPortal.sessions.create).not.toHaveBeenCalled();
    },
  );

  it.each(["unavailable", "wrong_server", "wrong_customer"])(
    "does not repurchase after %s provider evidence with transitions disabled",
    async (evidence) => {
      config.stripe.subscriptionTransitionsEnabled = false;
      const { subscription, stripe, client } = fixture();
      subscription.status = "canceled";
      if (evidence === "unavailable")
        stripe.subscriptions.retrieve.mockRejectedValue(
          new Error("Stripe unavailable"),
        );
      else if (evidence === "wrong_server")
        subscription.metadata.guild_id = "other-server";
      else subscription.customer = "cus_other";
      await expect(
        createCheckoutSession({
          stripe: client,
          user,
          guildId,
          priceId: "price_pro",
        }),
      ).rejects.toThrow();
      expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
      expect(stripe.billingPortal.sessions.create).not.toHaveBeenCalled();
    },
  );

  it("does not silently apply an unreviewed promotion through the old hosted adapter", async () => {
    const { stripe, client } = fixture();
    await expect(
      createCheckoutSession({
        stripe: client,
        user,
        guildId,
        priceId: "price_pro",
        tier: "pro",
        interval: "month",
        promotionCodeId: "promo_upgrade",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
    expect(stripe.billingPortal.sessions.create).not.toHaveBeenCalled();
  });

  it("repeated requests never create a second subscription", async () => {
    const { stripe, client } = fixture();
    await Promise.all(
      [1, 2].map(() =>
        createCheckoutSession({
          stripe: client,
          user,
          guildId,
          priceId: "price_pro",
          tier: "pro",
          interval: "month",
        }),
      ),
    );
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
    expect(stripe.billingPortal.sessions.create).not.toHaveBeenCalled();
  });

  it("fails closed when a stored subscription cannot be retrieved", async () => {
    const { stripe, client } = fixture();
    stripe.subscriptions.retrieve.mockRejectedValue(
      new Error("Stripe unavailable"),
    );
    await expect(
      createCheckoutSession({
        stripe: client,
        user,
        guildId,
        priceId: "price_pro",
      }),
    ).rejects.toThrow("Stripe unavailable");
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it.each([
    { schedule: "sched_1" },
    { pending_update: {} },
    { cancel_at_period_end: true },
    { pause_collection: {} },
  ])("rejects unsupported pending state %j", async (state) => {
    const { subscription, stripe, client } = fixture();
    Object.assign(subscription, state);
    await expect(
      createCheckoutSession({
        stripe: client,
        user,
        guildId,
        priceId: "price_pro",
      }),
    ).rejects.toThrow();
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
    expect(stripe.billingPortal.sessions.create).not.toHaveBeenCalled();
  });

  it("does not expose a payer's general portal to another guild manager", async () => {
    const { stripe, client } = fixture();
    await expect(
      createPortalSession({
        stripe: client,
        user: { id: "other-manager" },
        guildId,
      }),
    ).rejects.toThrow("original payer");
    expect(stripe.billingPortal.sessions.create).not.toHaveBeenCalled();
  });
});
