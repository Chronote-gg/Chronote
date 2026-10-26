import {
  parseDictionaryTeachingResponse,
  selectDictionaryTeachingConflicts,
} from "../../src/services/dictionaryTeachingService";
import type { DictionaryEntry } from "../../src/types/db";

const entry = (
  term: string,
  definition?: string,
  observedForms?: string[],
): DictionaryEntry => ({
  guildId: "guild-1",
  termKey: term.toLowerCase(),
  term,
  definition,
  observedForms,
  createdAt: "2026-01-01T00:00:00.000Z",
  createdBy: "user-1",
  updatedAt: "2026-01-01T00:00:00.000Z",
  updatedBy: "user-1",
});

describe("dictionaryTeachingService", () => {
  test("parses an explicit correction into an editable new-term draft", () => {
    const instruction =
      "It wrote John Smith, but his real name is Jon Smythe. He works with us on Apollo.";
    const result = parseDictionaryTeachingResponse({
      raw: JSON.stringify({
        drafts: [
          {
            preferredTerm: "Jon Smythe",
            observedForms: ["John Smith"],
            description: "Works with the team on Apollo",
            ambiguity: null,
            evidence: [
              { source: "instruction", quote: "his real name is Jon Smythe" },
            ],
          },
        ],
      }),
      instruction,
      existingEntries: [],
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      preferredTerm: "Jon Smythe",
      observedForms: ["John Smith"],
      description: "Works with the team on Apollo",
      ambiguity: null,
      action: "create",
    });
    expect(result[0].evidence).toEqual([
      { source: "instruction", quote: "his real name is Jon Smythe" },
    ]);
  });

  test("requires confirmation when the model invents a preferred spelling", () => {
    const result = parseDictionaryTeachingResponse({
      raw: JSON.stringify({
        drafts: [
          {
            preferredTerm: "Jon Smythe",
            observedForms: ["John Smith", "Invented Form"],
            description: null,
            ambiguity: null,
            evidence: [],
          },
        ],
      }),
      instruction: "Chronote wrote John Smith, but that is not right.",
      existingEntries: [],
    });

    expect(result[0]).toMatchObject({
      preferredTerm: null,
      observedForms: ["John Smith"],
      action: "needs_input",
      ambiguity: "Confirm the exact spelling Chronote should use.",
    });
  });

  test("does not ground a short spelling inside an unrelated word", () => {
    const result = parseDictionaryTeachingResponse({
      raw: JSON.stringify({
        drafts: [
          {
            preferredTerm: "Ann",
            observedForms: [],
            description: null,
            ambiguity: null,
            evidence: [],
          },
        ],
      }),
      instruction: "Planning starts after lunch.",
      existingEntries: [],
    });

    expect(result[0]).toMatchObject({
      preferredTerm: null,
      action: "needs_input",
      ambiguity: "Confirm the exact spelling Chronote should use.",
    });
  });

  test("flags an observed form that is already another exact entry", () => {
    const existing = entry("John Smith", "A different person");
    const result = parseDictionaryTeachingResponse({
      raw: JSON.stringify({
        drafts: [
          {
            preferredTerm: "Jon Smythe",
            observedForms: ["John Smith"],
            description: "Apollo contact",
            ambiguity: null,
            evidence: [],
          },
        ],
      }),
      instruction:
        "Chronote wrote John Smith. The exact name is Jon Smythe, our Apollo contact.",
      existingEntries: [existing],
    });

    expect(result[0].action).toBe("conflict");
    expect(result[0].existingEntry).toEqual(existing);
  });

  test("flags a preferred term that is already another entry's observed form", () => {
    const existing = entry("Jonathan Smythe", "Apollo contact", ["Jon Smythe"]);
    const result = parseDictionaryTeachingResponse({
      raw: JSON.stringify({
        drafts: [
          {
            preferredTerm: "Jon Smythe",
            observedForms: ["John Smith"],
            description: "Apollo collaborator",
            evidence: [{ source: "instruction", quote: "Jon Smythe" }],
          },
        ],
      }),
      instruction: "John Smith should be Jon Smythe.",
      existingEntries: [existing],
    });

    expect(result[0]).toMatchObject({
      action: "conflict",
      existingEntry: { term: "Jonathan Smythe" },
    });
  });

  test("deduplicates repeated preferred terms from the model", () => {
    const result = parseDictionaryTeachingResponse({
      raw: JSON.stringify({
        drafts: [
          { preferredTerm: "Jon Smythe" },
          { preferredTerm: "jon smythe" },
        ],
      }),
      instruction: "The exact name is Jon Smythe.",
      existingEntries: [],
    });

    expect(result).toHaveLength(1);
  });

  test("ranks same-server entries by lexical relevance", () => {
    const entries = [
      entry("DynamoDB", "AWS database"),
      entry("Jon Smythe", "Apollo account manager", ["John Smith"]),
      entry("Rekordbox", "DJ library"),
    ];

    const result = selectDictionaryTeachingConflicts(
      entries,
      "John Smith should be Jon Smythe from Apollo",
    );

    expect(result[0].term).toBe("Jon Smythe");
    expect(result.map(({ term }) => term)).not.toContain("Rekordbox");
  });
});

const loadGeneration = async (response: object) => {
  jest.resetModules();
  const responsesCreate = jest.fn().mockResolvedValue(response);
  const createOpenAIClient = jest.fn(() => ({
    responses: { create: responsesCreate },
  }));
  jest.doMock("../../src/services/openaiClient", () => ({
    createOpenAIClient,
  }));
  jest.doMock("../../src/services/langfusePromptService", () => ({
    getLangfuseChatPrompt: jest.fn(async () => ({
      messages: [{ role: "user", content: "Teach the corrected spelling." }],
      langfusePrompt: {
        name: "dictionary-teaching",
        version: 7,
        isFallback: false,
      },
    })),
  }));
  const { generateDictionaryTeachingDrafts } =
    await import("../../src/services/dictionaryTeachingService");
  return { generateDictionaryTeachingDrafts, responsesCreate };
};

test("generates grounded dictionary drafts through Responses", async () => {
  const { generateDictionaryTeachingDrafts, responsesCreate } =
    await loadGeneration({
      status: "completed",
      output_text: JSON.stringify({
        drafts: [
          {
            preferredTerm: "Jon Smythe",
            observedForms: ["John Smith"],
          },
        ],
      }),
      output: [],
    });
  const result = await generateDictionaryTeachingDrafts({
    guildId: "guild-1",
    userId: "user-1",
    instruction: "John Smith should be Jon Smythe.",
    existingEntries: [],
  });

  expect(result.drafts).toHaveLength(1);
  expect(result.drafts[0]).toMatchObject({
    preferredTerm: "Jon Smythe",
    observedForms: ["John Smith"],
    action: "create",
  });
  expect(result.model).toMatchObject({
    model: "gpt-5-mini",
    promptVersion: 7,
  });
  expect(responsesCreate).toHaveBeenCalledWith(
    expect.objectContaining({
      model: "gpt-5-mini",
      input: [{ role: "user", content: "Teach the corrected spelling." }],
      reasoning: { effort: "low" },
      text: { format: { type: "json_object" } },
      max_output_tokens: 8_000,
      store: false,
    }),
    undefined,
  );
});

test("rejects incomplete dictionary drafts before parsing partial JSON", async () => {
  const { generateDictionaryTeachingDrafts } = await loadGeneration({
    status: "incomplete",
    incomplete_details: { reason: "max_output_tokens" },
    output_text: '{"drafts":[',
    output: [],
  });

  await expect(
    generateDictionaryTeachingDrafts({
      guildId: "guild-1",
      userId: "user-1",
      instruction: "John Smith should be Jon Smythe.",
      existingEntries: [],
    }),
  ).rejects.toThrow(/incomplete/i);
});
