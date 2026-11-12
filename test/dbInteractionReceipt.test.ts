import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  DeleteItemCommand,
  TransactWriteItemsCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import {
  getInteractionReceipt,
  tryCreateInteractionReceipt,
  releaseInteractionReceipt,
} from "../src/db";
import { config } from "../src/services/configService";
import { getMockStore } from "../src/repositories/mockStore";

const send = jest.spyOn(DynamoDBClient.prototype, "send");
const mockEnabled = config.mock.enabled;
beforeEach(() => {
  send.mockReset();
  config.mock.enabled = false;
});
afterEach(() => {
  config.mock.enabled = mockEnabled;
});
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
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0][0]).toBeInstanceOf(TransactWriteItemsCommand);
  const command = send.mock.calls[0][0] as TransactWriteItemsCommand;
  expect(command.input.TransactItems).toHaveLength(1);
  const put = command.input.TransactItems?.[0].Put;
  expect(put?.Item).toEqual(marshall(receipt));
  expect(put?.ConditionExpression).toBe("attribute_not_exists(interactionId)");
  expect(put?.ExpressionAttributeValues).toBeUndefined();
});

test("an insert-only claim carries a request token that is stable for one interaction on one worker", async () => {
  send.mockResolvedValue({} as never);
  await tryCreateInteractionReceipt(receipt);
  await tryCreateInteractionReceipt(receipt);
  await tryCreateInteractionReceipt({ ...receipt, interactionId: "other" });
  const tokens = send.mock.calls.map(
    ([command]) =>
      (command as TransactWriteItemsCommand).input.ClientRequestToken,
  );
  expect(tokens[0]).toHaveLength(36);
  expect(tokens[1]).toBe(tokens[0]);
  expect(tokens[2]).not.toBe(tokens[0]);
});

const cancelled = (code: "TransactionConflict" | "ConditionalCheckFailed") => ({
  name: "TransactionCanceledException",
  CancellationReasons: [{ Code: code }],
});
const tokensSent = () =>
  send.mock.calls.map(
    ([command]) =>
      (command as TransactWriteItemsCommand).input.ClientRequestToken,
  );

test("a transaction conflict is retried and the loser does not hold the receipt", async () => {
  send.mockRejectedValueOnce(cancelled("TransactionConflict") as never);
  send.mockRejectedValueOnce(cancelled("ConditionalCheckFailed") as never);
  await expect(tryCreateInteractionReceipt(receipt)).resolves.toBe(false);
  expect(send).toHaveBeenCalledTimes(2);
  expect(new Set(tokensSent()).size).toBe(2);
});

test("a transaction conflict followed by success holds the receipt", async () => {
  send.mockRejectedValueOnce(cancelled("TransactionConflict") as never);
  send.mockResolvedValueOnce({} as never);
  await expect(tryCreateInteractionReceipt(receipt)).resolves.toBe(true);
});

test("a conflict that outlasts the retries is not ours", async () => {
  send.mockRejectedValue(cancelled("TransactionConflict") as never);
  await expect(tryCreateInteractionReceipt(receipt)).resolves.toBe(false);
  expect(send).toHaveBeenCalledTimes(3);
  expect(new Set(tokensSent()).size).toBe(3);
});

test("each attempt is one command whose token the SDK's own retries reuse", async () => {
  send.mockRejectedValue(cancelled("TransactionConflict") as never);
  await tryCreateInteractionReceipt(receipt);
  const commands = send.mock.calls.map(([command]) => command);
  expect(new Set(commands).size).toBe(3);
  for (const token of tokensSent()) expect(token).toHaveLength(36);
  // The SDK retries by resending the same command object, so its token is fixed for that attempt.
  const [first] = commands as TransactWriteItemsCommand[];
  expect(first.input.ClientRequestToken).toBe(tokensSent()[0]);
});

test("an insert-only claim passes its signal to the write", async () => {
  send.mockResolvedValueOnce({} as never);
  const signal = new AbortController().signal;
  await tryCreateInteractionReceipt(receipt, undefined, signal);
  expect(send.mock.calls[0][1]).toEqual({ abortSignal: signal });
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

test("a second claim of the same interaction loses the conditional write", async () => {
  send.mockResolvedValueOnce({} as never);
  send.mockRejectedValueOnce({
    name: "ConditionalCheckFailedException",
  } as never);
  await expect(tryCreateInteractionReceipt(receipt)).resolves.toBe(true);
  await expect(tryCreateInteractionReceipt(receipt)).resolves.toBe(false);
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

test("releases only the failed delivery's own receipt", async () => {
  send.mockResolvedValueOnce({} as never);
  await expect(releaseInteractionReceipt(receipt)).resolves.toBe(true);
  expect(send.mock.calls[0][0]).toBeInstanceOf(DeleteItemCommand);
  const command = send.mock.calls[0][0] as DeleteItemCommand;
  expect(command.input.ConditionExpression).toBe(
    "createdAt = :createdAt AND expiresAt = :expiresAt",
  );
  expect(command.input.ExpressionAttributeValues).toEqual(
    marshall({
      ":createdAt": receipt.createdAt,
      ":expiresAt": receipt.expiresAt,
    }),
  );
  send.mockRejectedValueOnce({
    name: "ConditionalCheckFailedException",
  } as never);
  await expect(releaseInteractionReceipt(receipt)).resolves.toBe(false);
});

describe("interaction claims in the mock store", () => {
  beforeEach(() => {
    config.mock.enabled = true;
    getMockStore().deploymentControlRecords.clear();
  });

  test("the first claim of an interaction wins and the second is refused", async () => {
    const claim = { ...receipt, interactionId: "synthetic-first-wins" };
    await expect(tryCreateInteractionReceipt(claim)).resolves.toBe(true);
    await expect(tryCreateInteractionReceipt(claim)).resolves.toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  test("a receipt can be claimed with no deployment control record present", async () => {
    await expect(
      tryCreateInteractionReceipt({
        ...receipt,
        interactionId: "synthetic-no-control-record",
      }),
    ).resolves.toBe(true);
  });
});
