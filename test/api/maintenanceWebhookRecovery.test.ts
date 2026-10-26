/** @jest-environment node */
import Stripe from "stripe";
import * as renewalRecoveryService from "../../src/services/renewalRecoveryService";
import { config } from "../../src/services/configService";
import { getMockStore, resetMockStore } from "../../src/repositories/mockStore";
import { clearGuildSubscriptionCache } from "../../src/services/subscriptionService";
import {
  createServer,
  postWebhook,
  closeServer,
  guildId,
  activeStripeSubscription,
  subscriptionEvent,
} from "../fixtures/billingWebhook";
jest.mock("../../src/services/analyticsService", () => ({
  captureEvent: jest.fn(),
}));
const previous = { ...config.stripe };
const previousMock = config.mock.enabled;
const secret = "whsec_synthetic_local_recovery";
const providerTransport = jest.fn(async () => {
  throw new Error("Provider transport forbidden in local fixtures");
});
const stripe = new Stripe("sk_test_local_no_provider_calls", {
  httpClient: Stripe.createFetchHttpClient(providerTransport),
  maxNetworkRetries: 0,
});
let available = true;
beforeEach(() => {
  providerTransport.mockClear();
  resetMockStore();
  clearGuildSubscriptionCache();
  config.mock.enabled = true;
  Object.assign(config.stripe, {
    secretKey: "sk_test_local",
    webhookSecret: secret,
    subscriptionTransitionsEnabled: false,
    renewalGraceEnabled: false,
    introOfferLedgerEnabled: false,
    renewalReactivationEnabled: false,
  });
  getMockStore().subscriptions.clear();
  getMockStore().paymentTransactions.clear();
  getMockStore().stripeWebhookEvents.clear();
  available = true;
  jest
    .spyOn(renewalRecoveryService, "trackPaidRenewalPeriod")
    .mockResolvedValue();
  Object.assign(stripe.subscriptions, {
    retrieve: async () => {
      if (!available) throw new Error("synthetic service unavailable");
      return activeStripeSubscription;
    },
  });
  Object.assign(stripe.invoices, {
    retrieve: async () => invoiceEvent("evt_provider_snapshot").data.object,
  });
  Object.assign(stripe.prices, {
    retrieve: async () => ({
      ...activeStripeSubscription.items.data[0].price,
      recurring: { interval: "month" },
    }),
  });
});
afterEach(() => {
  expect(providerTransport).not.toHaveBeenCalled();
  jest.restoreAllMocks();
});
afterAll(() => {
  Object.assign(config.stripe, previous);
  config.mock.enabled = previousMock;
});
function signed(event: unknown) {
  const payload = JSON.stringify(event);
  return {
    payload,
    signature: stripe.webhooks.generateTestHeaderString({ payload, secret }),
  };
}
function invoiceEvent(id: string, type = "invoice.payment_succeeded") {
  return {
    id,
    type,
    data: {
      object: {
        id: "in_recovery",
        created: 1_767_225_600,
        amount_paid: type === "invoice.payment_failed" ? 0 : 1000,
        currency: "usd",
        status: type === "invoice.payment_failed" ? "open" : "paid",
        customer: "cus_basic",
        livemode: false,
        discounts: [],
        metadata: { guild_id: guildId },
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
                  price: activeStripeSubscription.items.data[0].price,
                },
              },
            },
          ],
        },
      },
    },
  };
}
test("unavailable endpoint returns non2xx and does not claim the signed delivery", async () => {
  const { server, baseUrl } = createServer(null);
  const request = signed(subscriptionEvent("active", "evt_unavailable"));
  try {
    expect(
      (await postWebhook(baseUrl, request.payload, request.signature))
        .statusCode,
    ).toBe(500);
    expect(getMockStore().stripeWebhookEvents.size).toBe(0);
  } finally {
    await closeServer(server);
  }
});
test("real SDK signature rejects a changed body before any durable effect", async () => {
  const { server, baseUrl } = createServer(stripe);
  const request = signed(invoiceEvent("evt_tampered"));
  const errors = jest
    .spyOn(console, "error")
    .mockImplementation(() => undefined);
  try {
    expect(
      (await postWebhook(baseUrl, request.payload + " ", request.signature))
        .statusCode,
    ).toBe(400);
    expect(getMockStore().stripeWebhookEvents.size).toBe(0);
    expect(getMockStore().paymentTransactions.size).toBe(0);
  } finally {
    errors.mockRestore();
    await closeServer(server);
  }
});
test("same signed delivery recovers once, duplicates and old failures preserve its original transaction and entitlement", async () => {
  const { server, baseUrl } = createServer(stripe);
  const request = signed(invoiceEvent("evt_recovery"));
  const errors = jest
    .spyOn(console, "error")
    .mockImplementation(() => undefined);
  try {
    available = false;
    expect(
      (await postWebhook(baseUrl, request.payload, request.signature))
        .statusCode,
    ).toBe(500);
    expect(
      getMockStore().stripeWebhookEvents.get("evt_recovery"),
    ).toBeUndefined();
    expect(getMockStore().paymentTransactions.size).toBe(1);
    const originalTransaction = {
      ...getMockStore().paymentTransactions.get("in_recovery"),
    };
    available = true;
    const recovered = await postWebhook(
      baseUrl,
      request.payload,
      request.signature,
    );
    expect(recovered.statusCode).toBe(200);
    const transaction = {
      ...getMockStore().paymentTransactions.get("in_recovery"),
    };
    expect(transaction).toEqual(originalTransaction);
    expect(transaction).toMatchObject({
      subscriptionID: "sub_basic",
      amount: 10,
    });
    expect(getMockStore().stripeWebhookEvents.get("evt_recovery")?.state).toBe(
      "completed",
    );
    expect(
      (await postWebhook(baseUrl, request.payload, request.signature))
        .statusCode,
    ).toBe(200);
    const delayed = signed(
      invoiceEvent("evt_delayed_failure", "invoice.payment_failed"),
    );
    expect(
      (await postWebhook(baseUrl, delayed.payload, delayed.signature))
        .statusCode,
    ).toBe(200);
    const old = signed(subscriptionEvent("past_due", "evt_old_subscription"));
    expect(
      (await postWebhook(baseUrl, old.payload, old.signature)).statusCode,
    ).toBe(200);
    expect(getMockStore().paymentTransactions.size).toBe(1);
    expect(getMockStore().paymentTransactions.get("in_recovery")).toEqual(
      transaction,
    );
    expect(getMockStore().subscriptions.get(guildId)).toMatchObject({
      tier: "basic",
      status: "active",
      stripeSubscriptionId: "sub_basic",
    });
    for (const id of [
      "evt_recovery",
      "evt_delayed_failure",
      "evt_old_subscription",
    ])
      expect(getMockStore().stripeWebhookEvents.get(id)?.state).toBe(
        "completed",
      );
  } finally {
    errors.mockRestore();
    await closeServer(server);
  }
});
