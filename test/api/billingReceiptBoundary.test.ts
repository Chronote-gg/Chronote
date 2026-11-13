/** @jest-environment node */
import { config } from "../../src/services/configService";
import { resetMockStore, getMockStore } from "../../src/repositories/mockStore";
import { getStripeWebhookRepository } from "../../src/repositories/stripeWebhookRepository";
import {
  continueStripeReceipt,
  receiptBirth,
} from "../../src/services/stripeWebhookReceiptService";
import { persistBillingAcknowledgment } from "../../src/services/runtimeBillingOperationService";
import { randomUUID } from "node:crypto";
import * as runtimeInstanceService from "../../src/services/runtimeInstanceService";
import { getWorkerIdentity } from "../../src/services/runtimeInstanceService";
beforeEach(() => {
  config.mock.enabled = true;
  config.stripe.webhookSecret = "dummy-signature-secret";
  resetMockStore();
  getMockStore().subscriptions.clear();
});
afterEach(() => jest.restoreAllMocks());
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
  await expect(
    continueStripeReceipt(eventId, "token", async () => {
      throw new Error("GET failed");
    }),
  ).rejects.toThrow("GET failed");
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
test("birth and admission record this worker's resolved identity", async () => {
  const { instanceId } = await getWorkerIdentity();
  const worker = {
    kind: "local",
    localId: instanceId,
    instanceId,
    protocolVersion: 1,
  };
  const { repo, eventId } = await claimedReceipt();
  await continueStripeReceipt(eventId, "token", async () => undefined);
  const stored = await repo.get(eventId);
  expect(stored?.state).toBe("completed");
  expect(stored?.firstAdmission?.runtime).toEqual(worker);
  expect(stored?.birth?.writer).toEqual(worker);
});
test("an unresolvable worker identity persists an unproven receipt", async () => {
  jest
    .spyOn(runtimeInstanceService, "getWorkerIdentity")
    .mockRejectedValueOnce(new Error("synthetic metadata outage"));
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
  jest
    .spyOn(repo, "fail")
    .mockRejectedValueOnce(new Error("failure receipt ACK lost"));
  await expect(
    continueStripeReceipt(eventId, "token", async () => {
      throw new Error("GET failed");
    }),
  ).rejects.toThrow("failure receipt ACK lost");
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
  },
);
