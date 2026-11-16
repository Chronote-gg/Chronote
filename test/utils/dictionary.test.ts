import { CONFIG_KEYS } from "../../src/config/keys";
import {
  buildDictionaryPromptLines,
  normalizeDictionaryEntries,
  resolveDictionaryBudgets,
} from "../../src/utils/dictionary";

describe("dictionary utils", () => {
  test("normalizeDictionaryEntries dedupes case-insensitively and keeps newest", () => {
    const entries = [
      {
        term: "Chronote",
        definition: "Older definition",
        updatedAt: "2025-01-01T00:00:00.000Z",
      },
      {
        term: "chronote",
        definition: "Newest definition",
        updatedAt: "2025-01-02T00:00:00.000Z",
      },
      {
        term: "DynamoDB",
        definition: "AWS database",
        updatedAt: "2025-01-03T00:00:00.000Z",
      },
    ];

    const normalized = normalizeDictionaryEntries(entries);

    expect(normalized).toHaveLength(2);
    expect(normalized[0].term).toBe("DynamoDB");
    expect(normalized[1].term).toBe("chronote");
    expect(normalized[1].definition).toBe("Newest definition");
  });

  test("buildDictionaryPromptLines respects budgets and definitions", () => {
    const entries = [
      { term: "Alpha", definition: "First" },
      { term: "Beta", definition: "Second" },
    ];
    const budgets = {
      maxEntries: 1,
      maxCharsContext: 200,
    };

    const result = buildDictionaryPromptLines(entries, budgets);

    expect(result.contextLines).toEqual(["- Alpha: First"]);
    expect(result.usage.context.entries).toBe(1);
  });

  test("resolveDictionaryBudgets clamps by caps and tier", () => {
    const valuesByKey: Record<string, unknown> = {
      [CONFIG_KEYS.dictionary.maxEntries]: 250,
      [CONFIG_KEYS.dictionary.maxEntriesPro]: 600,
      [CONFIG_KEYS.dictionary.maxEntriesCap]: 300,
      [CONFIG_KEYS.dictionary.maxCharsContext]: 3000,
      [CONFIG_KEYS.dictionary.maxCharsContextPro]: 15000,
      [CONFIG_KEYS.dictionary.maxCharsContextCap]: 8000,
    };

    const freeBudgets = resolveDictionaryBudgets(valuesByKey, "free");
    expect(freeBudgets).toEqual({
      maxEntries: 250,
      maxCharsContext: 3000,
    });

    const proBudgets = resolveDictionaryBudgets(valuesByKey, "pro");
    expect(proBudgets).toEqual({
      maxEntries: 300,
      maxCharsContext: 8000,
    });
  });
});
