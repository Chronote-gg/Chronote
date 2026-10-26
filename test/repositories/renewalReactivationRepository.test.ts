/** @jest-environment node */
import type { RenewalOperation } from "../../src/types/renewal";

import {
  beforeEach,
  afterEach,
  afterAll,
  describe,
  it,
  expect,
  jest,
} from "@jest/globals";
import {
  DynamoDBClient,
  TransactWriteItemsCommand,
  GetItemCommand,
  TransactionCanceledException,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";

import { getRenewalReactivationRepository } from "../../src/repositories/renewalReactivationRepository";
import { config } from "../../src/services/configService";
import { getMockStore, resetMockStore } from "../../src/repositories/mockStore";
import {
  renewalGuildId,
  renewalOperation,
  renewalSubscription,
} from "../fixtures/renewal";
const originalMock = config.mock.enabled;
beforeEach(() => {
  config.mock.enabled = true;
  resetMockStore();
  getMockStore().subscriptions.set(
    renewalGuildId,
    structuredClone(renewalSubscription),
  );
});
afterEach(() => {
  config.mock.enabled = originalMock;
});
it("allows one concurrent operation for a server without changing purchase or offer rows", async () => {
  const repo = getRenewalReactivationRepository();
  const store = getMockStore();
  const before = structuredClone({
    purchases: store.purchaseAttempts,
    offers: store.offerUsages,
    subscriptions: store.subscriptions,
  });
  const results = await Promise.all([
    repo.claim({
      operation: renewalOperation,
      expectedSubscription: renewalSubscription,
    }),
    repo.claim({
      operation: {
        ...renewalOperation,
        operationId: "00000000-0000-4000-8000-000000000002",
        quoteNonce: "00000000-0000-4000-8000-000000000002",
      },
      expectedSubscription: renewalSubscription,
    }),
  ]);
  expect(results).toEqual([true, false]);
  expect(store.purchaseAttempts).toEqual(before.purchases);
  expect(store.offerUsages).toEqual(before.offers);
  expect(store.subscriptions).toEqual(before.subscriptions);
  const persisted = await repo.getOperation({
    guildId: renewalGuildId,
    operationId: renewalOperation.operationId,
  });
  expect(persisted).toEqual(renewalOperation);
  expect(await repo.getControl({ guildId: renewalGuildId })).toMatchObject({
    operationId: renewalOperation.operationId,
  });
});
it("rejects a changed source and allows another server independently", async () => {
  const repo = getRenewalReactivationRepository();
  expect(
    await repo.claim({
      operation: renewalOperation,
      expectedSubscription: {
        ...renewalSubscription,
        stripeSyncRevision: "stale",
      },
    }),
  ).toBe(false);
  const other = "333333333333333333";
  getMockStore().subscriptions.set(other, {
    ...renewalSubscription,
    guildId: other,
  });
  expect(
    await repo.claim({
      operation: renewalOperation,
      expectedSubscription: renewalSubscription,
    }),
  ).toBe(true);
  expect(
    await repo.claim({
      operation: { ...renewalOperation, guildId: other },
      expectedSubscription: { ...renewalSubscription, guildId: other },
    }),
  ).toBe(true);
});
it("keeps unresolved control, fences revisions, and releases only on verified terminal result", async () => {
  const repo = getRenewalReactivationRepository();
  await repo.claim({
    operation: renewalOperation,
    expectedSubscription: renewalSubscription,
  });
  expect(
    await repo.compareAndWrite({
      next: { ...renewalOperation, revision: "verifying", state: "verifying" },
      expectedRevision: "wrong",
    }),
  ).toBe(false);
  expect(
    await repo.compareAndWrite({
      next: { ...renewalOperation, revision: "verifying", state: "verifying" },
      expectedRevision: renewalOperation.revision,
    }),
  ).toBe(true);
  expect(await repo.getControl({ guildId: renewalGuildId })).toBeDefined();
  expect(
    await repo.compareAndWrite({
      next: {
        ...renewalOperation,
        revision: "review",
        state: "needs_review",
        reason: "provider_uncertain",
      },
      expectedRevision: "verifying",
    }),
  ).toBe(true);
  expect(await repo.getControl({ guildId: renewalGuildId })).toBeDefined();
  expect(
    await repo.compareAndWrite({
      next: {
        ...renewalOperation,
        revision: "done",
        state: "succeeded",
        verifiedTerms: renewalOperation.approvedTerms,
      },
      expectedRevision: "review",
    }),
  ).toBe(true);
  expect(await repo.getControl({ guildId: renewalGuildId })).toBeUndefined();
  expect(
    await repo.claim({
      operation: renewalOperation,
      expectedSubscription: renewalSubscription,
    }),
  ).toBe(false);
  expect(
    await repo.getOperation({
      guildId: renewalGuildId,
      operationId: renewalOperation.operationId,
    }),
  ).toMatchObject({ state: "succeeded" });
});
it("rejects mutations of immutable consent, timing, privacy and request fields", async () => {
  const repo = getRenewalReactivationRepository();
  await repo.claim({
    operation: renewalOperation,
    expectedSubscription: renewalSubscription,
  });
  for (const patch of [
    { idempotencyKey: "new" },
    { firstAttemptAt: 2000000 },
    { analyticsOptOut: false },
    { approvedTerms: { ...renewalOperation.approvedTerms, unitAmount: 6000 } },
    { stripeRequest: { cancel_at: "", proration_behavior: "none" } },
  ] satisfies Array<Partial<RenewalOperation>>) {
    await expect(
      repo.compareAndWrite({
        next: { ...renewalOperation, ...patch, revision: "new" },
        expectedRevision: renewalOperation.revision,
      }),
    ).rejects.toThrow();
  }
  expect(
    await repo.getOperation({
      guildId: renewalGuildId,
      operationId: renewalOperation.operationId,
    }),
  ).toEqual(renewalOperation);
});

describe("real renewal Dynamo transaction boundary", () => {
  const send = jest.spyOn(DynamoDBClient.prototype, "send");
  beforeEach(() => {
    config.mock.enabled = false;
    send.mockReset();
    send.mockImplementation(async () => ({}));
  });
  afterAll(() => send.mockRestore());
  it("uses a source fence plus separate immutable operation and absent server-control writes", async () => {
    const repo = getRenewalReactivationRepository();
    expect(
      await repo.claim({
        operation: renewalOperation,
        expectedSubscription: renewalSubscription,
      }),
    ).toBe(true);
    const command = send.mock.calls[0][0];
    if (!(command instanceof TransactWriteItemsCommand))
      throw new Error("Expected transaction");
    const allItems = command.input.TransactItems ?? [];
    expect(unmarshall(allItems[0].ConditionCheck?.Key ?? {})).toEqual({
      guildId: `RENEWAL_RECOVERY_CURRENT#${renewalGuildId}`,
    });
    const items = allItems.slice(1);
    expect(items).toHaveLength(4);
    expect(items?.[0].ConditionCheck?.ConditionExpression).toContain(
      "#stripeSyncRevision = :revision",
    );
    expect(unmarshall(items?.[0].ConditionCheck?.Key ?? {})).toEqual({
      guildId: renewalGuildId,
    });
    expect(unmarshall(items?.[1].ConditionCheck?.Key ?? {})).toEqual({
      guildId: "CHANGE_CONTROL#111111111111111111",
    });
    expect(items?.[1].ConditionCheck?.ConditionExpression).toBe(
      "attribute_not_exists(#guildId)",
    );
    expect(unmarshall(items?.[2].Put?.Item ?? {}).guildId).toBe(
      "RENEWAL_OP#111111111111111111#00000000-0000-4000-8000-000000000001",
    );
    expect(unmarshall(items?.[3].Put?.Item ?? {}).guildId).toBe(
      "RENEWAL_CONTROL#111111111111111111",
    );
    expect(items?.[2].Put?.ConditionExpression).toBe(
      "attribute_not_exists(guildId)",
    );
    expect(items?.[3].Put?.ConditionExpression).toBe(
      "attribute_not_exists(guildId)",
    );
  });
  it("reads consistently and atomically releases only the matching control on terminal completion", async () => {
    send.mockImplementationOnce(async () => ({
      Item: marshall({
        ...renewalOperation,
        guildId:
          "RENEWAL_OP#111111111111111111#00000000-0000-4000-8000-000000000001",
      }),
    }));
    const repo = getRenewalReactivationRepository();
    expect(
      await repo.compareAndWrite({
        next: {
          ...renewalOperation,
          revision: "done",
          state: "succeeded",
          verifiedTerms: renewalOperation.approvedTerms,
        },
        expectedRevision: renewalOperation.revision,
      }),
    ).toBe(true);
    const read = send.mock.calls[0][0];
    if (!(read instanceof GetItemCommand))
      throw new Error("Expected consistent read");
    expect(read.input.ConsistentRead).toBe(true);
    const write = send.mock.calls[1][0];
    if (!(write instanceof TransactWriteItemsCommand))
      throw new Error("Expected transaction");
    expect(write.input.TransactItems?.[0].Put?.ConditionExpression).toBe(
      "#revision = :revision",
    );
    expect(write.input.TransactItems?.[1].Delete?.ConditionExpression).toBe(
      "operationId = :operationId",
    );
  });
  it("returns conflict only for known conditional races and propagates storage/permission failures", async () => {
    const repo = getRenewalReactivationRepository();
    const conflict = new TransactionCanceledException({
      $metadata: {},
      message: "raced",
      CancellationReasons: [
        { Code: "None" },
        { Code: "ConditionalCheckFailed" },
      ],
    });
    send.mockImplementationOnce(async () => {
      throw conflict;
    });
    expect(
      await repo.claim({
        operation: renewalOperation,
        expectedSubscription: renewalSubscription,
      }),
    ).toBe(false);
    for (const error of [
      new TransactionCanceledException({ $metadata: {}, message: "unknown" }),
      new Error("permission denied"),
    ]) {
      send.mockImplementationOnce(async () => {
        throw error;
      });
      await expect(
        repo.claim({
          operation: renewalOperation,
          expectedSubscription: renewalSubscription,
        }),
      ).rejects.toBe(error);
    }
  });
});
