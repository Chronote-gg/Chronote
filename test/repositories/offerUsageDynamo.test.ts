/** @jest-environment node */
import {
  DynamoDBClient,
  TransactWriteItemsCommand,
  GetItemCommand,
  TransactionCanceledException,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import {
  compareAndWriteOfferUsage,
  compareAndWritePurchaseAttempt,
  readOfferUsage,
} from "../../src/db";
import type { PurchaseAttempt } from "../../src/types/purchase";
const guildId = "111111111111111111";
const operation: PurchaseAttempt = {
  guildId,
  attemptId: "op",
  revision: "op-r1",
  payerId: "payer",
  mode: "test",
  fingerprint: "terms",
  createdAt: 100,
  state: "open",
  checkout: {},
};
const next = {
  guildId,
  offerId: "basic_intro_v1",
  mode: "test",
  revision: "offer-r1",
  state: "reserved",
  operationId: "op",
  reservedAt: 100,
  terms: {
    priceId: "price-month",
    couponId: "coupon",
    currency: "usd",
    interval: "month",
    regularUnitAmount: 1000,
    discountedUnitAmount: 600,
    durationMonths: 3,
  },
};
const send = jest.spyOn(DynamoDBClient.prototype, "send");
beforeEach(() => {
  send.mockReset();
  send.mockResolvedValue({} as never);
});
afterAll(() => send.mockRestore());

test("reserves usage with operation and subscription fences in one transaction", async () => {
  const pointer = {
    guildId,
    tier: "basic",
    status: "active",
    subscriptionType: "stripe",
    startDate: "now",
    stripeSubscriptionId: "sub",
    stripeSyncRevision: "sub-r1",
  };
  expect(
    await compareAndWriteOfferUsage({
      next,
      expected: undefined,
      pointer,
      operation,
    }),
  ).toBe(true);
  const command = send.mock.calls[0][0];
  expect(command).toBeInstanceOf(TransactWriteItemsCommand);
  if (!(command instanceof TransactWriteItemsCommand))
    throw new Error("Wrong command");
  const [subscription, op, usage] = command.input.TransactItems!;
  expect(unmarshall(subscription.ConditionCheck!.Key!)).toEqual({ guildId });
  expect(
    unmarshall(subscription.ConditionCheck!.ExpressionAttributeValues!),
  ).toEqual({
    ":stripeSubscriptionId": "sub",
    ":stripeSyncRevision": "sub-r1",
  });
  expect(unmarshall(op.ConditionCheck!.Key!)).toEqual({
    guildId: "PURCHASE#111111111111111111",
  });
  expect(unmarshall(op.ConditionCheck!.ExpressionAttributeValues!)).toEqual({
    ":revision": "op-r1",
    ":attemptId": "op",
    ":mode": "test",
  });
  expect(unmarshall(usage.Put!.Item!)).toEqual({
    ...next,
    guildId: "OFFER#test#111111111111111111#basic_intro_v1",
    serverId: guildId,
  });
  expect(usage.Put!.ConditionExpression).toBe("attribute_not_exists(#guildId)");
});

test("releases only the reserved usage revision", async () => {
  const released = {
    guildId,
    offerId: "basic_intro_v1",
    mode: "test",
    revision: "offer-r2",
    state: "unused",
    released: {
      operationId: "op",
      reason: "checkout_expired",
      resourceId: "cs-expired",
      verifiedAt: 200,
    },
  };
  expect(
    await compareAndWriteOfferUsage({
      next: released,
      expected: next,
      pointer: undefined,
      operation,
    }),
  ).toBe(true);
  const command = send.mock.calls[0][0];
  if (!(command instanceof TransactWriteItemsCommand))
    throw new Error("Wrong command");
  const usage = command.input.TransactItems![2].Put!;
  expect(usage.ConditionExpression).toBe("#revision = :revision");
  expect(unmarshall(usage.ExpressionAttributeValues!)).toEqual({
    ":revision": "offer-r1",
  });
});

test("consistent point reads decode and validate the exact requested scope", async () => {
  send.mockResolvedValueOnce({
    Item: marshall({
      ...next,
      guildId: "OFFER#test#111111111111111111#basic_intro_v1",
      serverId: guildId,
    }),
  } as never);
  await expect(
    readOfferUsage(guildId, "basic_intro_v1", "test"),
  ).resolves.toEqual(next);
  const command = send.mock.calls[0][0];
  expect(command).toBeInstanceOf(GetItemCommand);
  if (!(command instanceof GetItemCommand)) throw new Error("Wrong command");
  expect(command.input.ConsistentRead).toBe(true);
  expect(unmarshall(command.input.Key!)).toEqual({
    guildId: "OFFER#test#111111111111111111#basic_intro_v1",
  });
});

test.each([
  {
    ...next,
    serverId: "222222222222222222",
    guildId: "OFFER#test#111111111111111111#basic_intro_v1",
  },
  {
    ...next,
    mode: "live",
    serverId: guildId,
    guildId: "OFFER#test#111111111111111111#basic_intro_v1",
  },
  {
    ...next,
    state: "used",
    serverId: guildId,
    guildId: "OFFER#test#111111111111111111#basic_intro_v1",
  },
])("rejects malformed or cross-scope persisted usage %p", async (row) => {
  send.mockResolvedValueOnce({ Item: marshall(row) } as never);
  await expect(
    readOfferUsage(guildId, "basic_intro_v1", "test"),
  ).rejects.toThrow();
});

test.each(["ConditionalCheckFailed", "TransactionConflict"])(
  "returns false for a lost %s fence",
  async (Code) => {
    send.mockRejectedValueOnce(
      new TransactionCanceledException({
        $metadata: {},
        message: "Lost fence",
        CancellationReasons: [{ Code }, { Code: "None" }],
      }),
    );
    await expect(
      compareAndWriteOfferUsage({
        next,
        expected: undefined,
        pointer: undefined,
        operation,
      }),
    ).resolves.toBe(false);
  },
);

test("propagates operational failures even when another fence also failed", async () => {
  const error = new TransactionCanceledException({
    $metadata: {},
    message: "Outage",
    CancellationReasons: [
      { Code: "ConditionalCheckFailed" },
      { Code: "ValidationError" },
    ],
  });
  send.mockRejectedValueOnce(error);
  await expect(
    compareAndWriteOfferUsage({
      next,
      expected: undefined,
      pointer: undefined,
      operation,
    }),
  ).rejects.toBe(error);
});

test("purchase and offer are stored in the same fenced transaction", async () => {
  await expect(
    compareAndWritePurchaseAttempt(operation, undefined, undefined, undefined, {
      next: { ...next, operationId: operation.attemptId },
      expected: undefined,
    }),
  ).resolves.toBe(true);
  const command = send.mock.calls[0][0];
  if (!(command instanceof TransactWriteItemsCommand))
    throw new Error("Wrong command");
  expect(command.input.TransactItems).toHaveLength(3);
  const [pointer, purchase, offer] = command.input.TransactItems!;
  expect(pointer.ConditionCheck!.ConditionExpression).toBe(
    "attribute_not_exists(#guildId)",
  );
  expect(unmarshall(purchase.Put!.Item!).guildId).toBe(
    "PURCHASE#111111111111111111",
  );
  expect(unmarshall(offer.Put!.Item!).guildId).toBe(
    "OFFER#test#111111111111111111#basic_intro_v1",
  );
});

test("a same-attempt original invoice cannot change through the real database writer", async () => {
  const expected = { ...operation, initialInvoiceId: "in-original" };
  await expect(
    compareAndWritePurchaseAttempt(
      { ...expected, revision: "new", initialInvoiceId: "in-other" },
      expected,
      undefined,
    ),
  ).rejects.toThrow("Initial invoice binding");
  expect(send).not.toHaveBeenCalled();
});

test("purchase reservation atomically checks unused coverage and the verified writer image", async () => {
  await compareAndWritePurchaseAttempt(
    operation,
    undefined,
    undefined,
    undefined,
    {
      next,
      expected: undefined,
      authority: {
        guildId,
        offerId: "basic_intro_v1",
        mode: "test",
        accountId: "acct-owned",
        coverageRevision: "coverage-r1",
        boundaryRevision: "boundary-r1",
        writerImageDigest: "sha256:" + "a".repeat(64),
      },
    },
  );
  const command = send.mock.calls[0][0];
  if (!(command instanceof TransactWriteItemsCommand))
    throw new Error("Wrong command");
  const items = command.input.TransactItems!;
  expect(items).toHaveLength(5);
  expect(unmarshall(items[3].ConditionCheck!.Key!)).toEqual({
    guildId: "OFFER_HISTORY#test#acct-owned#" + guildId + "#basic_intro_v1",
  });
  expect(
    unmarshall(items[3].ConditionCheck!.ExpressionAttributeValues!),
  ).toEqual({
    ":revision": "coverage-r1",
    ":state": "unused",
    ":boundary": "boundary-r1",
  });
  expect(
    unmarshall(items[4].ConditionCheck!.ExpressionAttributeValues!),
  ).toEqual({
    ":revision": "boundary-r1",
    ":state": "verified",
    ":image": "sha256:" + "a".repeat(64),
  });
});
