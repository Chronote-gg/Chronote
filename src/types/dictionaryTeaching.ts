import type { DictionaryEntry } from "./db";

export const DICTIONARY_TEACHING_INPUT_MAX_LENGTH = 2_000;
export const DICTIONARY_TEACHING_MAX_DRAFTS = 10;
export const DICTIONARY_OBSERVED_FORM_MAX_COUNT = 5;
export const DICTIONARY_TEACHING_CONTEXT_MAX_LENGTH = 4_000;
export const DICTIONARY_TEACHING_TOKEN_TTL_MS = 15 * 60 * 1_000;

export type DictionaryTeachingSource = "settings" | "notes_correction";

export type DictionaryTeachingEvidenceSource =
  "instruction" | "notes_diff" | "transcript_excerpt";

export interface DictionaryTeachingEvidence {
  source: DictionaryTeachingEvidenceSource;
  quote: string;
}

export interface DictionaryTeachingDraft {
  draftId: string;
  preferredTerm: string | null;
  observedForms: string[];
  description: string | null;
  ambiguity: string | null;
  evidence: DictionaryTeachingEvidence[];
  action: "create" | "update" | "conflict" | "needs_input";
  existingEntry?: DictionaryEntry;
}

export interface DictionaryTeachingContext {
  source: DictionaryTeachingSource;
  meetingId?: string;
  correctionId?: string;
  notesDiff?: string;
  transcriptExcerpt?: string;
}

export interface DictionaryTeachingModelMetadata {
  model: string;
  promptName: string;
  promptVersion?: number;
}

export interface DictionaryTeachingDraftRecord {
  guildId: string;
  requesterId: string;
  expiresAtMs: number;
  source: DictionaryTeachingSource;
  drafts: DictionaryTeachingDraft[];
  model: DictionaryTeachingModelMetadata;
  meetingId?: string;
  correctionId?: string;
}

export interface DictionaryTeachingCommitEntry {
  draftId: string;
  preferredTerm: string;
  observedForms?: string[];
  description?: string;
}

export interface DictionaryTeachingContextRecord {
  guildId: string;
  requesterId: string;
  expiresAtMs: number;
  context: DictionaryTeachingContext;
}
