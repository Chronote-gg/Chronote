import { CONFIG_KEYS } from "../config/keys";
import type { ConfigTier } from "../config/types";
import { DICTIONARY_OBSERVED_FORM_MAX_COUNT } from "../types/dictionaryTeaching";

export const DICTIONARY_TERM_MAX_LENGTH = 80;
export const DICTIONARY_DEFINITION_MAX_LENGTH = 400;

export type DictionaryBudgets = {
  maxEntries: number;
  maxCharsTranscription: number;
  maxCharsContext: number;
};

export type DictionaryItem = {
  term: string;
  definition?: string;
  updatedAt?: string;
};

export type DictionaryUsage = {
  totalEntries: number;
  transcription: { entries: number; chars: number };
  context: { entries: number; chars: number };
};

export const DEFAULT_DICTIONARY_BUDGETS: DictionaryBudgets = {
  maxEntries: 200,
  maxCharsTranscription: 2000,
  maxCharsContext: 6000,
};

const DEFAULT_PRO_BUDGETS: DictionaryBudgets = {
  maxEntries: 400,
  maxCharsTranscription: 4000,
  maxCharsContext: 12000,
};

const DEFAULT_CAPS: DictionaryBudgets = {
  maxEntries: 500,
  maxCharsTranscription: 6000,
  maxCharsContext: 20000,
};

const toNumber = (value: unknown, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const clampNonNegative = (value: number) =>
  Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;

export const resolveDictionaryBudgets = (
  valuesByKey?: Record<string, unknown>,
  tier?: ConfigTier,
): DictionaryBudgets => {
  const base = {
    maxEntries: toNumber(
      valuesByKey?.[CONFIG_KEYS.dictionary.maxEntries],
      DEFAULT_DICTIONARY_BUDGETS.maxEntries,
    ),
    maxCharsTranscription: toNumber(
      valuesByKey?.[CONFIG_KEYS.dictionary.maxCharsTranscription],
      DEFAULT_DICTIONARY_BUDGETS.maxCharsTranscription,
    ),
    maxCharsContext: toNumber(
      valuesByKey?.[CONFIG_KEYS.dictionary.maxCharsContext],
      DEFAULT_DICTIONARY_BUDGETS.maxCharsContext,
    ),
  };
  const pro = {
    maxEntries: toNumber(
      valuesByKey?.[CONFIG_KEYS.dictionary.maxEntriesPro],
      DEFAULT_PRO_BUDGETS.maxEntries,
    ),
    maxCharsTranscription: toNumber(
      valuesByKey?.[CONFIG_KEYS.dictionary.maxCharsTranscriptionPro],
      DEFAULT_PRO_BUDGETS.maxCharsTranscription,
    ),
    maxCharsContext: toNumber(
      valuesByKey?.[CONFIG_KEYS.dictionary.maxCharsContextPro],
      DEFAULT_PRO_BUDGETS.maxCharsContext,
    ),
  };
  const caps = {
    maxEntries: toNumber(
      valuesByKey?.[CONFIG_KEYS.dictionary.maxEntriesCap],
      DEFAULT_CAPS.maxEntries,
    ),
    maxCharsTranscription: toNumber(
      valuesByKey?.[CONFIG_KEYS.dictionary.maxCharsTranscriptionCap],
      DEFAULT_CAPS.maxCharsTranscription,
    ),
    maxCharsContext: toNumber(
      valuesByKey?.[CONFIG_KEYS.dictionary.maxCharsContextCap],
      DEFAULT_CAPS.maxCharsContext,
    ),
  };

  const pick = (baseValue: number, proValue: number, capValue: number) => {
    const selected = tier === "pro" ? proValue : baseValue;
    return clampNonNegative(Math.min(selected, capValue));
  };

  return {
    maxEntries: pick(base.maxEntries, pro.maxEntries, caps.maxEntries),
    maxCharsTranscription: pick(
      base.maxCharsTranscription,
      pro.maxCharsTranscription,
      caps.maxCharsTranscription,
    ),
    maxCharsContext: pick(
      base.maxCharsContext,
      pro.maxCharsContext,
      caps.maxCharsContext,
    ),
  };
};

const normalizeWhitespace = (value: string) =>
  value.replace(/\s+/g, " ").trim();

export const normalizeDictionaryTerm = (value: string) =>
  normalizeWhitespace(value);

export const normalizeDictionaryDefinition = (
  value?: string | null,
): string | undefined => {
  if (!value) return undefined;
  const trimmed = normalizeWhitespace(value);
  return trimmed.length > 0 ? trimmed : undefined;
};

export const normalizeDictionaryObservedForms = (values?: string[]) => {
  if (!values) return undefined;
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values) {
    const form = normalizeDictionaryTerm(value);
    if (!form || form.length > DICTIONARY_TERM_MAX_LENGTH) continue;
    const key = buildDictionaryTermKey(form);
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(form);
    if (normalized.length >= DICTIONARY_OBSERVED_FORM_MAX_COUNT) break;
  }
  return normalized.length > 0 ? normalized : undefined;
};

export const buildDictionaryTermKey = (term: string) =>
  normalizeDictionaryTerm(term).toLowerCase();

type NormalizedEntry = {
  term: string;
  termKey: string;
  definition?: string;
  updatedAt?: string;
};

const pickMostRecent = (a: NormalizedEntry, b: NormalizedEntry) => {
  const aUpdated = a.updatedAt ?? "";
  const bUpdated = b.updatedAt ?? "";
  if (aUpdated === bUpdated) return a;
  return aUpdated > bUpdated ? a : b;
};

export const normalizeDictionaryEntries = (entries: DictionaryItem[]) => {
  const map = new Map<string, NormalizedEntry>();
  entries.forEach((entry) => {
    const term = normalizeDictionaryTerm(entry.term);
    if (!term) return;
    const termKey = term.toLowerCase();
    const normalized: NormalizedEntry = {
      term,
      termKey,
      definition: normalizeDictionaryDefinition(entry.definition),
      updatedAt: entry.updatedAt,
    };
    const existing = map.get(termKey);
    map.set(
      termKey,
      existing ? pickMostRecent(existing, normalized) : normalized,
    );
  });

  return Array.from(map.values()).sort((a, b) => {
    const aUpdated = a.updatedAt ?? "";
    const bUpdated = b.updatedAt ?? "";
    if (aUpdated !== bUpdated) {
      return bUpdated.localeCompare(aUpdated);
    }
    return a.term.localeCompare(b.term);
  });
};

type LineResult = { lines: string[]; chars: number; entries: number };

const buildLines = (
  entries: NormalizedEntry[],
  formatLine: (entry: NormalizedEntry) => string,
  maxEntries: number,
  maxChars: number,
): LineResult => {
  if (maxEntries <= 0 || maxChars <= 0) {
    return { lines: [], chars: 0, entries: 0 };
  }

  const lines: string[] = [];
  let chars = 0;
  let entriesUsed = 0;

  for (const entry of entries) {
    if (entriesUsed >= maxEntries) break;
    const line = formatLine(entry);
    if (!line) continue;
    const nextChars = chars + line.length + (lines.length > 0 ? 1 : 0);
    if (nextChars > maxChars) break;
    lines.push(line);
    chars = nextChars;
    entriesUsed += 1;
  }

  return { lines, chars, entries: entriesUsed };
};

export const buildDictionaryPromptLines = (
  entries: DictionaryItem[],
  budgets: DictionaryBudgets,
): {
  transcriptionLines: string[];
  contextLines: string[];
  usage: DictionaryUsage;
} => {
  const normalized = normalizeDictionaryEntries(entries);
  const transcription = buildLines(
    normalized,
    (entry) => `- ${entry.term}`,
    budgets.maxEntries,
    budgets.maxCharsTranscription,
  );
  const context = buildLines(
    normalized,
    (entry) =>
      entry.definition
        ? `- ${entry.term}: ${entry.definition}`
        : `- ${entry.term}`,
    budgets.maxEntries,
    budgets.maxCharsContext,
  );

  return {
    transcriptionLines: transcription.lines,
    contextLines: context.lines,
    usage: {
      totalEntries: normalized.length,
      transcription: {
        entries: transcription.entries,
        chars: transcription.chars,
      },
      context: { entries: context.entries, chars: context.chars },
    },
  };
};
