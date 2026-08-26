import type {
  DictionaryEntry,
  DictionaryTeachingProvenance,
} from "../types/db";
import { getDictionaryRepository } from "../repositories/dictionaryRepository";
import {
  buildDictionaryTermKey,
  DICTIONARY_DEFINITION_MAX_LENGTH,
  DICTIONARY_TERM_MAX_LENGTH,
  findDictionaryObservedConflict,
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

const normalizeAndValidateDictionaryTerm = (value: string) => {
  const term = normalizeDictionaryTerm(value);
  if (!term) {
    throw new Error("Dictionary term cannot be empty.");
  }
  if (term.length > DICTIONARY_TERM_MAX_LENGTH) {
    throw new Error(
      `Dictionary term must be ${DICTIONARY_TERM_MAX_LENGTH} characters or less.`,
    );
  }
  return term;
};

const normalizeAndValidateDictionaryDefinition = (value?: string | null) => {
  const definition = normalizeDictionaryDefinition(value);
  if (definition && definition.length > DICTIONARY_DEFINITION_MAX_LENGTH) {
    throw new Error(
      `Dictionary definition must be ${DICTIONARY_DEFINITION_MAX_LENGTH} characters or less.`,
    );
  }
  return definition;
};

const loadEntryForUpsert = async (params: {
  guildId: string;
  termKey: string;
  preserveObservedForms: boolean;
  preserveLastTeaching: boolean;
}) => {
  const repository = getDictionaryRepository();
  const preservesStoredTeachingData =
    params.preserveObservedForms || params.preserveLastTeaching;
  if (!preservesStoredTeachingData) {
    return {
      existing: await repository.get(params.guildId, params.termKey),
      repository,
    };
  }
  const snapshot = await repository.listSnapshotByGuild(params.guildId);
  return {
    existing: snapshot.entries.find(
      (entry) => entry.termKey === params.termKey,
    ),
    snapshotEntries: snapshot.entries,
    preservationRevision: snapshot.revision,
    repository,
  };
};

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
  const term = normalizeAndValidateDictionaryTerm(params.term);
  const definition = normalizeAndValidateDictionaryDefinition(
    params.definition,
  );
  const termKey = buildDictionaryTermKey(term);
  const { existing, preservationRevision, repository, snapshotEntries } =
    await loadEntryForUpsert({
      guildId: params.guildId,
      termKey,
      preserveObservedForms: params.observedForms === undefined,
      preserveLastTeaching: params.lastTeaching === undefined,
    });
  const now = new Date().toISOString();
  const observedForms =
    params.observedForms === undefined
      ? existing?.observedForms
      : normalizeDictionaryObservedForms(params.observedForms);
  if (
    snapshotEntries &&
    findDictionaryObservedConflict(snapshotEntries, term, observedForms ?? [])
  ) {
    throw new Error(
      "This spelling conflicts with another dictionary entry or observed form.",
    );
  }
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
    params.expectedRevision ?? preservationRevision,
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
  await getDictionaryRepository().clear(guildId);
}
