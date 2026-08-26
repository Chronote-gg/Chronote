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
