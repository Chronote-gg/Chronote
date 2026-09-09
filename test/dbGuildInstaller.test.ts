import {
  DeleteItemCommand,
  DynamoDBClient,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import {
  deleteGuildInstaller,
  writeGuildInstallerIfAbsent,
  writeGuildInstallerForMembership,
} from "../src/db";

const sendMock = jest.spyOn(DynamoDBClient.prototype, "send");

beforeEach(() => sendMock.mockReset());
afterAll(() => sendMock.mockRestore());

const installer = {
  guildId: "guild-1",
  installerId: "user-1",
  installedAt: "2026-08-28T12:00:00.000Z",
};
const removedAt = "2026-08-29T12:00:00.000Z";

test("initial installation remains conditional so reauthorization cannot replace it", async () => {
  sendMock.mockResolvedValueOnce({} as never);
  await expect(writeGuildInstallerIfAbsent(installer)).resolves.toBe(true);
  expect(sendMock).toHaveBeenCalledWith(expect.any(PutItemCommand));
  expect(sendMock.mock.calls[0][0].input).toEqual(
    expect.objectContaining({
      Item: marshall(installer),
      ConditionExpression: "attribute_not_exists(guildId)",
    }),
  );
});

test("removal is limited to installations predating the removal event", async () => {
  sendMock.mockResolvedValueOnce({} as never);
  await deleteGuildInstaller(installer.guildId, removedAt);
  expect(sendMock).toHaveBeenCalledWith(expect.any(DeleteItemCommand));
  expect(sendMock.mock.calls[0][0].input).toEqual(
    expect.objectContaining({
      Key: marshall({ guildId: installer.guildId }),
      ConditionExpression: "installedAt <= :removedAt",
      ExpressionAttributeValues: marshall({ ":removedAt": removedAt }),
    }),
  );
});

test("a missing record or newer installation makes removal a no-op", async () => {
  sendMock.mockRejectedValueOnce({
    name: "ConditionalCheckFailedException",
  } as never);
  await expect(
    deleteGuildInstaller(installer.guildId, removedAt),
  ).resolves.toBeUndefined();
});

test("storage failures propagate to the removal handler", async () => {
  const error = new Error("storage unavailable");
  sendMock.mockRejectedValueOnce(error as never);
  await expect(deleteGuildInstaller(installer.guildId, removedAt)).rejects.toBe(
    error,
  );
});

test("membership replacement checks the stored installation atomically", async () => {
  sendMock.mockResolvedValueOnce({} as never);
  await expect(
    writeGuildInstallerForMembership(installer, removedAt),
  ).resolves.toBe(true);
  expect(sendMock).toHaveBeenCalledWith(expect.any(PutItemCommand));
  expect(sendMock.mock.calls[0][0].input).toEqual(
    expect.objectContaining({
      Item: marshall(installer),
      ConditionExpression:
        "attribute_not_exists(guildId) OR installedAt < :joinedAt",
      ExpressionAttributeValues: marshall({ ":joinedAt": removedAt }),
    }),
  );
});

test("a competing current membership writer wins without being overwritten", async () => {
  sendMock.mockRejectedValueOnce({
    name: "ConditionalCheckFailedException",
  } as never);
  await expect(
    writeGuildInstallerForMembership(installer, removedAt),
  ).resolves.toBe(false);
  expect(sendMock).toHaveBeenCalledTimes(1);
});

test("membership write storage failures propagate", async () => {
  const error = new Error("storage unavailable");
  sendMock.mockRejectedValueOnce(error as never);
  await expect(
    writeGuildInstallerForMembership(installer, removedAt),
  ).rejects.toBe(error);
});
