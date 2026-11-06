import {
  DynamoDBClient,
  QueryCommand,
  ScanCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import {
  listActiveEntitlementGrantsForGuild,
  listEntitlementGrants,
} from "../src/db";

const send = jest.spyOn(DynamoDBClient.prototype, "send");
beforeEach(() => {
  send.mockReset();
  send.mockImplementation(async () => {
    throw new Error("Unexpected DynamoDB page request");
  });
});
afterAll(() => send.mockRestore());

const first = {
  grantId: "grant-1",
  guildId: "guild-1",
  status: "active",
  internalNotes: "synthetic raw field",
};
const second = { ...first, grantId: "grant-2" };
const cursor = marshall({ grantId: "cursor" });
const commandInput = (command: unknown) => {
  if (command instanceof QueryCommand || command instanceof ScanCommand) {
    return command.input;
  }
  throw new Error("Expected a DynamoDB query or scan");
};

describe.each(["query", "scan"])("entitlement grant %s pagination", (mode) => {
  const filters: Parameters<typeof listEntitlementGrants>[0] = {
    ...(mode === "query" ? { guildId: "guild-1" } : {}),
    status: "active",
  };

  test("unlimited reads cross an empty filtered page and preserve raw grants", async () => {
    send.mockImplementationOnce(async () => ({
      Items: [marshall(first)],
      LastEvaluatedKey: cursor,
    }));
    send.mockImplementationOnce(async () => ({
      Items: [],
      LastEvaluatedKey: cursor,
    }));
    send.mockImplementationOnce(async () => ({ Items: [marshall(second)] }));

    const result =
      mode === "query"
        ? await listActiveEntitlementGrantsForGuild("guild-1")
        : await listEntitlementGrants(filters);
    expect(result).toEqual([first, second]);
    expect(send).toHaveBeenCalledTimes(3);
    send.mock.calls.forEach(([command], i) => {
      expect(command).toBeInstanceOf(
        mode === "query" ? QueryCommand : ScanCommand,
      );
      const input = commandInput(command);
      expect(input.Limit).toBeUndefined();
      expect(input.ExclusiveStartKey).toEqual(i ? cursor : undefined);
      expect(input.FilterExpression).toBe("#status = :status");
      expect(input.ExpressionAttributeValues?.[":status"]).toEqual({
        S: "active",
      });
      if (mode === "query") {
        expect(input).toMatchObject({
          IndexName: "GuildIdIndex",
          KeyConditionExpression: "#guildId = :guildId",
          ExpressionAttributeValues: { ":guildId": { S: "guild-1" } },
        });
      }
    });
  });

  test("positive limits continue across empty pages and stop at enough matches", async () => {
    send.mockImplementationOnce(async () => ({
      Items: [],
      LastEvaluatedKey: cursor,
    }));
    send.mockImplementationOnce(async () => ({
      Items: [marshall(first)],
      LastEvaluatedKey: cursor,
    }));
    send.mockImplementationOnce(async () => ({
      Items: [marshall(second)],
      LastEvaluatedKey: cursor,
    }));
    await expect(
      listEntitlementGrants({ ...filters, limit: 2 }),
    ).resolves.toEqual([first, second]);
    expect(send).toHaveBeenCalledTimes(3);
    expect(
      send.mock.calls.map(([command]) => commandInput(command).Limit),
    ).toEqual([2, 2, 1]);
  });

  test("later page errors propagate without returning partial grants", async () => {
    const error = new Error("Synthetic page failure");
    send.mockImplementationOnce(async () => ({
      Items: [marshall(first)],
      LastEvaluatedKey: cursor,
    }));
    send.mockImplementationOnce(async () => {
      throw error;
    });
    await expect(listEntitlementGrants(filters)).rejects.toBe(error);
    expect(send).toHaveBeenCalledTimes(2);
  });
});

test("an unfiltered no-argument scan follows an empty page continuation", async () => {
  send.mockImplementationOnce(async () => ({
    Items: [],
    LastEvaluatedKey: cursor,
  }));
  send.mockImplementationOnce(async () => ({ Items: [marshall(first)] }));
  await expect(listEntitlementGrants()).resolves.toEqual([first]);
  expect(send).toHaveBeenCalledTimes(2);
  expect(
    commandInput(send.mock.calls[0]?.[0]).FilterExpression,
  ).toBeUndefined();
});
