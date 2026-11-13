/** @jest-environment node */
jest.mock("node:timers/promises", () => ({
  setTimeout: jest.fn(async (milliseconds: number) => {
    jest.setSystemTime(Date.now() + milliseconds);
  }),
}));
import {
  ConditionalCheckFailedException,
  TransactionConflictException,
  type DynamoDBClient,
  type UpdateItemCommand,
  type UpdateItemCommandInput,
} from "@aws-sdk/client-dynamodb";
import { setTimeout as delay } from "node:timers/promises";
import { renewActiveMeetingLeaseWrite } from "../../src/repositories/activeMeetingLeaseRenewal";
const mockSend = jest.fn();
const client = { send: mockSend } as unknown as DynamoDBClient;
const start = Date.parse("2026-10-30T12:00:00.950Z");
const conflict = () => new TransactionConflictException({ $metadata: {} });
const stale = () => new ConditionalCheckFailedException({ $metadata: {} });
const CONDITION =
  "#leaseExpiresAt >= :now AND #meetingId = :meetingId AND #ownerInstanceId = :ownerInstanceId";
const input: UpdateItemCommandInput = {
  TableName: "synthetic-active-meeting-table",
  Key: { guildId: { S: "guild" } },
  UpdateExpression: "SET #leaseExpiresAt = :leaseExpiresAt",
  ConditionExpression: CONDITION,
  ExpressionAttributeNames: {
    "#leaseExpiresAt": "leaseExpiresAt",
    "#meetingId": "meetingId",
    "#ownerInstanceId": "ownerInstanceId",
  },
  ExpressionAttributeValues: {
    ":leaseExpiresAt": { N: String(Math.floor(start / 1000) + 30) },
    ":meetingId": { S: "meeting" },
    ":ownerInstanceId": { S: "owner" },
  },
};
const renew = (signal?: AbortSignal) =>
  renewActiveMeetingLeaseWrite(client, input, signal);
beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(start);
  mockSend.mockReset();
  jest.mocked(delay).mockClear();
});
afterEach(() => {
  jest.useRealTimers();
});
test("rejected transaction conflict retries the exact owner with a fresh expiry check", async () => {
  const commands: UpdateItemCommand[] = [];
  mockSend.mockImplementation(async (command: UpdateItemCommand) => {
    commands.push(command);
    if (commands.length === 1) throw conflict();
    return {};
  });
  await expect(renew()).resolves.toBe(true);
  expect(mockSend).toHaveBeenCalledTimes(2);
  expect(
    jest.mocked(delay).mock.calls.map(([milliseconds]) => milliseconds),
  ).toEqual([100]);
  const first = commands[0].input;
  const next = commands[1].input;
  expect(next).toEqual({
    ...first,
    ExpressionAttributeValues: {
      ...first.ExpressionAttributeValues,
      ":now": { N: String(Math.floor((start + 100) / 1000)) },
    },
  });
  expect(next.ConditionExpression).toBe(CONDITION);
  expect(next.ExpressionAttributeValues).toMatchObject({
    ":meetingId": { S: "meeting" },
    ":ownerInstanceId": { S: "owner" },
  });
});
test("conflict retries are bounded and never report ownership on exhaustion", async () => {
  const failure = conflict();
  mockSend.mockRejectedValue(failure);
  await expect(renew()).rejects.toBe(failure);
  expect(mockSend).toHaveBeenCalledTimes(3);
  expect(
    jest.mocked(delay).mock.calls.map(([milliseconds]) => milliseconds),
  ).toEqual([100, 200]);
});
test("a conditional ownership failure after contention stops without another retry", async () => {
  mockSend.mockRejectedValueOnce(conflict()).mockRejectedValueOnce(stale());
  await expect(renew()).resolves.toBe(false);
  expect(mockSend).toHaveBeenCalledTimes(2);
});
test("an ambiguous transport failure is never replayed by conflict handling", async () => {
  const failure = new Error("response lost");
  mockSend.mockRejectedValue(failure);
  await expect(renew()).rejects.toBe(failure);
  expect(mockSend).toHaveBeenCalledTimes(1);
  expect(delay).not.toHaveBeenCalled();
});

test("lease expiry during conflict backoff cannot renew the expired lease", async () => {
  const originalExpiry = Math.floor(start / 1000);
  mockSend.mockImplementation(async (command: UpdateItemCommand) => {
    if (mockSend.mock.calls.length === 1) throw conflict();
    const now = Number(command.input.ExpressionAttributeValues?.[":now"].N);
    if (now > originalExpiry) throw stale();
    return {};
  });
  await expect(renew()).resolves.toBe(false);
  expect(mockSend).toHaveBeenCalledTimes(2);
});
test("an already fenced owner cannot start renewal", async () => {
  const controller = new AbortController();
  const reason = new Error("owner fenced");
  controller.abort(reason);
  await expect(renew(controller.signal)).rejects.toBe(reason);
  expect(mockSend).not.toHaveBeenCalled();
});
test("fencing during conflict backoff prevents the next write", async () => {
  const controller = new AbortController();
  const reason = new Error("owner fenced");
  mockSend.mockRejectedValue(conflict());
  jest
    .mocked(delay)
    .mockImplementationOnce(async (_milliseconds, _value, options) => {
      expect(options?.signal).toBe(controller.signal);
      controller.abort(reason);
      throw reason;
    });
  await expect(renew(controller.signal)).rejects.toBe(reason);
  expect(mockSend).toHaveBeenCalledTimes(1);
});
test("an owner fenced during the acknowledged write cannot report continuing ownership", async () => {
  const controller = new AbortController();
  const reason = new Error("owner fenced");
  mockSend.mockImplementationOnce(async (_command, options) => {
    expect(options.abortSignal).toBe(controller.signal);
    controller.abort(reason);
    return {};
  });
  await expect(renew(controller.signal)).rejects.toBe(reason);
  expect(mockSend).toHaveBeenCalledTimes(1);
});
