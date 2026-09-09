/** @jest-environment node */

import {
  afterAll,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from "@jest/globals";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { registerBillingRoutes } from "../../src/api/billing";
import { getEntitlementGrantRepository } from "../../src/repositories/entitlementGrantRepository";
import { getStripeWebhookRepository } from "../../src/repositories/stripeWebhookRepository";
import { getSubscriptionRepository } from "../../src/repositories/subscriptionRepository";
import { resetMockStore } from "../../src/repositories/mockStore";
import { config } from "../../src/services/configService";
import { createManualEntitlementGrant } from "../../src/services/entitlementService";
import { clearGuildSubscriptionCache } from "../../src/services/subscriptionService";
import type { StripeClient, StripeEvent } from "../../src/types/stripe";

const guildId = "111111111111111111";
const basicPrice = { id: "price_basic", lookup_key: "chronote_basic_monthly" };
const originalStripeConfig = { ...config.stripe };

const createStripe = (event: StripeEvent, retrieve?: jest.Mock) =>
  ({
    webhooks: {
      constructEvent: jest.fn(() => event),
    },
    subscriptions: {
      retrieve:
        retrieve ??
        jest.fn(async () =>
          event.type.startsWith("customer.subscription.")
            ? event.data.object
            : { ...activeStripeSubscription, status: "past_due" },
        ),
    },
  }) as unknown as StripeClient;

const createServer = (stripe: StripeClient) => {
  const app = express();
  app.use("/api/billing/webhook", express.raw({ type: "*/*" }));
  registerBillingRoutes(app, stripe);
  const server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
};

const postWebhook = async (baseUrl: string) =>
  new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
    const req = http.request(
      `${baseUrl}/api/billing/webhook`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "stripe-signature": "sig_test",
        },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          resolve({ statusCode: res.statusCode ?? 0, body });
        });
      },
    );
    req.on("error", reject);
    req.write("{}");
    req.end();
  });

const closeServer = async (server: http.Server) =>
  new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

const subscriptionEvent = (status: string, eventId: string) =>
  ({
    id: eventId,
    type: "customer.subscription.updated",
    data: {
      object: {
        id: "sub_basic",
        status,
        metadata: { guild_id: guildId },
        start_date: 1_767_225_600,
        ended_at: null,
        customer: "cus_basic",
        default_payment_method: "pm_basic",
        livemode: false,
        items: {
          data: [
            {
              price: basicPrice,
              current_period_end: 1_769_904_000,
            },
          ],
        },
      },
    },
  }) as unknown as StripeEvent;

const failedInvoiceEvent = {
  id: "evt_invoice_failed",
  type: "invoice.payment_failed",
  data: {
    object: {
      id: "in_failed",
      created: 1_767_225_600,
      currency: "usd",
      status: "open",
      amount_paid: 0,
      customer: "cus_basic",
      default_payment_method: "pm_basic",
      next_payment_attempt: 1_767_312_000,
      livemode: false,
      discounts: [],
      metadata: {},
      parent: {
        subscription_details: {
          subscription: "sub_basic",
          metadata: { guild_id: guildId },
        },
      },
      lines: {
        data: [
          {
            pricing: {
              price_details: {
                price: basicPrice,
              },
            },
          },
        ],
      },
    },
  },
} as unknown as StripeEvent;

const failedCheckoutEvent = {
  id: "evt_checkout_failed",
  type: "checkout.session.completed",
  data: {
    object: {
      id: "cs_failed",
      subscription: "sub_missing",
      metadata: { guild_id: guildId },
      payment_method_types: ["card"],
      customer: "cus_basic",
    },
  },
} as unknown as StripeEvent;

const checkoutCompletedEvent = {
  id: "evt_checkout_concurrent",
  type: "checkout.session.completed",
  data: {
    object: {
      id: "cs_complete",
      subscription: "sub_basic",
      metadata: { guild_id: guildId },
      payment_method_types: ["card"],
      customer: "cus_basic",
    },
  },
} as unknown as StripeEvent;

const activeStripeSubscription = {
  id: "sub_basic",
  created: 1_767_225_600,
  status: "active",
  metadata: { guild_id: guildId },
  start_date: 1_767_225_600,
  ended_at: null,
  customer: "cus_basic",
  default_payment_method: "pm_basic",
  livemode: false,
  items: {
    data: [
      {
        price: basicPrice,
        current_period_end: 1_769_904_000,
      },
    ],
  },
};

describe("billing webhook routes", () => {
  beforeEach(() => {
    resetMockStore();
    clearGuildSubscriptionCache();
    config.stripe.secretKey = "sk_test_billing";
    config.stripe.webhookSecret = "whsec_test_billing";
  });

  afterAll(() => {
    Object.assign(config.stripe, originalStripeConfig);
  });

  test("reconciles a delayed Basic update to the current Pro subscription", async () => {
    const current = {
      ...activeStripeSubscription,
      items: {
        data: [
          {
            ...activeStripeSubscription.items.data[0],
            price: {
              id: "price_pro",
              lookup_key: "chronote_pro_monthly",
            },
          },
        ],
      },
    };
    const { server, baseUrl } = createServer(
      createStripe(
        subscriptionEvent("active", "evt_old_basic"),
        jest.fn(async () => current),
      ),
    );
    try {
      expect((await postWebhook(baseUrl)).statusCode).toBe(200);
      expect(await getSubscriptionRepository().get(guildId)).toMatchObject({
        tier: "pro",
        status: "active",
        stripeSubscriptionId: "sub_basic",
      });
    } finally {
      await closeServer(server);
    }
  });

  test.each(["customer.subscription.deleted", "invoice.payment_failed"])(
    "ignores %s belonging to an older subscription",
    async (type) => {
      const repo = getSubscriptionRepository();
      await repo.write({
        guildId,
        tier: "pro",
        status: "active",
        startDate: "2026-01-02",
        subscriptionType: "stripe",
        stripeSubscriptionId: "sub_new",
      });
      const event =
        type === "invoice.payment_failed"
          ? failedInvoiceEvent
          : ({
              ...subscriptionEvent("canceled", "evt_old_deleted"),
              type,
            } as StripeEvent);
      const { server, baseUrl } = createServer(
        createStripe(
          event,
          jest.fn(async (id) => ({
            ...activeStripeSubscription,
            id,
            status: id === "sub_new" ? "active" : "canceled",
          })),
        ),
      );
      try {
        expect((await postWebhook(baseUrl)).statusCode).toBe(200);
        expect(await repo.get(guildId)).toMatchObject({
          tier: "pro",
          status: "active",
          stripeSubscriptionId: "sub_new",
        });
      } finally {
        await closeServer(server);
      }
    },
  );

  test("does not mark a recovered subscription past due for a delayed failed invoice", async () => {
    const { server, baseUrl } = createServer(
      createStripe(
        failedInvoiceEvent,
        jest.fn(async () => activeStripeSubscription),
      ),
    );
    try {
      expect((await postWebhook(baseUrl)).statusCode).toBe(200);
      expect(await getSubscriptionRepository().get(guildId)).toMatchObject({
        status: "active",
      });
    } finally {
      await closeServer(server);
    }
  });

  test("refetches after a concurrent webhook commits during a stale Stripe read", async () => {
    let releaseStale!: () => void;
    let signalStarted!: () => void;
    const staleRead = new Promise<void>((resolve) => {
      releaseStale = resolve;
    });
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const pro = {
      ...activeStripeSubscription,
      items: {
        data: [
          {
            ...activeStripeSubscription.items.data[0],
            price: { id: "price_pro", lookup_key: "chronote_pro_monthly" },
          },
        ],
      },
    };
    let reads = 0;
    const retrieve = jest.fn(async () => {
      reads += 1;
      if (reads === 1) {
        signalStarted();
        await staleRead;
        return activeStripeSubscription;
      }
      return pro;
    });
    const first = createServer(
      createStripe(
        { ...checkoutCompletedEvent, id: "evt_concurrent_old" },
        retrieve,
      ),
    );
    const second = createServer(
      createStripe(
        { ...checkoutCompletedEvent, id: "evt_concurrent_new" },
        retrieve,
      ),
    );
    try {
      const pending = postWebhook(first.baseUrl);
      await started;
      expect((await postWebhook(second.baseUrl)).statusCode).toBe(200);
      releaseStale();
      expect((await pending).statusCode).toBe(200);
      expect(await getSubscriptionRepository().get(guildId)).toMatchObject({
        tier: "pro",
        status: "active",
      });
    } finally {
      releaseStale();
      await closeServer(first.server);
      await closeServer(second.server);
    }
  });

  test("accepts a newer subscription after cancellation and ignores the old active event", async () => {
    const repo = getSubscriptionRepository();
    await repo.write({
      guildId,
      tier: "free",
      status: "canceled",
      startDate: "2026-01-01",
      subscriptionType: "stripe",
      stripeSubscriptionId: "sub_old",
    });
    const current = {
      ...activeStripeSubscription,
      created: activeStripeSubscription.created + 100,
    };
    const retrieve = jest.fn(async (id) =>
      id === "sub_old"
        ? {
            ...activeStripeSubscription,
            id,
            status: "canceled",
          }
        : current,
    );
    const first = createServer(
      createStripe(subscriptionEvent("active", "evt_new"), retrieve),
    );
    try {
      expect((await postWebhook(first.baseUrl)).statusCode).toBe(200);
      expect(await repo.get(guildId)).toMatchObject({
        stripeSubscriptionId: "sub_basic",
        status: "active",
      });
    } finally {
      await closeServer(first.server);
    }
    const stale = subscriptionEvent("active", "evt_old_active");
    stale.data.object = {
      ...activeStripeSubscription,
      id: "sub_old",
    } as StripeEvent["data"]["object"];
    const second = createServer(createStripe(stale, retrieve));
    try {
      expect((await postWebhook(second.baseUrl)).statusCode).toBe(200);
      expect(await repo.get(guildId)).toMatchObject({
        stripeSubscriptionId: "sub_basic",
        status: "active",
      });
    } finally {
      await closeServer(second.server);
    }
  });

  test("does not revoke a comp grant for a rejected competing subscription", async () => {
    const repo = getSubscriptionRepository();
    await repo.write({
      guildId,
      tier: "free",
      status: "incomplete",
      startDate: "2026-01-01",
      subscriptionType: "stripe",
      stripeSubscriptionId: "sub_current",
    });
    const grant = await createManualEntitlementGrant({
      guildId,
      tier: "basic",
      createdBy: "admin-1",
    });
    const { server, baseUrl } = createServer(
      createStripe(
        subscriptionEvent("active", "evt_competing"),
        jest.fn(async (id) => ({
          ...activeStripeSubscription,
          id,
          status: id === "sub_current" ? "incomplete" : "active",
        })),
      ),
    );
    try {
      expect((await postWebhook(baseUrl)).statusCode).toBe(200);
      expect(await repo.get(guildId)).toMatchObject({
        stripeSubscriptionId: "sub_current",
      });
      expect(
        (await getEntitlementGrantRepository().get(grant.grantId))?.status,
      ).toBe("active");
    } finally {
      await closeServer(server);
    }
  });

  test("does not resurrect an older duplicate after the current subscription is canceled", async () => {
    const repo = getSubscriptionRepository();
    await repo.write({
      guildId,
      tier: "free",
      status: "canceled",
      startDate: "2026-01-02",
      subscriptionType: "stripe",
      stripeSubscriptionId: "sub_newer",
    });
    const { server, baseUrl } = createServer(
      createStripe(
        subscriptionEvent("active", "evt_older_duplicate"),
        jest.fn(async (id) => ({
          ...activeStripeSubscription,
          id,
          status: id === "sub_newer" ? "canceled" : "active",
          created:
            activeStripeSubscription.created + (id === "sub_newer" ? 100 : 0),
        })),
      ),
    );
    try {
      expect((await postWebhook(baseUrl)).statusCode).toBe(200);
      expect(await repo.get(guildId)).toMatchObject({
        stripeSubscriptionId: "sub_newer",
        status: "canceled",
        tier: "free",
      });
    } finally {
      await closeServer(server);
    }
  });

  test("returns a retryable failure without revoking comp when every conditional write conflicts", async () => {
    const grant = await createManualEntitlementGrant({
      guildId,
      tier: "basic",
      createdBy: "admin-1",
    });
    const compareAndWrite = jest
      .spyOn(getSubscriptionRepository(), "compareAndWrite")
      .mockResolvedValue(false);
    const log = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const { server, baseUrl } = createServer(
      createStripe(subscriptionEvent("active", "evt_conflict")),
    );
    try {
      expect((await postWebhook(baseUrl)).statusCode).toBe(500);
      expect(
        (await getSubscriptionRepository().get(guildId))?.stripeSubscriptionId,
      ).toBeUndefined();
      expect(
        (await getEntitlementGrantRepository().get(grant.grantId))?.status,
      ).toBe("active");
      expect(
        await getStripeWebhookRepository().get("evt_conflict"),
      ).toBeUndefined();
    } finally {
      compareAndWrite.mockRestore();
      log.mockRestore();
      await closeServer(server);
    }
  });

  test("rejects mismatched current Stripe metadata without adopting the subscription", async () => {
    const log = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const { server, baseUrl } = createServer(
      createStripe(
        subscriptionEvent("active", "evt_wrong_guild"),
        jest.fn(async () => ({
          ...activeStripeSubscription,
          metadata: { guild_id: "another-guild" },
        })),
      ),
    );
    try {
      expect((await postWebhook(baseUrl)).statusCode).toBe(500);
      expect(
        (await getSubscriptionRepository().get(guildId))?.stripeSubscriptionId,
      ).toBeUndefined();
      expect(
        await getStripeWebhookRepository().get("evt_wrong_guild"),
      ).toBeUndefined();
    } finally {
      log.mockRestore();
      await closeServer(server);
    }
  });

  test("does not auto-revoke a comp grant from a failed invoice", async () => {
    const grant = await createManualEntitlementGrant({
      guildId,
      tier: "basic",
      createdBy: "admin-1",
    });
    const { server, baseUrl } = createServer(createStripe(failedInvoiceEvent));
    try {
      const response = await postWebhook(baseUrl);

      expect(response.statusCode).toBe(200);
      expect(
        (await getEntitlementGrantRepository().get(grant.grantId))?.status,
      ).toBe("active");
    } finally {
      await closeServer(server);
    }
  });

  test("does not auto-revoke a comp grant from an incomplete subscription", async () => {
    const grant = await createManualEntitlementGrant({
      guildId,
      tier: "basic",
      createdBy: "admin-1",
    });
    const { server, baseUrl } = createServer(
      createStripe(subscriptionEvent("incomplete", "evt_incomplete")),
    );
    try {
      const response = await postWebhook(baseUrl);

      expect(response.statusCode).toBe(200);
      expect(
        (await getEntitlementGrantRepository().get(grant.grantId))?.status,
      ).toBe("active");
    } finally {
      await closeServer(server);
    }
  });

  test("auto-revokes a comp grant from an active same-tier subscription", async () => {
    const grant = await createManualEntitlementGrant({
      guildId,
      tier: "basic",
      createdBy: "admin-1",
    });
    const { server, baseUrl } = createServer(
      createStripe(subscriptionEvent("active", "evt_active")),
    );
    try {
      const response = await postWebhook(baseUrl);

      expect(response.statusCode).toBe(200);
      expect(
        (await getEntitlementGrantRepository().get(grant.grantId))?.status,
      ).toBe("revoked");
      expect(
        await getStripeWebhookRepository().get("evt_active"),
      ).toBeDefined();
    } finally {
      await closeServer(server);
    }
  });

  test("claims duplicate webhooks before running handler side effects", async () => {
    const grant = await createManualEntitlementGrant({
      guildId,
      tier: "basic",
      createdBy: "admin-1",
    });
    const retrieve = jest.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return activeStripeSubscription;
    });
    const { server, baseUrl } = createServer(
      createStripe(checkoutCompletedEvent, retrieve),
    );
    try {
      const responses = await Promise.all([
        postWebhook(baseUrl),
        postWebhook(baseUrl),
      ]);

      expect(responses.map((response) => response.statusCode)).toEqual([
        200, 200,
      ]);
      expect(retrieve).toHaveBeenCalledTimes(1);
      expect(
        (await getEntitlementGrantRepository().get(grant.grantId))?.status,
      ).toBe("revoked");
      expect(
        await getStripeWebhookRepository().get("evt_checkout_concurrent"),
      ).toBeDefined();
    } finally {
      await closeServer(server);
    }
  });

  test("does not record webhook idempotency before a failed handler completes", async () => {
    const retrieve = jest.fn(async () => {
      throw new Error("subscription lookup failed");
    });
    const consoleError = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const { server, baseUrl } = createServer(
      createStripe(failedCheckoutEvent, retrieve),
    );
    try {
      const response = await postWebhook(baseUrl);

      expect(response.statusCode).toBe(500);
      expect(
        await getStripeWebhookRepository().get("evt_checkout_failed"),
      ).toBeUndefined();
    } finally {
      consoleError.mockRestore();
      await closeServer(server);
    }
  });
});
