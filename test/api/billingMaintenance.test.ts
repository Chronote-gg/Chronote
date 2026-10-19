/** @jest-environment node */
import { seedBillingRuntime } from "../fixtures/billingRuntime";
import {
  createServer,
  postWebhook,
  closeServer,
} from "../fixtures/billingWebhook";
import { config } from "../../src/services/configService";
import { getMockStore, resetMockStore } from "../../src/repositories/mockStore";
import { getStripeWebhookRepository } from "../../src/repositories/stripeWebhookRepository";
import { clearGuildSubscriptionCache } from "../../src/services/subscriptionService";
import type { StripeEvent, StripeClient } from "../../src/types/stripe";
const originalStripeConfig = { ...config.stripe };
const guildId = "111111111111111111";
function createStripe(event: StripeEvent): StripeClient {
  return {
    webhooks: { constructEvent: () => event },
  } as unknown as StripeClient;
}

describe("maintenance billing continuation receipts", () => {
  beforeEach(() => {
    resetMockStore();
    seedBillingRuntime();
    clearGuildSubscriptionCache();
    Object.assign(config.stripe, {
      secretKey: "sk_test_billing",
      webhookSecret: "whsec_test_billing",
    });
  });
  afterAll(() => Object.assign(config.stripe, originalStripeConfig));
  test("partial payment projection remains unresolved after lease expiry and same-event retry", async () => {
    const { RuntimeAdmissionUnavailable } =
      await import("../../src/services/runtimeAdmissionError");
    const changes = await import("../../src/services/billingChangeService");
    const resume = jest
      .spyOn(changes, "reconcileBillingChangeForWebhook")
      .mockRejectedValue(new RuntimeAdmissionUnavailable("maintenance"));
    const event = {
      id: "evt_maintenance_retained",
      type: "invoice.payment_succeeded",
      data: {
        object: {
          id: "in_paid",
          created: 1767225600,
          currency: "usd",
          customer: "cus_basic",
          discounts: [],
          status: "paid",
          amount_paid: 900,
          metadata: { guild_id: guildId, chronote_invoice_role: "funding" },
        },
      },
    } as StripeEvent;
    const { server, baseUrl } = createServer(createStripe(event));
    const finish = jest.spyOn(getStripeWebhookRepository(), "finish");
    try {
      expect((await postWebhook(baseUrl)).statusCode).toBe(500);
      const receipt = structuredClone(
        await getStripeWebhookRepository().get(event.id),
      );
      expect(receipt).toMatchObject({
        state: "processing",
        admission: { status: "running" },
      });
      expect(finish).not.toHaveBeenCalled();
      const payment = structuredClone(getMockStore().paymentTransactions);
      expect(payment.size).toBe(1);
      expect((await postWebhook(baseUrl)).statusCode).toBe(503);
      expect(await getStripeWebhookRepository().get(event.id)).toEqual(receipt);
      expect(getMockStore().paymentTransactions).toEqual(payment);
      expect(resume).toHaveBeenCalledTimes(1);
      resume.mockResolvedValue();
      const now = jest
        .spyOn(Date, "now")
        .mockReturnValue(receipt!.leaseUntil! + 1);
      try {
        expect((await postWebhook(baseUrl)).statusCode).toBe(503);
        expect((await getStripeWebhookRepository().get(event.id))?.state).toBe(
          "processing",
        );
        expect(finish).not.toHaveBeenCalled();
        expect(resume).toHaveBeenCalledTimes(1);
        expect(getMockStore().paymentTransactions).toEqual(payment);
        expect(
          (await getStripeWebhookRepository().get(event.id))?.firstAdmission,
        ).toEqual(receipt?.firstAdmission);
      } finally {
        now.mockRestore();
      }
    } finally {
      finish.mockRestore();
      resume.mockRestore();
      await closeServer(server);
    }
  });
});
