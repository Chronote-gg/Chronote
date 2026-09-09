/** @jest-environment node */
import {
  DynamoDBClient,
  TransactWriteItemsCommand,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import {
  compareAndWritePurchaseAttempt,
  readPurchaseAttempt,
  claimStripeWebhookEvent,
  finishStripeWebhookEvent,
} from "../../src/db";
import {
  getPurchaseRepository,
  advanceAttempt,
} from "../../src/repositories/purchaseAttemptRepository";
import { getMockStore, resetMockStore } from "../../src/repositories/mockStore";
import { getStripeWebhookRepository } from "../../src/repositories/stripeWebhookRepository";
import type { PurchaseAttempt } from "../../src/types/purchase";
const guildId = "111111111111111111";
const attempt: PurchaseAttempt = {
  guildId,
  attemptId: "attempt",
  revision: "revision",
  payerId: "payer",
  mode: "test",
  fingerprint: "fingerprint",
  createdAt: 100,
  state: "preparing",
  checkout: { mode: "subscription" },
};

describe("purchase Dynamo commands", () => {
  const send = jest.spyOn(DynamoDBClient.prototype, "send");
  beforeEach(() => {
    send.mockReset();
    send.mockResolvedValue({} as never);
  });
  afterAll(() => send.mockRestore());
  test("reserves in a namespaced row atomically guarded by the original subscription revision", async () => {
    const pointer = {
      guildId,
      tier: "free" as const,
      status: "canceled",
      subscriptionType: "stripe",
      startDate: "2026-01-01",
      stripeSubscriptionId: "sub_prior",
      stripeSyncRevision: "original",
    };
    await expect(
      compareAndWritePurchaseAttempt(attempt, undefined, pointer),
    ).resolves.toBe(true);
    const command = send.mock.calls[0][0];
    expect(command).toBeInstanceOf(TransactWriteItemsCommand);
    if (!(command instanceof TransactWriteItemsCommand))
      throw new Error("Wrong command");
    const [guard, put] = command.input.TransactItems!;
    expect(unmarshall(guard.ConditionCheck!.Key!)).toEqual({ guildId });
    expect(
      unmarshall(guard.ConditionCheck!.ExpressionAttributeValues!),
    ).toEqual({
      ":stripeSubscriptionId": "sub_prior",
      ":stripeSyncRevision": "original",
    });
    expect(guard.ConditionCheck!.ConditionExpression).toContain(
      "#stripeSyncRevision = :stripeSyncRevision",
    );
    expect(unmarshall(put.Put!.Item!).guildId).toBe(
      "PURCHASE#111111111111111111",
    );
    expect(put.Put!.ConditionExpression).toBe("attribute_not_exists(#guildId)");
  });
  test("fences attempt revision and writes incident in the same transaction", async () => {
    const key = "PURCHASE#111111111111111111#DUPLICATE#test#sub_a#sub_b";
    await compareAndWritePurchaseAttempt(
      { ...attempt, revision: "next", incidentKey: key },
      attempt,
      undefined,
      {
        guildId,
        key,
        acceptedId: "sub_a",
        incomingId: "sub_b",
        acceptedStatus: "active",
        incomingStatus: "trialing",
        firstObservedAt: "2026-01-01",
        lastObservedAt: "2026-01-01",
        reason: "competing_nonterminal_subscription",
        incomingAttemptId: "attempt_original",
      },
    );
    const command = send.mock.calls[0][0];
    if (!(command instanceof TransactWriteItemsCommand))
      throw new Error("Wrong command");
    expect(command.input.TransactItems).toHaveLength(3);
    expect(command.input.TransactItems![2].Update!.UpdateExpression).toContain(
      "#firstObservedAt = if_not_exists(#firstObservedAt, :firstObservedAt)",
    );
    expect(command.input.TransactItems![2].Update!.UpdateExpression).toContain(
      "#incomingAttemptId = if_not_exists(#incomingAttemptId, :incomingAttemptId)",
    );
    expect(command.input.TransactItems![2].Update!.UpdateExpression).toContain(
      "#lastObservedAt = :lastObservedAt",
    );
    expect(command.input.TransactItems![1].Put!.ConditionExpression).toBe(
      "#revision = :revision",
    );
    expect(
      unmarshall(
        command.input.TransactItems![1].Put!.ExpressionAttributeValues!,
      ),
    ).toEqual({ ":revision": "revision" });
    expect(
      unmarshall(command.input.TransactItems![2].Update!.Key!).guildId,
    ).toBe(key);
  });
  test("strongly reads control state without exposing synthetic guild keys", async () => {
    send.mockResolvedValueOnce({
      Item: marshall({ ...attempt, guildId: "PURCHASE#111111111111111111" }),
    } as never);
    await expect(readPurchaseAttempt(guildId)).resolves.toEqual(attempt);
    const command = send.mock.calls[0][0];
    expect(command).toBeInstanceOf(GetItemCommand);
    if (command instanceof GetItemCommand)
      expect(command.input.ConsistentRead).toBe(true);
  });
  test("refuses caller-supplied control namespaces", async () => {
    await expect(readPurchaseAttempt("PURCHASE#123")).rejects.toThrow(
      "Invalid purchase guild ID",
    );
    expect(send).not.toHaveBeenCalled();
  });
  test("reclaims only expired processing receipts and finishes only an unexpired owned lease", async () => {
    await claimStripeWebhookEvent({
      eventId: "evt",
      receivedAt: "now",
      expiresAt: 1000,
      state: "processing",
      leaseToken: "token",
      leaseUntil: Date.now() + 60000,
    });
    await finishStripeWebhookEvent("evt", "token", false);
    const claim = send.mock.calls[0][0];
    const finish = send.mock.calls[1][0];
    expect(claim).toBeInstanceOf(PutItemCommand);
    expect(finish).toBeInstanceOf(UpdateItemCommand);
    if (claim instanceof PutItemCommand)
      expect(claim.input.ConditionExpression).toContain(
        "#state = :processing AND leaseUntil <= :now",
      );
    if (finish instanceof UpdateItemCommand)
      expect(finish.input.ConditionExpression).toContain(
        "leaseToken = :token AND leaseUntil > :now",
      );
  });
});

describe("mock concurrency parity", () => {
  beforeEach(() => resetMockStore());
  test("an incident revision defeats a stale attempt replacement", async () => {
    const repo = getPurchaseRepository();
    const pointer = getMockStore().subscriptions.get(guildId);
    expect(await repo.compareAndWrite(attempt, undefined, pointer)).toBe(true);
    expect(
      await repo.compareAndWrite(
        advanceAttempt(attempt, {
          state: "needs_review",
          incidentKey: "incident",
        }),
        attempt,
        pointer,
      ),
    ).toBe(true);
    expect(
      await repo.compareAndWrite(
        advanceAttempt(attempt, { state: "expired" }),
        attempt,
        pointer,
      ),
    ).toBe(false);
    expect((await repo.get(guildId))?.state).toBe("needs_review");
  });
  test("stale workers cannot finish or release the replacement webhook lease", async () => {
    const repo = getStripeWebhookRepository();
    const event = {
      eventId: "evt",
      receivedAt: "now",
      expiresAt: 100000,
      state: "processing" as const,
      leaseToken: "old",
      leaseUntil: Date.now() - 1,
    };
    await repo.tryCreate(event);
    expect(
      await repo.claim({
        ...event,
        leaseToken: "new",
        leaseUntil: Date.now() + 60000,
      }),
    ).toBe(true);
    expect(await repo.finish("evt", "old")).toBe(false);
    expect(await repo.finish("evt", "old", true)).toBe(false);
    expect(await repo.finish("evt", "new")).toBe(true);
    expect((await repo.get("evt"))?.state).toBe("completed");
  });
  test("legacy receipts remain completed and cannot be reclaimed", async () => {
    const repo = getStripeWebhookRepository();
    const legacy = { eventId: "evt", receivedAt: "now", expiresAt: 100000 };
    await repo.tryCreate(legacy);
    expect(
      await repo.claim({
        ...legacy,
        state: "processing",
        leaseToken: "new",
        leaseUntil: Date.now() + 60000,
      }),
    ).toBe(false);
  });
});
