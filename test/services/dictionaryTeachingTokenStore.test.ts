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

describe("dictionaryTeachingTokenStore DynamoDB parsing", () => {
  const originalMockMode = process.env.MOCK_MODE;

  const loadStore = async () => {
    jest.resetModules();
    sendMock.mockReset();
    process.env.MOCK_MODE = "false";
    const { createDictionaryTeachingTokenStore } =
      await import("../../src/services/dictionaryTeachingTokenStore");
    return createDictionaryTeachingTokenStore({ maxPending: 200 });
  };

  afterAll(() => {
    process.env.MOCK_MODE = originalMockMode;
  });

  test("corrupt draft JSON returns null and deletes the item", async () => {
    const store = await loadStore();
    const token = "token-1";
    sendMock
      .mockResolvedValueOnce({
        Item: marshall({
          sid: `dictionaryTeachingDraft#${token}`,
          kind: "dictionaryTeachingDraft",
          data: "{not json",
          expiresAt: Math.floor((Date.now() + 60_000) / 1_000),
        }),
      })
      .mockResolvedValueOnce({});

    await expect(store.getDraft(token)).resolves.toBeNull();
    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(sendMock.mock.calls[1][0].constructor.name).toBe(
      "DeleteItemCommand",
    );
  });

  test("expired correction context returns null and deletes the item", async () => {
    const store = await loadStore();
    const token = "token-2";
    sendMock
      .mockResolvedValueOnce({
        Item: marshall({
          sid: `dictionaryTeachingContext#${token}`,
          kind: "dictionaryTeachingContext",
          data: JSON.stringify({
            guildId: "guild-1",
            requesterId: "user-1",
            expiresAtMs: Date.now() - 1,
            context: {
              source: "notes_correction",
              correctionId: "correction-1",
              notesDiff: "+ Jon Smythe",
              transcriptExcerpt: "Jon Smythe joined the call.",
            },
          }),
          expiresAt: Math.floor((Date.now() + 60_000) / 1_000),
        }),
      })
      .mockResolvedValueOnce({});

    await expect(store.getContext(token)).resolves.toBeNull();
    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(sendMock.mock.calls[1][0].constructor.name).toBe(
      "DeleteItemCommand",
    );
  });

  test("returns a valid draft and preserves only validated fields", async () => {
    const store = await loadStore();
    const token = "token-3";
    const record = {
      guildId: "guild-1",
      requesterId: "user-1",
      expiresAtMs: Date.now() + 60_000,
      source: "settings",
      drafts: [
        {
          draftId: "draft-1",
          preferredTerm: "Jon Smythe",
          observedForms: ["John Smith"],
          description: "Apollo collaborator",
          ambiguity: null,
          evidence: [{ source: "instruction", quote: "Jon Smythe" }],
          action: "create",
        },
      ],
      model: {
        model: "gpt-5-mini",
        promptName: "chronote-dictionary-teaching-chat",
        promptVersion: 1,
      },
      ignored: "not returned",
    };
    sendMock.mockResolvedValueOnce({
      Item: marshall({
        sid: `dictionaryTeachingDraft#${token}`,
        kind: "dictionaryTeachingDraft",
        data: JSON.stringify(record),
        expiresAt: Math.floor(record.expiresAtMs / 1_000),
      }),
    });

    await expect(store.getDraft(token)).resolves.toEqual({
      guildId: record.guildId,
      requesterId: record.requesterId,
      expiresAtMs: record.expiresAtMs,
      source: record.source,
      drafts: record.drafts,
      model: record.model,
    });
  });
});
