import type {
  DictionaryEntry,
  DictionaryTeachingProvenance,
} from "../types/db";
import { getDictionaryRepository } from "../repositories/dictionaryRepository";
import {
  buildDictionaryTermKey,
  DICTIONARY_DEFINITION_MAX_LENGTH,
  DICTIONARY_TERM_MAX_LENGTH,
  normalizeDictionaryDefinition,
  normalizeDictionaryObservedForms,
  normalizeDictionaryTerm,
} from "../utils/dictionary";
import { captureEvent } from "./analyticsService";

const sortEntries = (entries: DictionaryEntry[]) =>
  [...entries].sort((a, b) => {
    if (a.updatedAt !== b.updatedAt) {
      return b.updatedAt.localeCompare(a.updatedAt);
    }
    return a.term.localeCompare(b.term);
  });

export const DICTIONARY_REVIEW_CONFLICT_MESSAGE =
  "This dictionary entry changed after the proposal was reviewed. Analyze it again before saving.";

export async function listDictionaryEntriesService(
  guildId: string,
): Promise<DictionaryEntry[]> {
  const entries = await getDictionaryRepository().listByGuild(guildId);
  return sortEntries(entries);
}

export async function getDictionarySnapshotService(guildId: string): Promise<{
  entries: DictionaryEntry[];
  revision: number;
}> {
  const snapshot = await getDictionaryRepository().listSnapshotByGuild(guildId);
  return {
    entries: sortEntries(snapshot.entries),
    revision: snapshot.revision,
  };
}

export async function upsertDictionaryEntryService(params: {
  guildId: string;
  term: string;
  definition?: string | null;
  observedForms?: string[];
  lastTeaching?: DictionaryTeachingProvenance;
  userId: string;
  captureAnalytics?: boolean;
  expectedUpdatedAt?: string | null;
  expectedRevision?: number;
}): Promise<DictionaryEntry> {
  const term = normalizeDictionaryTerm(params.term);
  if (!term) {
    throw new Error("Dictionary term cannot be empty.");
  }
  if (term.length > DICTIONARY_TERM_MAX_LENGTH) {
    throw new Error(
      `Dictionary term must be ${DICTIONARY_TERM_MAX_LENGTH} characters or less.`,
    );
  }
  const definition = normalizeDictionaryDefinition(params.definition);
  if (definition && definition.length > DICTIONARY_DEFINITION_MAX_LENGTH) {
    throw new Error(
      `Dictionary definition must be ${DICTIONARY_DEFINITION_MAX_LENGTH} characters or less.`,
    );
  }

  const repository = getDictionaryRepository();
  const termKey = buildDictionaryTermKey(term);
  const existing = await repository.get(params.guildId, termKey);
  const now = new Date().toISOString();
  const observedForms =
    params.observedForms === undefined
      ? existing?.observedForms
      : normalizeDictionaryObservedForms(params.observedForms);
  const entry: DictionaryEntry = {
    guildId: params.guildId,
    termKey,
    term,
    definition,
    observedForms,
    lastTeaching: params.lastTeaching ?? existing?.lastTeaching,
    createdAt: existing?.createdAt ?? now,
    createdBy: existing?.createdBy ?? params.userId,
    updatedAt: now,
    updatedBy: params.userId,
  };

  const written = await repository.write(
    entry,
    params.expectedUpdatedAt,
    params.expectedRevision,
  );
  if (!written) {
    throw new Error(DICTIONARY_REVIEW_CONFLICT_MESSAGE);
  }
  if (params.captureAnalytics !== false) {
    // The term itself is user content, so only its shape is reported.
    captureEvent("dictionary_updated", {
      userId: params.userId,
      guildId: params.guildId,
      properties: {
        action: existing ? "updated" : "added",
        has_definition: Boolean(definition),
        term_length: term.length,
      },
    });
  }
  return entry;
}

export async function removeDictionaryEntryService(params: {
  guildId: string;
  term: string;
}): Promise<void> {
  const term = normalizeDictionaryTerm(params.term);
  if (!term) {
    throw new Error("Dictionary term cannot be empty.");
  }
  const termKey = buildDictionaryTermKey(term);
  await getDictionaryRepository().remove(params.guildId, termKey);
}

export async function clearDictionaryEntriesService(
  guildId: string,
): Promise<void> {
  const repository = getDictionaryRepository();
  const entries = await repository.listByGuild(guildId);
  for (const entry of entries) {
    await repository.remove(guildId, entry.termKey);
  }
}
