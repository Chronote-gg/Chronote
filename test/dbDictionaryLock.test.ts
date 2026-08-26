import { marshall } from "@aws-sdk/util-dynamodb";
import type { DictionaryEntry } from "../src/types/db";

const sendMock = jest.fn();

jest.mock("@aws-sdk/client-dynamodb", () => {
  const command = (name: string) =>
    class {
      input: unknown;
      constructor(input: unknown) {
        this.input = input;
      }
      static get name() {
        return name;
      }
    };

  class DynamoDBClient {
    send = sendMock;
    constructor() {}
  }

  return {
    DynamoDBClient,
    GetItemCommand: command("GetItemCommand"),
    PutItemCommand: command("PutItemCommand"),
    DeleteItemCommand: command("DeleteItemCommand"),
    QueryCommand: command("QueryCommand"),
    ScanCommand: command("ScanCommand"),
    UpdateItemCommand: command("UpdateItemCommand"),
  };
});

const conditionalFailure = () => ({
  name: "ConditionalCheckFailedException",
});

const entry: DictionaryEntry = {
  guildId: "guild-1",
  termKey: "apollo",
  term: "Apollo",
  createdAt: "2026-01-01T00:00:00.000Z",
  createdBy: "user-1",
  updatedAt: "2026-01-01T00:00:00.000Z",
  updatedBy: "user-1",
};

describe("dictionary write lock", () => {
  beforeEach(() => {
    sendMock.mockReset();
  });

  test("does not put an entry after ownership is lost before commit", async () => {
    sendMock
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        Item: marshall({ sid: "dictionaryRevision#guild-1", revision: 0 }),
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(conditionalFailure())
      .mockResolvedValueOnce({});
    const { writeDictionaryEntry } = await import("../src/db");

    await expect(writeDictionaryEntry(entry, null, 0)).resolves.toBe(false);

    expect(
      sendMock.mock.calls.map(([command]) => command.constructor.name),
    ).not.toContain("PutItemCommand");
  });

  test("treats release failures as best effort", async () => {
    sendMock.mockRejectedValueOnce(new Error("temporary network failure"));
    const warning = jest.spyOn(console, "warn").mockImplementation();
    const { releaseDictionaryLock } = await import("../src/db");

    await expect(
      releaseDictionaryLock("guild-1", "lock-token"),
    ).resolves.toBeUndefined();
    expect(warning).toHaveBeenCalledWith(
      "Failed releasing dictionary lock; lease will expire",
      expect.objectContaining({
        guildId: "guild-1",
        error: expect.any(Error),
      }),
    );
  });
});
