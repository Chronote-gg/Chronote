/** @jest-environment node */
import Stripe from "stripe";
import { ECSClient } from "@aws-sdk/client-ecs";
import {
  registerHistoryWriterBoundary,
  invalidateHistoryWriterBoundary,
} from "../../src/services/historyWriterBoundaryService";
import { getMockStore, resetMockStore } from "../../src/repositories/mockStore";
import { historyWriterBoundaryFixture } from "../fixtures/historyWriterBoundary";
import type { PurchaseAttempt } from "../../src/types/purchase";
function fixture() {
  const b = historyWriterBoundaryFixture();
  const d = b.deployment;
  const sample: PurchaseAttempt = {
    ...b.sample,
    guildId: b.sample.guildId,
    payerId: "payer",
    mode: "test",
    fingerprint: "f",
    createdAt: 100,
    state: "completed",
    customerId: "cus",
    subscriptionId: "sub",
    initialInvoiceId: "in",
    checkout: { line_items: [{ price: "price", quantity: 1 }] },
    writerWitness: {
      writerVersion: "offer-ledger-v1",
      taskArn: d.taskArns[0],
      imageDigest: d.imageDigest,
      invoiceId: "in",
    },
  };
  getMockStore().purchaseAttempts.set(sample.guildId, sample);
  const stripe = new Stripe("sk_test_unused");
  jest
    .spyOn(stripe.accounts, "retrieve")
    .mockResolvedValue({ id: b.accountId } as never);
  jest
    .spyOn(stripe.balance, "retrieve")
    .mockResolvedValue({ livemode: false } as never);
  jest.spyOn(stripe.subscriptions, "retrieve").mockResolvedValue({
    id: "sub",
    customer: "cus",
    livemode: false,
  } as never);
  const invoice = {
    id: "in",
    customer: "cus",
    livemode: false,
    status: "paid",
    amount_remaining: 0,
    billing_reason: "subscription_create",
    parent: {
      subscription_details: {
        subscription: "sub",
        metadata: {
          guild_id: sample.guildId,
          purchase_attempt_id: sample.attemptId,
          discord_id: "payer",
        },
      },
    },
    lines: {
      has_more: false,
      data: [
        {
          quantity: 1,
          pricing: { price_details: { price: "price" } },
          parent: {
            subscription_item_details: {
              subscription: "sub",
              proration: false,
            },
          },
        },
      ],
    },
  };
  const retrieve = jest
    .spyOn(stripe.invoices, "retrieve")
    .mockResolvedValue(invoice as never);
  const ecs = new ECSClient({ region: "us-east-1" });
  const service = {
    serviceArn: d.serviceArn,
    serviceName: "api",
    clusterArn: d.clusterArn,
    status: "ACTIVE",
    taskDefinition: d.taskDefinitionArn,
    desiredCount: 1,
    runningCount: 1,
    pendingCount: 0,
    deployments: [
      {
        status: "PRIMARY",
        taskDefinition: d.taskDefinitionArn,
        rolloutState: "COMPLETED",
      },
    ],
  };
  const send = jest
    .spyOn(ecs, "send")
    .mockResolvedValueOnce({ services: [service] } as never)
    .mockResolvedValueOnce({ taskArns: d.taskArns } as never)
    .mockResolvedValueOnce({
      tasks: [
        {
          taskArn: d.taskArns[0],
          clusterArn: d.clusterArn,
          lastStatus: "RUNNING",
          desiredStatus: "RUNNING",
          taskDefinitionArn: d.taskDefinitionArn,
          containers: [
            { name: "api", imageDigest: d.imageDigest, lastStatus: "RUNNING" },
          ],
        },
      ],
    } as never)
    .mockResolvedValueOnce({ services: [service] } as never);
  const { clusterArn, serviceArn, containerName, imageDigest } = d;
  return {
    stripe,
    ecs,
    sample,
    retrieve,
    send,
    input: {
      stripe,
      ecs,
      accountId: b.accountId,
      mode: b.mode,
      sampleGuildId: sample.guildId,
      target: { clusterArn, serviceArn, containerName, imageDigest },
    },
  };
}
beforeEach(() => resetMockStore());
afterEach(() => jest.restoreAllMocks());
test("genuine full witness registers only after native financial and ECS verification, defaulting to dry-run", async () => {
  const f = fixture();
  const result = await registerHistoryWriterBoundary(f.input);
  expect(result.kind).toBe("dry_run");
  expect(f.send).toHaveBeenCalledTimes(4);
  expect(result.boundary.sample).toEqual({
    guildId: f.sample.guildId,
    attemptId: f.sample.attemptId,
    revision: f.sample.revision,
  });
  expect(getMockStore().historyWriterBoundaries.size).toBe(0);
  expect(getMockStore().purchaseAttempts.get(f.sample.guildId)).toEqual(
    f.sample,
  );
});
test("registration and revision-scoped invalidation preserve the paid purchase", async () => {
  const f = fixture();
  const result = await registerHistoryWriterBoundary({
    ...f.input,
    apply: true,
  });
  const input = {
    accountId: f.input.accountId,
    mode: f.input.mode,
    expectedRevision: result.boundary.revision,
  };
  expect(await invalidateHistoryWriterBoundary(input)).toBe("dry_run");
  expect(getMockStore().historyWriterBoundaries.size).toBe(1);
  await expect(
    invalidateHistoryWriterBoundary({
      ...input,
      expectedRevision: "stale",
      apply: true,
    }),
  ).rejects.toThrow("revision changed");
  expect(await invalidateHistoryWriterBoundary({ ...input, apply: true })).toBe(
    "applied",
  );
  expect(getMockStore().historyWriterBoundaries.size).toBe(0);
  expect(getMockStore().purchaseAttempts.get(f.sample.guildId)).toEqual(
    f.sample,
  );
});
test("sample replacement between verification and publication prevents registration", async () => {
  const f = fixture();
  const module =
    await import("../../src/repositories/historyWriterBoundaryRepository");
  const real = module.getHistoryWriterBoundaryRepository();
  jest.spyOn(module, "getHistoryWriterBoundaryRepository").mockReturnValue({
    ...real,
    compareAndWrite: async (...args) => {
      getMockStore().purchaseAttempts.set(f.sample.guildId, {
        ...f.sample,
        revision: "replaced",
      });
      return real.compareAndWrite(...args);
    },
  });
  await expect(
    registerHistoryWriterBoundary({ ...f.input, apply: true }),
  ).rejects.toThrow();
  expect(getMockStore().historyWriterBoundaries.size).toBe(0);
});
test("foreign financial evidence cannot reach deployment verification", async () => {
  const f = fixture();
  f.retrieve.mockResolvedValueOnce({
    id: "different",
    status: "paid",
  } as never);
  await expect(
    registerHistoryWriterBoundary({ ...f.input, apply: true }),
  ).rejects.toThrow("financial scope");
  expect(f.send).not.toHaveBeenCalled();
  expect(getMockStore().historyWriterBoundaries.size).toBe(0);
});
