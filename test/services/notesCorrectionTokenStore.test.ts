import { marshall } from "@aws-sdk/util-dynamodb";

const sendMock = jest.fn();

jest.mock("@aws-sdk/client-dynamodb", () => {
  class GetItemCommand {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }

  class PutItemCommand {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }

  class DeleteItemCommand {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }

  class DynamoDBClient {
    send = sendMock;
    constructor() {}
  }

  return {
    DynamoDBClient,
    GetItemCommand,
    PutItemCommand,
    DeleteItemCommand,
  };
});

describe("notesCorrectionTokenStore dynamo parsing", () => {
  const originalMockMode = process.env.MOCK_MODE;

  const loadStore = async () => {
    jest.resetModules();
    sendMock.mockReset();
    process.env.MOCK_MODE = "false";
    const { createNotesCorrectionTokenStore } =
      await import("../../src/services/notesCorrectionTokenStore");
    return createNotesCorrectionTokenStore({ maxPending: 200 });
  };

  afterAll(() => {
    process.env.MOCK_MODE = originalMockMode;
  });

  test("corrupt JSON returns null and deletes item", async () => {
    const store = await loadStore();
    const token = "token-1";

    const item = {
      sid: `notesCorrection#${token}`,
      kind: "notesCorrectionToken",
      data: "{not json",
      expiresAt: Math.floor((Date.now() + 60_000) / 1000),
    };

    sendMock
      .mockResolvedValueOnce({ Item: marshall(item) })
      .mockResolvedValueOnce({});

    await expect(store.get(token)).resolves.toBeNull();
    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(sendMock.mock.calls[1][0].constructor.name).toBe(
      "DeleteItemCommand",
    );
  });

  test("JSON that parses to null returns null and deletes item", async () => {
    const store = await loadStore();
    const token = "token-2";

    const item = {
      sid: `notesCorrection#${token}`,
      kind: "notesCorrectionToken",
      data: "null",
      expiresAt: Math.floor((Date.now() + 60_000) / 1000),
    };

    sendMock
      .mockResolvedValueOnce({ Item: marshall(item) })
      .mockResolvedValueOnce({});

    await expect(store.get(token)).resolves.toBeNull();
    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(sendMock.mock.calls[1][0].constructor.name).toBe(
      "DeleteItemCommand",
    );
  });

  test("wrong-shape JSON returns null and deletes item", async () => {
    const store = await loadStore();
    const token = "token-3";

    const item = {
      sid: `notesCorrection#${token}`,
      kind: "notesCorrectionToken",
      data: JSON.stringify({ guildId: "guild-1" }),
      expiresAt: Math.floor((Date.now() + 60_000) / 1000),
    };

    sendMock
      .mockResolvedValueOnce({ Item: marshall(item) })
      .mockResolvedValueOnce({});

    await expect(store.get(token)).resolves.toBeNull();
    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(sendMock.mock.calls[1][0].constructor.name).toBe(
      "DeleteItemCommand",
    );
  });

  test("expired record returns null and deletes item", async () => {
    const store = await loadStore();
    const token = "token-4";

    const record = {
      guildId: "guild-1",
      meetingId: "channel-1#2025-01-01T00:00:00.000Z",
      expiresAtMs: Date.now() - 1,
      notesVersion: 1,
      requesterId: "user-1",
      newNotes: "New notes",
      suggestion: {
        userId: "user-1",
        text: "Fix it",
        createdAt: new Date().toISOString(),
      },
    };

    const item = {
      sid: `notesCorrection#${token}`,
      kind: "notesCorrectionToken",
      data: JSON.stringify(record),
      expiresAt: Math.floor((Date.now() + 60_000) / 1000),
    };

    sendMock
      .mockResolvedValueOnce({ Item: marshall(item) })
      .mockResolvedValueOnce({});

    await expect(store.get(token)).resolves.toBeNull();
    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(sendMock.mock.calls[1][0].constructor.name).toBe(
      "DeleteItemCommand",
    );
  });
});
