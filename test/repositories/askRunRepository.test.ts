/** @jest-environment node */
import {
  type DynamoDBClient,
  GetItemCommand,
  TransactWriteItemsCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { createDynamoAskRunRepository } from "../../src/repositories/askRunRepository";
import type { AskRunRecord } from "../../src/types/askRun";
import {
  uploadObjectToS3,
  fetchJsonFromS3,
} from "../../src/services/storageService";
jest.mock("../../src/services/storageService", () => ({
  uploadObjectToS3: jest.fn(),
  fetchJsonFromS3: jest.fn(),
}));
const record = (): AskRunRecord => ({
  input: {
    userId: "user",
    guildId: "guild",
    conversationId: "conversation",
    requestId: "request",
    question: "question",
  },
  snapshot: {
    runId: "run",
    requestId: "request",
    conversationId: "conversation",
    question: "question",
    status: "running",
    text: "",
    createdAt: "2026-11-17",
    updatedAt: "2026-11-17",
  },
  ownerToken: "owner",
  version: 1,
  leaseExpiresAt: 10000,
});
const setup = () => {
  const send = jest.fn().mockResolvedValue({});
  const repository = createDynamoAskRunRepository({ send } as unknown as Pick<
    DynamoDBClient,
    "send"
  >);
  return { repository, send };
};
beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(uploadObjectToS3).mockImplementation(async (key) => key);
});
it("accepts the request and locks the conversation in one transaction", async () => {
  const { repository, send } = setup();
  await expect(repository.create(record())).resolves.toBe(true);
  const command = send.mock.calls[0][0] as TransactWriteItemsCommand;
  expect(command.input.TransactItems).toHaveLength(2);
  expect(
    command.input.TransactItems!.every(
      (item) => item.Put?.ConditionExpression === "attribute_not_exists(pk)",
    ),
  ).toBe(true);
});
it("fences updates by owner, version, state and unexpired lease; releases only its own lock", async () => {
  const { repository, send } = setup();
  const prior = record();
  await repository.replace(
    prior,
    {
      ...prior,
      version: 2,
      snapshot: { ...prior.snapshot, status: "completed" },
      privateState: { history: ["private"] },
    },
    1000,
  );
  const items = (send.mock.calls[0][0] as TransactWriteItemsCommand).input
    .TransactItems!;
  expect(items).toHaveLength(3);
  expect(items[0].Put?.ConditionExpression).toContain(
    "ownerToken = :owner AND leaseExpiresAt > :now",
  );
  expect(items[0].Put?.ConditionExpression).toContain("#version = :version");
  const saved = unmarshall(items[0].Put!.Item!);
  expect(JSON.stringify(saved)).not.toContain('private"');
  expect(saved.privateStateKey).toContain("private.json");
  expect(items[1].Delete?.ConditionExpression).toBe("runId = :run");
});
it("offloads large answers and restores canonical text while Dynamo items stay bounded", async () => {
  const { repository, send } = setup();
  const prior = record();
  prior.snapshot.text = "x".repeat(420000);
  await repository.create(prior);
  const item = (send.mock.calls[0][0] as TransactWriteItemsCommand).input
    .TransactItems![0].Put!.Item!;
  expect(Buffer.byteLength(JSON.stringify(item))).toBeLessThan(400000);
  const stored = unmarshall(item);
  jest
    .mocked(fetchJsonFromS3)
    .mockResolvedValue({ input: prior.input, snapshot: prior.snapshot });
  send.mockResolvedValueOnce({ Item: marshall(stored) });
  expect(
    (await repository.get(prior.input, "run"))?.snapshot.text,
  ).toHaveLength(420000);
  expect(send.mock.calls[1][0]).toBeInstanceOf(GetItemCommand);
  expect((send.mock.calls[1][0] as GetItemCommand).input.ConsistentRead).toBe(
    true,
  );
});
it("distinguishes conditional conflicts from infrastructure failures", async () => {
  const { repository, send } = setup();
  send.mockRejectedValueOnce({
    name: "TransactionCanceledException",
    CancellationReasons: [{ Code: "ConditionalCheckFailed" }],
  });
  await expect(repository.create(record())).resolves.toBe(false);
  send.mockRejectedValueOnce(new Error("network"));
  await expect(repository.create(record())).rejects.toThrow("network");
});
