/** @jest-environment node */
import {
  DynamoDBClient,
  TransactWriteItemsCommand,
} from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { getBillingChangeRepository } from "../../src/repositories/billingChangeRepository";
import {
  seedUnusedOfferCoverage,
  testWriterImageDigest,
} from "../fixtures/historyWriterBoundary";
import { getOfferUsageRepository } from "../../src/repositories/offerUsageRepository";
import { config } from "../../src/services/configService";
import { getMockStore, resetMockStore } from "../../src/repositories/mockStore";
import { getRenewalReactivationRepository } from "../../src/repositories/renewalReactivationRepository";
import { renewalOperation } from "../fixtures/renewal";
import { changeOperation, changePointer } from "../fixtures/billingChange";

const originalMock = config.mock.enabled;
beforeEach(() => {
  config.mock.enabled = true;
  resetMockStore();
  getMockStore().subscriptions.set(
    changeOperation.guildId,
    structuredClone(changePointer),
  );
});
afterEach(() => {
  config.mock.enabled = originalMock;
});
it("claims one plan change per server across competing tabs", async () => {
  const repo = getBillingChangeRepository();
  const results = await Promise.all([
    repo.claim({
      operation: changeOperation,
      expectedSubscription: changePointer,
    }),
    repo.claim({
      operation: {
        ...changeOperation,
        operationId: "00000000-0000-4000-8000-000000000012",
      },
      expectedSubscription: changePointer,
    }),
  ]);
  expect(results).toEqual([true, false]);
  expect(await repo.getControl(changeOperation.guildId)).toEqual({
    operationId: changeOperation.operationId,
  });
  expect(
    await repo.getOperation(
      changeOperation.guildId,
      changeOperation.operationId,
    ),
  ).toEqual(changeOperation);
  expect(getMockStore().subscriptions.get(changeOperation.guildId)).toEqual(
    changePointer,
  );
});
it("rejects a stale saved subscription before acquiring control", async () => {
  expect(
    await getBillingChangeRepository().claim({
      operation: changeOperation,
      expectedSubscription: { ...changePointer, stripeSyncRevision: "old" },
    }),
  ).toBe(false);
  expect(
    await getBillingChangeRepository().getControl(changeOperation.guildId),
  ).toBeUndefined();
});
it("excludes renewal reactivation while a plan change owns the server", async () => {
  await getBillingChangeRepository().claim({
    operation: changeOperation,
    expectedSubscription: changePointer,
  });
  expect(
    await getRenewalReactivationRepository().claim({
      operation: renewalOperation,
      expectedSubscription: changePointer,
    }),
  ).toBe(false);
});
it("excludes plan changes while renewal restoration owns the server", async () => {
  await getRenewalReactivationRepository().claim({
    operation: renewalOperation,
    expectedSubscription: changePointer,
  });
  expect(
    await getBillingChangeRepository().claim({
      operation: changeOperation,
      expectedSubscription: changePointer,
    }),
  ).toBe(false);
});
it("keeps uncertain operations claimed and rejects stale writers", async () => {
  const repo = getBillingChangeRepository();
  await repo.claim({
    operation: changeOperation,
    expectedSubscription: changePointer,
  });
  const review = {
    ...changeOperation,
    revision: "review-1",
    state: "review",
    funding: null,
  } as const;
  expect(
    await repo.compareAndWrite({ next: review, expectedRevision: "wrong" }),
  ).toBe(false);
  expect(
    await repo.compareAndWrite({
      next: review,
      expectedRevision: changeOperation.revision,
    }),
  ).toBe(true);
  expect(await repo.getControl(changeOperation.guildId)).toBeDefined();
  await expect(
    repo.compareAndWrite({
      next: {
        ...changeOperation,
        revision: "changed",
        state: "canceled",
        completedAt: 1700000001,
      },
      expectedRevision: "review-1",
    }),
  ).rejects.toThrow();
});

it("uses real Dynamo transactions to fence the source, renewal operation and plan control", async () => {
  config.mock.enabled = false;
  const send = jest
    .spyOn(DynamoDBClient.prototype, "send")
    .mockResolvedValue({});
  try {
    expect(
      await getBillingChangeRepository().claim({
        operation: changeOperation,
        expectedSubscription: changePointer,
      }),
    ).toBe(true);
    const command = send.mock.calls[0][0];
    if (!(command instanceof TransactWriteItemsCommand))
      throw new Error("Expected Dynamo transaction");
    const allEntries = command.input.TransactItems ?? [];
    expect(allEntries[0]).toMatchObject({
      ConditionCheck: {
        Key: {
          guildId: { S: `RENEWAL_RECOVERY_CURRENT#${changeOperation.guildId}` },
        },
      },
    });
    const entries = allEntries.slice(1);
    expect(entries).toHaveLength(5);
    expect(unmarshall(entries[0].ConditionCheck?.Key ?? {})).toEqual({
      guildId: changeOperation.guildId,
    });
    expect(entries[0].ConditionCheck?.ConditionExpression).toContain(
      "#stripeSyncRevision = :stripeSyncRevision",
    );
    expect(unmarshall(entries[1].ConditionCheck?.Key ?? {})).toEqual({
      guildId: `RENEWAL_CONTROL#${changeOperation.guildId}`,
    });
    expect(unmarshall(entries[2].ConditionCheck?.Key ?? {})).toEqual({
      guildId: `PURCHASE#${changeOperation.guildId}`,
    });
    expect(unmarshall(entries[3].Put?.Item ?? {})).toMatchObject({
      guildId: `CHANGE_OP#${changeOperation.guildId}#${changeOperation.operationId}`,
      state: "preparing",
    });
    expect(unmarshall(entries[4].Put?.Item ?? {})).toEqual({
      guildId: `CHANGE_CONTROL#${changeOperation.guildId}`,
      operationId: changeOperation.operationId,
    });
  } finally {
    send.mockRestore();
  }
});

it("atomically reserves only the destination offer and rejects invalidated history", async () => {
  seedUnusedOfferCoverage(changeOperation.guildId);
  const authority = {
    guildId: changeOperation.guildId,
    offerId: "basic_annual_intro_v1" as const,
    mode: "test" as const,
    accountId: "acct-owned",
    coverageRevision: "coverage-basic_annual_intro_v1",
    boundaryRevision: "boundary-r1",
    writerImageDigest: testWriterImageDigest,
  };
  const terms = {
    interval: "year" as const,
    currency: "usd" as const,
    regularUnitAmount: 10000 as const,
    discountedUnitAmount: 6000 as const,
    durationMonths: 12 as const,
    priceId: "price_basic_annual",
    couponId: "coupon_annual",
  };
  const operation = {
    ...changeOperation,
    target: {
      ...changeOperation.target,
      selection: {
        tier: "basic" as const,
        interval: "year" as const,
        expectedOffer: "basic_annual_intro_v1" as const,
      },
      offer: { id: "basic_annual_intro_v1" as const, terms, authority },
    },
  };
  const usage = {
    next: {
      guildId: operation.guildId,
      mode: "test",
      offerId: "basic_annual_intro_v1",
      revision: "reserved-1",
      state: "reserved",
      operationId: operation.operationId,
      reservedAt: operation.createdAt * 1000,
      terms,
    },
    expected: undefined,
    authority,
  };
  const store = getMockStore();
  const boundary = store.historyWriterBoundaries.values().next().value;
  if (!boundary) throw new Error("Expected writer boundary");
  store.historyWriterBoundaries.clear();
  const repo = getBillingChangeRepository();
  expect(
    await repo.claim({ operation, expectedSubscription: changePointer, usage }),
  ).toBe(false);
  expect(await repo.getControl(operation.guildId)).toBeUndefined();
  seedUnusedOfferCoverage(operation.guildId);
  expect(
    await repo.claim({ operation, expectedSubscription: changePointer, usage }),
  ).toBe(true);
  expect(
    await getOfferUsageRepository().get(
      operation.guildId,
      "basic_annual_intro_v1",
      "test",
    ),
  ).toMatchObject({ state: "reserved", operationId: operation.operationId });
  expect(
    await getOfferUsageRepository().get(
      operation.guildId,
      "basic_intro_v1",
      "test",
    ),
  ).toBeUndefined();
  expect(store.purchaseAttempts.size).toBe(0);
});

it("does not race a pending initial purchase into a plan-change claim", async () => {
  getMockStore().purchaseAttempts.set(changeOperation.guildId, {
    guildId: changeOperation.guildId,
    attemptId: "pending-purchase",
    revision: "purchase-1",
    payerId: changeOperation.payerId,
    mode: "test",
    fingerprint: "purchase",
    createdAt: 100,
    state: "preparing",
    checkout: { mode: "subscription" },
  });
  expect(
    await getBillingChangeRepository().claim({
      operation: changeOperation,
      expectedSubscription: changePointer,
    }),
  ).toBe(false);
  expect(getMockStore().billingChangeControls.size).toBe(0);
});

it("keeps control through financial settlement until the exact result is reconciled", async () => {
  const repo = getBillingChangeRepository();
  await repo.claim({
    operation: changeOperation,
    expectedSubscription: changePointer,
  });
  const canceling = {
    ...changeOperation,
    revision: "canceling",
    state: "canceling" as const,
    funding: null,
    scheduleId: null,
    consent: null,
  };
  await repo.compareAndWrite({
    next: canceling,
    expectedRevision: changeOperation.revision,
  });
  const canceled = {
    ...changeOperation,
    revision: "settled",
    state: "canceled" as const,
    completedAt: 1700000001,
  };
  await expect(
    repo.compareAndWrite({
      next: { ...canceled, reconciled: true },
      expectedRevision: canceling.revision,
    }),
  ).rejects.toThrow("requires entitlement reconciliation");
  expect(
    await repo.compareAndWrite({
      next: canceled,
      expectedRevision: canceling.revision,
    }),
  ).toBe(true);
  expect(await repo.getControl(changeOperation.guildId)).toBeDefined();
  await expect(
    repo.compareAndWrite({
      next: {
        ...canceled,
        revision: "forged",
        completedAt: 1700000002,
        reconciled: true,
      },
      expectedRevision: canceled.revision,
    }),
  ).rejects.toThrow("Only entitlement reconciliation");
  expect(
    await repo.compareAndWrite({
      next: { ...canceled, revision: "reconciled", reconciled: true },
      expectedRevision: canceled.revision,
    }),
  ).toBe(true);
  expect(await repo.getControl(changeOperation.guildId)).toBeUndefined();
});

it.each([false, true])(
  "keeps the native Dynamo control until reconciled=%s",
  async (reconciled) => {
    config.mock.enabled = false;
    const send = jest
      .spyOn(DynamoDBClient.prototype, "send")
      .mockResolvedValue({});
    try {
      const { writeBillingChangeOperation } = await import("../../src/db");
      await writeBillingChangeOperation({
        next: {
          ...changeOperation,
          state: "canceled",
          completedAt: 1700000001,
          revision: "settled",
          reconciled,
        },
        expectedRevision: "prior",
      });
      const command = send.mock.calls[0][0];
      if (!(command instanceof TransactWriteItemsCommand))
        throw Error("Expected Dynamo transaction");
      const control = command.input.TransactItems?.[1];
      expect(
        reconciled ? control?.Delete : control?.ConditionCheck,
      ).toBeDefined();
      expect(
        reconciled ? control?.ConditionCheck : control?.Delete,
      ).toBeUndefined();
    } finally {
      send.mockRestore();
    }
  },
);
