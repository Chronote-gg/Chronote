/** @jest-environment node */
import {
  DynamoDBClient,
  PutItemCommand,
  GetItemCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import {
  compareAndWriteGuildSubscription,
  getGuildSubscription,
} from "../../src/db";
import type { GuildSubscription } from "../../src/types/db";

const subscription: GuildSubscription = {
  guildId: "guild-1",
  tier: "pro",
  status: "active",
  startDate: "2026-01-01",
  subscriptionType: "stripe",
  stripeSubscriptionId: "sub_new",
  stripeSyncRevision: "revision-new",
};

describe("Stripe subscription conditional persistence", () => {
  const send = jest.spyOn(DynamoDBClient.prototype, "send");
  beforeEach(() => {
    send.mockReset();
    send.mockResolvedValue({} as never);
  });
  afterAll(() => send.mockRestore());

  test("guards both the subscription pointer and revision when replacing a row", async () => {
    const expected = {
      ...subscription,
      stripeSubscriptionId: "sub_old",
      stripeSyncRevision: "revision-old",
    };
    await expect(
      compareAndWriteGuildSubscription(subscription, expected),
    ).resolves.toBe(true);
    const command = send.mock.calls[0][0] as PutItemCommand;
    expect(command).toBeInstanceOf(PutItemCommand);
    expect(command.input).toMatchObject({
      Item: marshall(subscription),
      ConditionExpression:
        "attribute_exists(#guildId) AND #stripeSubscriptionId = :stripeSubscriptionId AND #stripeSyncRevision = :stripeSyncRevision",
      ExpressionAttributeNames: {
        "#guildId": "guildId",
        "#stripeSubscriptionId": "stripeSubscriptionId",
        "#stripeSyncRevision": "stripeSyncRevision",
      },
      ExpressionAttributeValues: marshall({
        ":stripeSubscriptionId": "sub_old",
        ":stripeSyncRevision": "revision-old",
      }),
    });
  });

  test("requires a missing row when adopting the first subscription", async () => {
    await compareAndWriteGuildSubscription(subscription, undefined);
    const command = send.mock.calls[0][0] as PutItemCommand;
    expect(command.input.ConditionExpression).toBe(
      "attribute_not_exists(#guildId)",
    );
    expect(command.input.ExpressionAttributeValues).toBeUndefined();
  });

  test("requires legacy missing fields to remain absent instead of ignoring them", async () => {
    const legacy: GuildSubscription = {
      guildId: "guild-1",
      tier: "free",
      status: "free",
      startDate: "2026-01-01",
      subscriptionType: "manual",
    };
    await compareAndWriteGuildSubscription(subscription, legacy);
    const command = send.mock.calls[0][0] as PutItemCommand;
    expect(command.input.ConditionExpression).toBe(
      "attribute_exists(#guildId) AND attribute_not_exists(#stripeSubscriptionId) AND attribute_not_exists(#stripeSyncRevision)",
    );
    expect(command.input.ExpressionAttributeValues).toBeUndefined();
  });

  test("reports a rejected condition without retrying the stale write", async () => {
    send.mockRejectedValueOnce({
      name: "ConditionalCheckFailedException",
    } as never);
    await expect(
      compareAndWriteGuildSubscription(subscription, undefined),
    ).resolves.toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  });

  test("propagates unknown persistence errors for webhook retry", async () => {
    send.mockRejectedValueOnce(new Error("Dynamo unavailable") as never);
    await expect(
      compareAndWriteGuildSubscription(subscription, undefined),
    ).rejects.toThrow("Dynamo unavailable");
  });

  test("reads the current committed row before reconciling", async () => {
    send.mockResolvedValueOnce({ Item: marshall(subscription) } as never);
    await expect(getGuildSubscription("guild-1")).resolves.toEqual(
      subscription,
    );
    const command = send.mock.calls[0][0] as GetItemCommand;
    expect(command).toBeInstanceOf(GetItemCommand);
    expect(command.input.ConsistentRead).toBe(true);
  });
});
