/** @jest-environment node */
jest.mock("dotenv", () => ({ config: () => ({ parsed: {} }) }));
const mockSend = jest.fn();
jest.mock("@aws-sdk/client-dynamodb", () => ({
  ...jest.requireActual("@aws-sdk/client-dynamodb"),
  DynamoDBClient: jest.fn(() => ({ send: mockSend })),
}));
jest.mock("node:timers/promises", () => ({
  setTimeout: jest.fn(async (milliseconds: number) => {
    jest.setSystemTime(Date.now() + milliseconds);
  }),
}));
import {
  ConditionalCheckFailedException,
  TransactionConflictException,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { setTimeout as delay } from "node:timers/promises";
import { renewActiveMeetingLease } from "../../src/db";
import { config } from "../../src/services/configService";
const start = Date.parse("2026-10-30T12:00:00.950Z");
const conflict = () => new TransactionConflictException({ $metadata: {} });
const stale = () => new ConditionalCheckFailedException({ $metadata: {} });
const ownership = {
  executionVersion: 1,
  sessionMode: "meeting",
} satisfies NonNullable<Parameters<typeof renewActiveMeetingLease>[7]>;
const renew = (signal?: AbortSignal) =>
  renewActiveMeetingLease(
    "guild",
    "meeting",
    "owner",
    Math.floor(start / 1000) + 30,
    new Date(start).toISOString(),
    Math.floor(start / 1000) + 150,
    { status: "in_progress" },
    ownership,
    signal,
  );
beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(start);
  config.mock.enabled = false;
  mockSend.mockReset();
  jest.mocked(delay).mockClear();
});
afterEach(() => {
  config.mock.enabled = true;
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
  expect(next.ConditionExpression).toBe(
    "#leaseExpiresAt >= :now AND #meetingId = :meetingId AND #ownerInstanceId = :ownerInstanceId AND #executionVersion = :executionVersion AND sessionMode = :sessionMode",
  );
  expect(next.ExpressionAttributeValues).toMatchObject({
    ":meetingId": { S: "meeting" },
    ":ownerInstanceId": { S: "owner" },
    ":executionVersion": { N: "1" },
    ":sessionMode": { S: "meeting" },
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
test.each([
  undefined,
  { executionVersion: 1, sessionMode: "tts_only" } satisfies NonNullable<
    Parameters<typeof renewActiveMeetingLease>[7]
  >,
])(
  "legacy and TTS renewal retain their exact ownership conditions: %p",
  async (owner) => {
    mockSend.mockRejectedValueOnce(conflict()).mockResolvedValueOnce({});
    await expect(
      renewActiveMeetingLease(
        "guild",
        "meeting",
        "owner",
        Math.floor(start / 1000) + 30,
        new Date(start).toISOString(),
        Math.floor(start / 1000) + 150,
        { status: "in_progress" },
        owner,
      ),
    ).resolves.toBe(true);
    const input: UpdateItemCommand["input"] = mockSend.mock.calls[1][0].input;
    expect(input.ConditionExpression).toContain(
      owner
        ? "#executionVersion = :executionVersion AND sessionMode = :sessionMode"
        : "attribute_not_exists(#executionVersion)",
    );
    if (owner)
      expect(input.ExpressionAttributeValues?.[":sessionMode"]).toEqual({
        S: "tts_only",
      });
  },
);
