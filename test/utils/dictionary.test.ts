import { CONFIG_KEYS } from "../../src/config/keys";
import {
  buildDictionaryPromptLines,
  DEFAULT_DICTIONARY_BUDGETS,
  TRANSCRIPTION_KEYWORD_LIMIT,
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
      maxCharsTranscription: 200,
      maxCharsContext: 200,
    };

    const result = buildDictionaryPromptLines(entries, budgets);

    expect(result.transcriptionKeywords).toEqual(["Alpha"]);
    expect(result.contextLines).toEqual(["- Alpha: First"]);
    expect(result.usage.transcription.entries).toBe(1);
    expect(result.usage.context.entries).toBe(1);
  });

  test("resolveDictionaryBudgets clamps by caps and tier", () => {
    const valuesByKey: Record<string, unknown> = {
      [CONFIG_KEYS.dictionary.maxEntries]: 250,
      [CONFIG_KEYS.dictionary.maxEntriesPro]: 600,
      [CONFIG_KEYS.dictionary.maxEntriesCap]: 300,
      [CONFIG_KEYS.dictionary.maxCharsTranscription]: 1000,
      [CONFIG_KEYS.dictionary.maxCharsTranscriptionPro]: 5000,
      [CONFIG_KEYS.dictionary.maxCharsTranscriptionCap]: 2000,
      [CONFIG_KEYS.dictionary.maxCharsContext]: 3000,
      [CONFIG_KEYS.dictionary.maxCharsContextPro]: 15000,
      [CONFIG_KEYS.dictionary.maxCharsContextCap]: 8000,
    };

    const freeBudgets = resolveDictionaryBudgets(valuesByKey, "free");
    expect(freeBudgets).toEqual({
      maxEntries: 250,
      maxCharsTranscription: 1000,
      maxCharsContext: 3000,
    });

    const proBudgets = resolveDictionaryBudgets(valuesByKey, "pro");
    expect(proBudgets).toEqual({
      maxEntries: 300,
      maxCharsTranscription: 2000,
      maxCharsContext: 8000,
    });
  });

  test("transcription keywords are terms only, newest first, capped", () => {
    const entries = Array.from({ length: 30 }, (_, index) => ({
      term: `Term ${String(index).padStart(2, "0")}`,
      definition: "Never sent to speech recognition",
      updatedAt: `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
    }));

    const { transcriptionKeywords, usage } = buildDictionaryPromptLines(
      entries,
      DEFAULT_DICTIONARY_BUDGETS,
    );

    expect(transcriptionKeywords).toHaveLength(TRANSCRIPTION_KEYWORD_LIMIT);
    expect(transcriptionKeywords[0]).toBe("Term 29");
    expect(transcriptionKeywords.at(-1)).toBe("Term 10");
    expect(usage.transcription.entries).toBe(TRANSCRIPTION_KEYWORD_LIMIT);
  });

  test("transcription keywords skip terms the provider would reject", () => {
    const { transcriptionKeywords, contextLines } = buildDictionaryPromptLines(
      [{ term: "<Guild>" }, { term: "a>b" }, { term: "Kwylt\r\nRaid" }],
      DEFAULT_DICTIONARY_BUDGETS,
    );

    expect(transcriptionKeywords).toEqual(["Kwylt Raid"]);
    expect(contextLines).toHaveLength(3);
  });

  test("a zero transcription budget sends no keywords", () => {
    expect(
      buildDictionaryPromptLines([{ term: "Kwylt" }], {
        ...DEFAULT_DICTIONARY_BUDGETS,
        maxCharsTranscription: 0,
      }).transcriptionKeywords,
    ).toEqual([]);
  });
});
