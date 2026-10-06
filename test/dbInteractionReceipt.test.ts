import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import { getInteractionReceipt, tryCreateInteractionReceipt } from "../src/db";

const send = jest.spyOn(DynamoDBClient.prototype, "send");
beforeEach(() => send.mockReset());
afterAll(() => send.mockRestore());

const receipt = {
  interactionId: "summary-upgrade:guild-1",
  interactionKind: "summary_upgrade",
  guildId: "guild-1",
  createdAt: "2026-10-05T12:00:00Z",
  expiresAt: 1791806400,
};

test("reads an existing cooldown by its key, or returns absent", async () => {
  send.mockResolvedValueOnce({ Item: marshall(receipt) } as never);
  await expect(getInteractionReceipt(receipt.interactionId)).resolves.toEqual(
    receipt,
  );
  expect(send.mock.calls[0][0]).toBeInstanceOf(GetItemCommand);
  expect((send.mock.calls[0][0] as GetItemCommand).input.Key).toEqual(
    marshall({ interactionId: receipt.interactionId }),
  );
  send.mockResolvedValueOnce({} as never);
  await expect(
    getInteractionReceipt(receipt.interactionId),
  ).resolves.toBeUndefined();
});

test("ordinary interaction receipts remain insert-only after expiry", async () => {
  send.mockResolvedValueOnce({} as never);
  await expect(tryCreateInteractionReceipt(receipt)).resolves.toBe(true);
  const command = send.mock.calls[0][0] as PutItemCommand;
  expect(command.input.ConditionExpression).toBe(
    "attribute_not_exists(interactionId)",
  );
  expect(command.input.ExpressionAttributeValues).toBeUndefined();
});

test("an opt-in cooldown claim atomically replaces only expired receipts", async () => {
  send.mockResolvedValueOnce({} as never);
  await expect(tryCreateInteractionReceipt(receipt, 1791201600)).resolves.toBe(
    true,
  );
  const command = send.mock.calls[0][0] as PutItemCommand;
  expect(command.input).toEqual(
    expect.objectContaining({
      Item: marshall(receipt),
      ConditionExpression:
        "attribute_not_exists(interactionId) OR expiresAt <= :now",
      ExpressionAttributeValues: marshall({ ":now": 1791201600 }),
    }),
  );
});

test("a competing claim or unexpired receipt loses the conditional write", async () => {
  send.mockRejectedValueOnce({
    name: "ConditionalCheckFailedException",
  } as never);
  await expect(tryCreateInteractionReceipt(receipt, 1791201600)).resolves.toBe(
    false,
  );
});

test("storage failures propagate to the optional-offer fallback", async () => {
  const error = new Error("unavailable");
  send.mockRejectedValueOnce(error as never);
  await expect(tryCreateInteractionReceipt(receipt, 1791201600)).rejects.toBe(
    error,
  );
});
