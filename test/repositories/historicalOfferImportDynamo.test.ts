/** @jest-environment node */
import { historyWriterBoundaryFixture } from "../fixtures/historyWriterBoundary";
import {
  DynamoDBClient,
  TransactWriteItemsCommand,
  GetItemCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import {
  compareAndWriteHistoricalOfferImport,
  readHistoricalOfferImport,
} from "../../src/db";
const guildId = "111111111111111111";
const record = {
  guildId,
  mode: "test",
  accountId: "acct-owned",
  offerId: "basic_intro_v1",
  revision: "r1",
  runId: "run",
  createdBefore: 1000,
  verifiedAt: 2000000,
  enumeration: "complete",
  catchUp: "complete",
  state: "unused",
  writerBoundaryRevision: "boundary-r1",
};
const send = jest.spyOn(DynamoDBClient.prototype, "send");
beforeEach(() => {
  send.mockReset();
  send.mockResolvedValue({} as never);
});
afterAll(() => send.mockRestore());
test("unused coverage is atomic with absent usage, operation and pointer fences", async () => {
  expect(
    await compareAndWriteHistoricalOfferImport({
      next: record,
      expected: undefined,
      usageNext: undefined,
      usageExpected: undefined,
      pointer: undefined,
      operation: undefined,
      boundary: historyWriterBoundaryFixture(),
    }),
  ).toBe(true);
  const command = send.mock.calls[0][0];
  if (!(command instanceof TransactWriteItemsCommand))
    throw new Error("Wrong command");
  const items = command.input.TransactItems!;
  expect(items).toHaveLength(5);
  expect(
    items
      .slice(0, 3)
      .every(
        (item) =>
          item.ConditionCheck?.ConditionExpression ===
          "attribute_not_exists(#guildId)",
      ),
  ).toBe(true);
  expect(unmarshall(items[1].ConditionCheck!.Key!)).toEqual({
    guildId: "PURCHASE#" + guildId,
  });
  expect(unmarshall(items[2].ConditionCheck!.Key!)).toEqual({
    guildId: "OFFER#test#" + guildId + "#basic_intro_v1",
  });
  expect(
    unmarshall(items[4].ConditionCheck!.ExpressionAttributeValues!),
  ).toMatchObject({ ":revision": "boundary-r1" });
  expect(unmarshall(items[3].Put!.Item!)).toEqual({
    ...record,
    guildId: "OFFER_HISTORY#test#acct-owned#" + guildId + "#basic_intro_v1",
    serverId: guildId,
  });
});
test("coverage read is consistent and validates its persisted account", async () => {
  send.mockResolvedValueOnce({
    Item: marshall({
      ...record,
      guildId: "OFFER_HISTORY#test#acct-owned#" + guildId + "#basic_intro_v1",
      serverId: guildId,
    }),
  } as never);
  expect(
    await readHistoricalOfferImport(
      guildId,
      "basic_intro_v1",
      "test",
      "acct-owned",
    ),
  ).toEqual(record);
  const command = send.mock.calls[0][0];
  if (!(command instanceof GetItemCommand)) throw new Error("Wrong command");
  expect(command.input.ConsistentRead).toBe(true);
  send.mockResolvedValueOnce({
    Item: marshall({
      ...record,
      accountId: "wrong",
      guildId: "OFFER_HISTORY#test#acct-owned#" + guildId + "#basic_intro_v1",
      serverId: guildId,
    }),
  } as never);
  await expect(
    readHistoricalOfferImport(guildId, "basic_intro_v1", "test", "acct-owned"),
  ).rejects.toThrow();
});

test("used import writes usage and coverage with existing control fences", async () => {
  const operation = {
    guildId,
    attemptId: "current",
    revision: "op-r1",
    payerId: "payer",
    mode: "test" as const,
    fingerprint: "f",
    createdAt: 100,
    state: "open" as const,
    checkout: {},
  };
  const pointer = {
    guildId,
    tier: "basic",
    status: "active",
    subscriptionType: "stripe",
    startDate: "now",
    stripeSubscriptionId: "current-sub",
    stripeSyncRevision: "sub-r1",
  };
  const old = {
    guildId,
    mode: "test",
    offerId: "basic_intro_v1",
    revision: "unused-r1",
    state: "unused",
    released: {
      operationId: "failed",
      reason: "checkout_expired",
      resourceId: "cs",
      verifiedAt: 100,
    },
  };
  const used = {
    guildId,
    mode: "test",
    offerId: "basic_intro_v1",
    revision: "used-r1",
    state: "used",
    operationId: "original",
    reservedAt: 100,
    usedAt: 200,
    terms: {
      priceId: "price",
      couponId: "coupon",
      currency: "usd",
      interval: "month",
      regularUnitAmount: 1000,
      discountedUnitAmount: 600,
      durationMonths: 3,
    },
    settlement: {
      customerId: "old-customer",
      subscriptionId: "old-sub",
      subscriptionItemId: "item",
      invoiceId: "invoice",
      priceId: "price",
      status: "paid",
      amountPaid: 0,
      amountRemaining: 0,
      settledAt: 200,
    },
  };
  expect(
    await compareAndWriteHistoricalOfferImport({
      next: { ...record, state: "used", sourceInvoiceId: "invoice" },
      expected: undefined,
      usageNext: used,
      usageExpected: old,
      pointer,
      operation,
    }),
  ).toBe(true);
  const command = send.mock.calls[0][0];
  if (!(command instanceof TransactWriteItemsCommand))
    throw new Error("Wrong command");
  const items = command.input.TransactItems!;
  expect(
    unmarshall(items[0].ConditionCheck!.ExpressionAttributeValues!),
  ).toEqual({
    ":stripeSubscriptionId": "current-sub",
    ":stripeSyncRevision": "sub-r1",
  });
  expect(
    unmarshall(items[1].ConditionCheck!.ExpressionAttributeValues!),
  ).toEqual({ ":revision": "op-r1", ":attemptId": "current", ":mode": "test" });
  expect(unmarshall(items[2].Put!.ExpressionAttributeValues!)).toEqual({
    ":revision": "unused-r1",
  });
  expect(unmarshall(items[2].Put!.Item!).settlement).toEqual(used.settlement);
  expect(items[3].Put).not.toHaveProperty("Key");
});
test.each(["ConditionalCheckFailed", "TransactionConflict"])(
  "only %s is a recoverable import conflict",
  async (code) => {
    const { TransactionCanceledException } =
      await import("@aws-sdk/client-dynamodb");
    send.mockRejectedValueOnce(
      new TransactionCanceledException({
        message: "race",
        $metadata: {},
        CancellationReasons: [{ Code: code }],
      }),
    );
    expect(
      await compareAndWriteHistoricalOfferImport({
        next: record,
        expected: undefined,
        usageNext: undefined,
        usageExpected: undefined,
        pointer: undefined,
        operation: undefined,
        boundary: historyWriterBoundaryFixture(),
      }),
    ).toBe(false);
  },
);
test("permissions and unclassified failure propagate rather than claiming an import conflict", async () => {
  send.mockRejectedValueOnce(new Error("AccessDenied"));
  await expect(
    compareAndWriteHistoricalOfferImport({
      next: record,
      expected: undefined,
      usageNext: undefined,
      usageExpected: undefined,
      pointer: undefined,
      operation: undefined,
      boundary: historyWriterBoundaryFixture(),
    }),
  ).rejects.toThrow("AccessDenied");
});
