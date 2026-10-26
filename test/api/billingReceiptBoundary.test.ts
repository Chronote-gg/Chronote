/** @jest-environment node */
import { seedBillingRuntime } from "../fixtures/billingRuntime";
import { introductionFixture } from "../fixtures/productionIntroduction";
import { control } from "../deployment/controlFixtures";
import {
  createServer,
  postWebhook,
  closeServer,
} from "../fixtures/billingWebhook";
import { stripeTransport } from "../fixtures/stripeTransport";
import { config } from "../../src/services/configService";
import { resetMockStore, getMockStore } from "../../src/repositories/mockStore";
import { getStripeWebhookRepository } from "../../src/repositories/stripeWebhookRepository";
import {
  continueStripeReceipt,
  receiptBirth,
} from "../../src/services/stripeWebhookReceiptService";
import { persistBillingAcknowledgment } from "../../src/services/runtimeBillingOperationService";
import { getRuntimeWorkAdmissionCheckpoints } from "../../src/services/runtimeWorkAdmissionService";
import type { StripeEvent } from "../../src/types/stripe";
import { randomUUID } from "node:crypto";
const held = { holdId: "hold", introductionId: "introduction", revision: 1 };
beforeEach(() => {
  config.mock.enabled = true;
  config.stripe.webhookSecret = "dummy-signature-secret";
  resetMockStore();
  seedBillingRuntime();
  getMockStore().subscriptions.clear();
});
afterEach(() => jest.restoreAllMocks());
const event = (type: string): StripeEvent =>
  ({
    id: randomUUID(),
    type,
    data: {
      object: {
        id: "fixture",
        metadata: { guild_id: "guild", purchase_attempt_id: "purchase" },
        subscription: "subscription",
        parent: { subscription_details: { subscription: "subscription" } },
      },
    },
  }) as unknown as StripeEvent;
test.each([
  "checkout.session.expired",
  "checkout.session.completed",
  "invoice.payment_failed",
  "invoice.payment_succeeded",
  "invoice.paid",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
])(
  "held %s persists raw receipt and never invokes the handler",
  async (type) => {
    const provider = jest.fn(() => {
      throw new Error("Prohibited provider request");
    });
    const { stripe } = stripeTransport(provider);
    const incoming = event(type);
    jest.spyOn(stripe.webhooks, "constructEvent").mockReturnValue(incoming);
    getMockStore().deploymentControlRecords.set(
      JSON.stringify(["ENV", "CONTROL"]),
      { ...control, maintenance: held },
    );
    getMockStore().deploymentControlRecords.set(
      JSON.stringify(["ENV", "INTRODUCTION"]),
      introductionFixture(held),
    );
    const { server, baseUrl } = createServer(stripe);
    try {
      expect((await postWebhook(baseUrl)).statusCode).toBe(503);
      expect(provider).not.toHaveBeenCalled();
      expect(getMockStore().paymentTransactions.size).toBe(0);
      expect(getMockStore().subscriptions.size).toBe(0);
      expect(getMockStore().purchaseAttempts.size).toBe(0);
      expect(getMockStore().renewalRecoveryRecords.size).toBe(0);
      const receipt = await getStripeWebhookRepository().get(incoming.id);
      expect(receipt).toMatchObject({ state: "processing" });
      expect(receipt?.birth?.hold).toEqual(held);
      expect(receipt?.continuation).toBe("not_admitted");
      expect(receipt?.firstAdmission).toBeUndefined();
      expect(receipt?.expiresAt).toBeUndefined();
    } finally {
      await closeServer(server);
    }
  },
);
async function claimedReceipt() {
  const repo = getStripeWebhookRepository();
  const eventId = randomUUID();
  await repo.claim({
    eventId,
    receivedAt: "synthetic",
    leaseToken: "token",
    leaseUntil: Date.now() + 60000,
    state: "processing",
    birth: await receiptBirth(),
    continuation: "not_admitted",
  });
  return { repo, eventId };
}
test("prewrite provider read failure retries under fresh admission and preserves first admission", async () => {
  const { repo, eventId } = await claimedReceipt();
  const before = getRuntimeWorkAdmissionCheckpoints().length;
  await expect(
    continueStripeReceipt(eventId, "token", async () => {
      throw new Error("GET failed");
    }),
  ).rejects.toThrow("GET failed");
  expect(getRuntimeWorkAdmissionCheckpoints()).toHaveLength(before);
  const failed = (await repo.get(eventId))!;
  expect(failed.admission?.status).toBe("failed");
  await repo.claim({
    ...failed,
    leaseToken: "next",
    leaseUntil: Date.now() + 60000,
  });
  const handler = jest.fn(async () => undefined);
  await continueStripeReceipt(eventId, "next", handler);
  expect(handler).toHaveBeenCalledTimes(1);
  expect((await repo.get(eventId))?.firstAdmission).toEqual(
    failed.firstAdmission,
  );
  expect((await repo.get(eventId))?.state).toBe("completed");
});
test.each([
  "unknown domain ACK",
  "failure after domain ACK",
  "readback-only domain ACK",
  "finish ACK lost",
])("%s retains admission and prevents replay", async (stage) => {
  const { repo, eventId } = await claimedReceipt();
  const before = getRuntimeWorkAdmissionCheckpoints().length;
  const finish =
    stage === "finish ACK lost"
      ? jest.spyOn(repo, "finish").mockRejectedValue(new Error(stage))
      : undefined;
  let writes = 0;
  await expect(
    continueStripeReceipt(eventId, "token", async (owner) => {
      const write = async () => {
        writes++;
        if (stage === "unknown domain ACK") throw new Error(stage);
      };
      if (stage === "readback-only domain ACK") {
        await repo.get(eventId);
        await persistBillingAcknowledgment(owner, write);
        throw new Error(stage);
      }
      await owner.effect(write);
      if (stage === "failure after domain ACK") throw new Error(stage);
    }),
  ).rejects.toThrow(stage);
  finish?.mockRestore();
  expect(getRuntimeWorkAdmissionCheckpoints()).toHaveLength(before + 1);
  const receipt = getMockStore().stripeWebhookEvents.get(eventId)!;
  expect(receipt.admission?.status).toBe("running");
  expect(receipt.expiresAt).toBeUndefined();
  receipt.leaseUntil = 0;
  await repo.claim({
    ...receipt,
    leaseToken: "next",
    leaseUntil: Date.now() + 60000,
  });
  const replay = jest.fn();
  await expect(
    continueStripeReceipt(eventId, "next", replay),
  ).rejects.toThrow();
  expect(replay).not.toHaveBeenCalled();
  expect(writes).toBe(1);
});
test("missing runtime proof persists an unproven receipt", async () => {
  getMockStore().deploymentControlRecords.clear();
  const { repo, eventId } = await claimedReceipt();
  const handler = jest.fn();
  await expect(
    continueStripeReceipt(eventId, "token", handler),
  ).rejects.toThrow("unproven");
  expect(handler).not.toHaveBeenCalled();
  expect((await repo.get(eventId))?.birth).toBeUndefined();
});

test("lost failed-attempt receipt ACK stays unresolved after a prewrite read failure", async () => {
  const { repo, eventId } = await claimedReceipt();
  const before = getRuntimeWorkAdmissionCheckpoints().length;
  jest
    .spyOn(repo, "fail")
    .mockRejectedValueOnce(new Error("failure receipt ACK lost"));
  await expect(
    continueStripeReceipt(eventId, "token", async () => {
      throw new Error("GET failed");
    }),
  ).rejects.toThrow("failure receipt ACK lost");
  expect(getRuntimeWorkAdmissionCheckpoints()).toHaveLength(before + 1);
  expect((await repo.get(eventId))?.admission?.status).toBe("running");
});

test.each([
  ["effect", "acknowledged"],
  ["effect", "unknown"],
  ["effect", "no-write"],
  ["persistence", "acknowledged"],
  ["persistence", "unknown"],
  ["persistence", "no-write"],
])(
  "failed callback drains detached %s with %s outcome before classifying the receipt",
  async (mechanism, outcome) => {
    const { repo, eventId } = await claimedReceipt();
    const before = getRuntimeWorkAdmissionCheckpoints().length;
    await expect(
      continueStripeReceipt(eventId, "token", async (owner) => {
        const write = async () => {
          await Promise.resolve();
          if (outcome === "unknown") throw new Error("tail ACK lost");
          return outcome !== "no-write";
        };
        const pending =
          mechanism === "effect"
            ? owner.effect(write)
            : persistBillingAcknowledgment(owner, write);
        void pending.catch(() => undefined);
        throw new Error("callback failed");
      }),
    ).rejects.toThrow();
    const retryable = mechanism === "effect" && outcome === "no-write";
    expect((await repo.get(eventId))?.admission?.status).toBe(
      retryable ? "failed" : "running",
    );
    expect(getRuntimeWorkAdmissionCheckpoints()).toHaveLength(
      before + (retryable ? 0 : 1),
    );
  },
);
