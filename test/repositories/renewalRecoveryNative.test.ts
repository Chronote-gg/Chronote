/** @jest-environment node */
import {
  DynamoDBClient,
  TransactWriteItemsCommand,
  QueryCommand,
  ScanCommand,
  DescribeTableCommand,
} from "@aws-sdk/client-dynamodb";
import { unmarshall, marshall } from "@aws-sdk/util-dynamodb";
import { config } from "../../src/services/configService";
import { getRenewalRecoveryRepository } from "../../src/repositories/renewalRecoveryRepository";
import {
  renewalRecoveryKey,
  renewalRecoveryCurrentKey,
  renewalRecoverySchema,
} from "../../src/types/renewalRecovery";
import {
  scanGuildSubscriptionPage,
  getRenewalRecoveryIndexStatus,
  claimBillingChangeOperation,
  claimRenewalOperation,
  compareAndWritePurchaseAttempt,
} from "../../src/db";
import { changeOperation, changePointer } from "../fixtures/billingChange";
import { renewalOperation, renewalSubscription } from "../fixtures/renewal";

const original = config.mock.enabled;
afterEach(() => {
  config.mock.enabled = original;
  jest.restoreAllMocks();
});
const record = () =>
  renewalRecoverySchema.parse({
    guildId: changePointer.guildId,
    subscriptionId: changePointer.stripeSubscriptionId,
    customerId: "cus_owned",
    payerId: changeOperation.payerId,
    mode: "test",
    revision: "r1",
    paid: {
      invoiceId: "in_paid",
      priceId: "price_pro",
      tier: "pro",
      interval: "year",
      periodStart: 1,
      periodEnd: 1000000,
    },
    scheduledOperationId: null,
    enforcementAccepted: false,
    state: "watching",
    nextCheckAt: 1000000,
  });
test("native registration atomically fences saved subscription and current pointer", async () => {
  config.mock.enabled = false;
  const send = jest
    .spyOn(DynamoDBClient.prototype, "send")
    .mockResolvedValue({});
  expect(
    await getRenewalRecoveryRepository().register({
      record: record(),
      expectedSubscription: changePointer,
    }),
  ).toBe(true);
  const command = send.mock.calls
    .map((call) => call[0])
    .find((value) => value instanceof TransactWriteItemsCommand);
  if (!(command instanceof TransactWriteItemsCommand))
    throw new Error("Expected recovery transaction");
  const items = command.input.TransactItems ?? [];
  expect(items).toHaveLength(3);
  expect(items[0].ConditionCheck?.ConditionExpression).toContain(
    "#stripeSyncRevision = :stripeSyncRevision",
  );
  expect(unmarshall(items[1].Put?.Item ?? {})).toMatchObject({
    ownerGuildId: changePointer.guildId,
    recoveryQueue: "test",
    recoveryDueAt: 1000000,
  });
  expect(items[1].Put?.ConditionExpression).toBe(
    "attribute_not_exists(guildId)",
  );
  expect(items[2].Put?.ConditionExpression).toBe(
    "attribute_not_exists(guildId)",
  );
});
test("native due queries paginate the sparse index without a consistent-index read", async () => {
  config.mock.enabled = false;
  const key = {
    guildId: "RENEWAL_RECOVERY#owned",
    recoveryQueue: "test",
    recoveryDueAt: 10,
  };
  const send = jest.spyOn(DynamoDBClient.prototype, "send").mockResolvedValue({
    Items: [marshall(key)],
    LastEvaluatedKey: marshall(key),
  });
  const repo = getRenewalRecoveryRepository();
  const result = await repo.listDue({ mode: "test", now: 12, limit: 1 });
  expect(result.keys).toEqual([key.guildId]);
  await repo.listDue({
    mode: "test",
    now: 12,
    limit: 1,
    cursor: result.cursor,
  });
  const command = send.mock.calls[1][0];
  if (!(command instanceof QueryCommand)) throw new Error("Expected due query");
  expect(command.input).toMatchObject({
    IndexName: "RenewalRecoveryDueIndex",
    ExclusiveStartKey: marshall(key),
  });
  expect(command.input.ConsistentRead).toBeUndefined();
  await expect(
    repo.listDue({ mode: "live", now: 12, limit: 1, cursor: result.cursor }),
  ).rejects.toThrow("mode mismatch");
});
test("all three native billing claims check the financial recovery fence", async () => {
  const send = jest
    .spyOn(DynamoDBClient.prototype, "send")
    .mockResolvedValue({});
  await claimBillingChangeOperation({
    operation: changeOperation,
    expectedSubscription: changePointer,
  });
  await claimRenewalOperation(renewalOperation, renewalSubscription);
  await compareAndWritePurchaseAttempt(
    {
      guildId: changePointer.guildId,
      attemptId: "attempt",
      revision: "r1",
      payerId: "payer",
      mode: "test",
      fingerprint: "f",
      createdAt: 100,
      state: "preparing",
      checkout: { mode: "subscription" },
    },
    undefined,
    changePointer,
  );
  for (const call of send.mock.calls) {
    const command = call[0];
    if (!(command instanceof TransactWriteItemsCommand))
      throw new Error("Expected claim transaction");
    expect(
      command.input.TransactItems?.some(
        (item) =>
          item.ConditionCheck?.ConditionExpression ===
          "attribute_not_exists(guildId) OR #blocking = :no",
      ),
    ).toBe(true);
  }
  expect(send).toHaveBeenCalledTimes(3);
});

test("native coverage inventory is bounded, resumable and excludes synthetic operation keys", async () => {
  config.mock.enabled = false;
  const send = jest
    .spyOn(DynamoDBClient.prototype, "send")
    .mockResolvedValueOnce({
      Items: [
        marshall({ guildId: changePointer.guildId }),
        marshall({ guildId: "CHANGE_OP#synthetic" }),
      ],
      LastEvaluatedKey: marshall({ guildId: "RENEWAL_RECOVERY#cursor" }),
    });
  expect(await scanGuildSubscriptionPage("previous")).toEqual({
    guildIds: [changePointer.guildId],
    cursor: "RENEWAL_RECOVERY#cursor",
  });
  const command = send.mock.calls[0][0];
  if (!(command instanceof ScanCommand)) throw new Error("Expected scan");
  expect(command.input).toMatchObject({
    Limit: 100,
    ConsistentRead: true,
    ProjectionExpression: "guildId",
    ExclusiveStartKey: marshall({ guildId: "previous" }),
  });
  send.mockResolvedValueOnce({
    Table: {
      GlobalSecondaryIndexes: [
        { IndexName: "RenewalRecoveryDueIndex", IndexStatus: "ACTIVE" },
      ],
    },
  });
  expect(await getRenewalRecoveryIndexStatus()).toBe("ACTIVE");
  expect(send.mock.calls[1][0]).toBeInstanceOf(DescribeTableCommand);
});

test("native replacement archives the old watch in the same pointer transaction", async () => {
  config.mock.enabled = false;
  const old = record();
  const oldKey = renewalRecoveryKey(old);
  const send = jest
    .spyOn(DynamoDBClient.prototype, "send")
    .mockResolvedValueOnce({
      Item: marshall({
        guildId: renewalRecoveryCurrentKey(old.guildId),
        key: oldKey,
        revision: old.revision,
        blocking: false,
      }),
    })
    .mockResolvedValueOnce({
      Item: marshall({
        ...old,
        guildId: oldKey,
        ownerGuildId: old.guildId,
        recoveryQueue: old.mode,
        recoveryDueAt: old.paid.periodEnd,
      }),
    })
    .mockResolvedValue({});
  expect(
    await getRenewalRecoveryRepository().register({
      record: renewalRecoverySchema.parse({
        ...old,
        revision: "replacement",
        paid: { ...old.paid, periodStart: 100, periodEnd: 500000 },
        nextCheckAt: 500000,
      }),
      expectedSubscription: changePointer,
    }),
  ).toBe(true);
  const command = send.mock.calls
    .map((call) => call[0])
    .find((value) => value instanceof TransactWriteItemsCommand);
  if (!(command instanceof TransactWriteItemsCommand))
    throw new Error("Expected replacement transaction");
  const items = command.input.TransactItems ?? [];
  expect(items).toHaveLength(4);
  expect(items[0].Update).toMatchObject({
    Key: marshall({ guildId: oldKey }),
    UpdateExpression: expect.stringContaining(
      "REMOVE nextCheckAt, recoveryQueue, recoveryDueAt",
    ),
    ConditionExpression: expect.stringContaining("enforcementAccepted = :no"),
  });
  expect(
    unmarshall(items[0].Update?.ExpressionAttributeValues ?? {}),
  ).toMatchObject({
    ":revision": old.revision,
    ":ended": "ended",
    ":watching": "watching",
    ":no": false,
  });
  expect(items[3].Put?.ConditionExpression).toBe("#revision = :revision");
});
