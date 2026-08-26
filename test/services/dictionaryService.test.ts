import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  jest,
} from "@jest/globals";
import {
  clearDictionaryEntriesService,
  listDictionaryEntriesService,
  removeDictionaryEntryService,
  upsertDictionaryEntryService,
} from "../../src/services/dictionaryService";
import { getMockStore, resetMockStore } from "../../src/repositories/mockStore";
import {
  DICTIONARY_DEFINITION_MAX_LENGTH,
  DICTIONARY_TERM_MAX_LENGTH,
} from "../../src/utils/dictionary";

describe("dictionaryService", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2025-01-01T00:00:00.000Z"));
    resetMockStore();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test("listDictionaryEntriesService sorts by updatedAt then term", async () => {
    const store = getMockStore();
    const guildId = "guild-1";
    store.dictionaryEntriesByGuild.set(guildId, [
      {
        guildId,
        termKey: "bravo",
        term: "Bravo",
        definition: "B",
        createdAt: "2025-01-01T00:00:00.000Z",
        createdBy: "user-1",
        updatedAt: "2025-01-02T00:00:00.000Z",
        updatedBy: "user-1",
      },
      {
        guildId,
        termKey: "alpha",
        term: "Alpha",
        definition: "A",
        createdAt: "2025-01-01T00:00:00.000Z",
        createdBy: "user-1",
        updatedAt: "2025-01-02T00:00:00.000Z",
        updatedBy: "user-1",
      },
      {
        guildId,
        termKey: "charlie",
        term: "Charlie",
        definition: "C",
        createdAt: "2025-01-01T00:00:00.000Z",
        createdBy: "user-1",
        updatedAt: "2025-01-03T00:00:00.000Z",
        updatedBy: "user-1",
      },
    ]);

    const result = await listDictionaryEntriesService(guildId);
    expect(result.map((entry) => entry.term)).toEqual([
      "Charlie",
      "Alpha",
      "Bravo",
    ]);
  });

  test("upsertDictionaryEntryService normalizes input and creates entry", async () => {
    const entry = await upsertDictionaryEntryService({
      guildId: "guild-1",
      term: "  Chronote  ",
      definition: "  Meeting notes bot ",
      userId: "user-1",
    });

    expect(entry.term).toBe("Chronote");
    expect(entry.termKey).toBe("chronote");
    expect(entry.definition).toBe("Meeting notes bot");
    expect(entry.createdBy).toBe("user-1");
    expect(entry.updatedBy).toBe("user-1");
    expect(entry.createdAt).toBe("2025-01-01T00:00:00.000Z");
    expect(entry.updatedAt).toBe("2025-01-01T00:00:00.000Z");
  });

  test("upsertDictionaryEntryService preserves created fields on update", async () => {
    const store = getMockStore();
    store.dictionaryEntriesByGuild.set("guild-1", [
      {
        guildId: "guild-1",
        termKey: "chronote",
        term: "Chronote",
        definition: "Old definition",
        createdAt: "2025-01-01T00:00:00.000Z",
        createdBy: "user-1",
        updatedAt: "2025-01-01T00:00:00.000Z",
        updatedBy: "user-1",
      },
    ]);

    jest.setSystemTime(new Date("2025-01-02T00:00:00.000Z"));

    const entry = await upsertDictionaryEntryService({
      guildId: "guild-1",
      term: "Chronote",
      definition: "New definition",
      userId: "user-2",
    });

    expect(entry.createdAt).toBe("2025-01-01T00:00:00.000Z");
    expect(entry.createdBy).toBe("user-1");
    expect(entry.updatedAt).toBe("2025-01-02T00:00:00.000Z");
    expect(entry.updatedBy).toBe("user-2");
    expect(entry.definition).toBe("New definition");
  });

  test("stores approved observed forms and preserves them during manual edits", async () => {
    const lastTeaching = {
      method: "llm_assisted" as const,
      source: "settings" as const,
      model: "gpt-5-mini",
      promptName: "chronote-dictionary-teaching-chat",
      promptVersion: 1,
      approvedBy: "user-1",
      approvedAt: "2025-01-01T00:00:00.000Z",
    };
    await upsertDictionaryEntryService({
      guildId: "guild-1",
      term: "Jon Smythe",
      definition: "Apollo contact",
      observedForms: [" John Smith ", "John Smith", "Jon Smith"],
      lastTeaching,
      userId: "user-1",
    });

    const updated = await upsertDictionaryEntryService({
      guildId: "guild-1",
      term: "Jon Smythe",
      definition: "Apollo account manager",
      userId: "user-2",
    });

    expect(updated.observedForms).toEqual(["John Smith", "Jon Smith"]);
    expect(updated.lastTeaching).toEqual(lastTeaching);
    expect(updated.definition).toBe("Apollo account manager");
  });

  test("upsertDictionaryEntryService validates term and definition length", async () => {
    await expect(
      upsertDictionaryEntryService({
        guildId: "guild-1",
        term: "   ",
        definition: "Definition",
        userId: "user-1",
      }),
    ).rejects.toThrow("Dictionary term cannot be empty.");

    await expect(
      upsertDictionaryEntryService({
        guildId: "guild-1",
        term: "x".repeat(DICTIONARY_TERM_MAX_LENGTH + 1),
        definition: "Definition",
        userId: "user-1",
      }),
    ).rejects.toThrow("Dictionary term must be");

    await expect(
      upsertDictionaryEntryService({
        guildId: "guild-1",
        term: "Valid",
        definition: "x".repeat(DICTIONARY_DEFINITION_MAX_LENGTH + 1),
        userId: "user-1",
      }),
    ).rejects.toThrow("Dictionary definition must be");
  });

  test("removeDictionaryEntryService deletes entries", async () => {
    await upsertDictionaryEntryService({
      guildId: "guild-1",
      term: "Chronote",
      definition: "Meeting notes bot",
      userId: "user-1",
    });

    await removeDictionaryEntryService({
      guildId: "guild-1",
      term: "Chronote",
    });

    const entries = await listDictionaryEntriesService("guild-1");
    expect(entries).toHaveLength(0);
  });

  test("clearDictionaryEntriesService deletes all entries", async () => {
    await upsertDictionaryEntryService({
      guildId: "guild-1",
      term: "Chronote",
      definition: "Meeting notes bot",
      userId: "user-1",
    });
    await upsertDictionaryEntryService({
      guildId: "guild-1",
      term: "Discord",
      definition: "Voice app",
      userId: "user-1",
    });

    await clearDictionaryEntriesService("guild-1");

    const entries = await listDictionaryEntriesService("guild-1");
    expect(entries).toHaveLength(0);
  });
});
