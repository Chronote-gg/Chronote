/** @jest-environment node */
import {
  afterAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { config } from "../../src/services/configService";
import {
  createCheckoutSession,
  createPortalSession,
  ensureStripeCustomer,
} from "../../src/services/billingService";
import { getMockStore, resetMockStore } from "../../src/repositories/mockStore";
import type { StripeClient } from "../../src/types/stripe";

const guildId = "111111111111111111";
const user = { id: "payer", email: "payer@example.test" };
const originalTransitionsEnabled = config.stripe.subscriptionTransitionsEnabled;
afterAll(() => {
  config.stripe.subscriptionTransitionsEnabled = originalTransitionsEnabled;
});

function fixture() {
  const subscription = {
    id: "sub_existing",
    status: "active",
    customer: "cus_existing",
    metadata: { guild_id: guildId, discord_id: user.id },
    items: {
      data: [{ id: "si_existing", quantity: 1, price: { id: "price_basic" } }],
    },
  };
  const stripe = {
    subscriptions: { retrieve: jest.fn(async () => subscription) },
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
          url: "https://checkout.stripe.com/new",
        })),
      },
    },
    billingPortal: {
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
  it("blocks an existing subscription before any provider call when activation is disabled", async () => {
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
    expect(stripe.subscriptions.retrieve).not.toHaveBeenCalled();
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
      }),
    ).resolves.toBe("https://checkout.stripe.com/new");
    expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
    expect(stripe.billingPortal.sessions.create).not.toHaveBeenCalled();
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
  it("does not reuse an email-matched customer owned by another Discord account", async () => {
    const { stripe, client } = fixture();
    stripe.customers.list.mockResolvedValue({
      data: [{ id: "cus_other", metadata: { discord_id: "someone-else" } }],
    });
    await expect(ensureStripeCustomer(client, user)).resolves.toBe("cus_new");
  });
  it("finds the payer on a later email-match page without creating another customer", async () => {
    const { stripe, client } = fixture();
    stripe.customers.list
      .mockResolvedValueOnce({
        data: [{ id: "cus_other", metadata: { discord_id: "other" } }],
        has_more: true,
      })
      .mockResolvedValueOnce({
        data: [{ id: "cus_owned", metadata: { discord_id: user.id } }],
        has_more: false,
      });
    await expect(ensureStripeCustomer(client, user)).resolves.toBe("cus_owned");
    expect(stripe.customers.list).toHaveBeenLastCalledWith({
      email: user.email,
      limit: 100,
      starting_after: "cus_other",
    });
    expect(stripe.customers.create).not.toHaveBeenCalled();
  });
  it("confirms a price change on the existing item without creating another subscription", async () => {
    const { stripe, client } = fixture();
    await expect(
      createCheckoutSession({
        stripe: client,
        user,
        guildId,
        priceId: "price_pro",
        tier: "pro",
      }),
    ).resolves.toBe("https://billing.stripe.com/confirm");
    expect(stripe.billingPortal.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: "cus_existing",
        flow_data: expect.objectContaining({
          type: "subscription_update_confirm",
          subscription_update_confirm: {
            subscription: "sub_existing",
            items: [{ id: "si_existing", price: "price_pro", quantity: 1 }],
          },
        }),
      }),
    );
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
    expect(stripe.customers.create).not.toHaveBeenCalled();
    expect(getMockStore().subscriptions.get(guildId)?.tier).toBe("basic");
  });

  it("does not fall back to a new subscription when Stripe cannot create the confirmation", async () => {
    const { stripe, client } = fixture();
    stripe.billingPortal.sessions.create.mockRejectedValue(
      new Error("Portal configuration unavailable"),
    );
    await expect(
      createCheckoutSession({
        stripe: client,
        user,
        guildId,
        priceId: "price_pro",
      }),
    ).rejects.toThrow("Portal configuration unavailable");
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

  it("preserves a requested promotion in the confirmation flow", async () => {
    const { stripe, client } = fixture();
    await createCheckoutSession({
      stripe: client,
      user,
      guildId,
      priceId: "price_pro",
      promotionCodeId: "promo_upgrade",
    });
    expect(stripe.billingPortal.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        flow_data: expect.objectContaining({
          subscription_update_confirm: expect.objectContaining({
            discounts: [{ promotion_code: "promo_upgrade" }],
          }),
        }),
      }),
    );
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
        }),
      ),
    );
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
    expect(stripe.billingPortal.sessions.create).toHaveBeenCalledTimes(2);
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
