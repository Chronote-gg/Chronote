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
      retrieve: retrieve ?? jest.fn(),
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
