import { config } from "../services/configService";
import {
  acquireDictionaryLock,
  deleteDictionaryEntry,
  getDictionaryRevision,
  getDictionaryEntry,
  listDictionaryEntries,
  releaseDictionaryLock,
  writeDictionaryEntry,
} from "../db";
import type { DictionaryEntry } from "../types/db";
import { getMockStore } from "./mockStore";

export type DictionaryRepository = {
  listByGuild: (guildId: string) => Promise<DictionaryEntry[]>;
  get: (
    guildId: string,
    termKey: string,
  ) => Promise<DictionaryEntry | undefined>;
  write: (
    entry: DictionaryEntry,
    expectedUpdatedAt?: string | null,
    expectedRevision?: number,
  ) => Promise<boolean>;
  listSnapshotByGuild: (guildId: string) => Promise<{
    entries: DictionaryEntry[];
    revision: number;
  }>;
  remove: (guildId: string, termKey: string) => Promise<void>;
};

const realRepository: DictionaryRepository = {
  listByGuild: listDictionaryEntries,
  get: getDictionaryEntry,
  write: writeDictionaryEntry,
  async listSnapshotByGuild(guildId) {
    const lockToken = await acquireDictionaryLock(guildId);
    if (!lockToken) {
      throw new Error("Dictionary changed while creating a review snapshot.");
    }
    try {
      const entries = await listDictionaryEntries(guildId, true);
      const revision = await getDictionaryRevision(guildId);
      return { entries, revision };
    } finally {
      await releaseDictionaryLock(guildId, lockToken);
    }
  },
  remove: deleteDictionaryEntry,
};

const mockRepository: DictionaryRepository = {
  async listByGuild(guildId) {
    return getMockStore().dictionaryEntriesByGuild.get(guildId) ?? [];
  },
  async get(guildId, termKey) {
    const entries = getMockStore().dictionaryEntriesByGuild.get(guildId) ?? [];
    return entries.find((entry) => entry.termKey === termKey);
  },
  async write(entry, expectedUpdatedAt, expectedRevision) {
    const store = getMockStore();
    const entries = store.dictionaryEntriesByGuild.get(entry.guildId) ?? [];
    const index = entries.findIndex((item) => item.termKey === entry.termKey);
    const existing = index >= 0 ? entries[index] : undefined;
    const currentRevision =
      store.dictionaryRevisionByGuild.get(entry.guildId) ?? 0;
    if (
      (expectedRevision !== undefined &&
        expectedRevision !== currentRevision) ||
      (expectedUpdatedAt === null && existing) ||
      (typeof expectedUpdatedAt === "string" &&
        existing?.updatedAt !== expectedUpdatedAt)
    ) {
      return false;
    }
    if (index >= 0) {
      entries[index] = entry;
    } else {
      entries.push(entry);
    }
    store.dictionaryEntriesByGuild.set(entry.guildId, entries);
    store.dictionaryRevisionByGuild.set(entry.guildId, currentRevision + 1);
    return true;
  },
  async listSnapshotByGuild(guildId) {
    const store = getMockStore();
    return {
      entries: store.dictionaryEntriesByGuild.get(guildId) ?? [],
      revision: store.dictionaryRevisionByGuild.get(guildId) ?? 0,
    };
  },
  async remove(guildId, termKey) {
    const store = getMockStore();
    const entries = store.dictionaryEntriesByGuild.get(guildId) ?? [];
    store.dictionaryEntriesByGuild.set(
      guildId,
      entries.filter((entry) => entry.termKey !== termKey),
    );
    const currentRevision = store.dictionaryRevisionByGuild.get(guildId) ?? 0;
    store.dictionaryRevisionByGuild.set(guildId, currentRevision + 1);
  },
};

export function getDictionaryRepository(): DictionaryRepository {
  return config.mock.enabled ? mockRepository : realRepository;
}
