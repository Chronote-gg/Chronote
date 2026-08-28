import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import type { ModelParamConfig } from "../config/types";
import type { DictionaryEntry } from "../types/db";
import {
  DICTIONARY_OBSERVED_FORM_MAX_COUNT,
  DICTIONARY_TEACHING_MAX_DRAFTS,
  type DictionaryTeachingContext,
  type DictionaryTeachingDraft,
  type DictionaryTeachingEvidenceSource,
  type DictionaryTeachingModelMetadata,
} from "../types/dictionaryTeaching";
import {
  DICTIONARY_DEFINITION_MAX_LENGTH,
  DICTIONARY_TERM_MAX_LENGTH,
  buildDictionaryTermKey,
  findDictionaryObservedConflict,
  normalizeDictionaryDefinition,
  normalizeDictionaryTerm,
} from "../utils/dictionary";
import { config } from "./configService";
import { createOpenAIClient } from "./openaiClient";
import { getLangfuseChatPrompt } from "./langfusePromptService";
import { buildModelOverrides, getModelChoice } from "./modelFactory";
import { resolveChatParamsForRole } from "./openaiModelParams";

const evidenceSchema = z.object({
  source: z.enum(["instruction", "notes_diff", "transcript_excerpt"]),
  quote: z.string(),
});

const modelDraftSchema = z.object({
  preferredTerm: z.string().nullable().optional(),
  observedForms: z.array(z.string()).optional(),
  description: z.string().nullable().optional(),
  ambiguity: z.string().nullable().optional(),
  evidence: z.array(evidenceSchema).optional(),
});

const modelResponseSchema = z.object({
  drafts: z.array(modelDraftSchema),
});

type ModelDictionaryTeachingDraft = z.infer<typeof modelDraftSchema>;

interface DictionaryTeachingGenerationParams {
  guildId: string;
  userId: string;
  instruction: string;
  context?: DictionaryTeachingContext;
  existingEntries: DictionaryEntry[];
  modelParams?: ModelParamConfig;
  modelOverride?: string;
}

const normalizeComparable = (value: string) =>
  value.replace(/\s+/g, " ").trim().toLocaleLowerCase();

const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const containsComparable = (source: string, candidate: string) => {
  const normalizedCandidate = normalizeComparable(candidate);
  if (!normalizedCandidate) return false;
  return new RegExp(
    `(?<![\\p{L}\\p{N}])${escapeRegExp(normalizedCandidate)}(?![\\p{L}\\p{N}])`,
    "u",
  ).test(normalizeComparable(source));
};

const sourceText = (
  source: DictionaryTeachingEvidenceSource,
  instruction: string,
  context?: DictionaryTeachingContext,
) => {
  if (source === "instruction") return instruction;
  if (source === "notes_diff") return context?.notesDiff ?? "";
  return context?.transcriptExcerpt ?? "";
};

const allSourceText = (
  instruction: string,
  context?: DictionaryTeachingContext,
) =>
  [
    instruction,
    context?.notesDiff ?? "",
    context?.transcriptExcerpt ?? "",
  ].join("\n");

const normalizeObservedForms = (values: string[], availableText: string) => {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values) {
    const form = normalizeDictionaryTerm(value);
    const key = buildDictionaryTermKey(form);
    if (
      !form ||
      form.length > DICTIONARY_TERM_MAX_LENGTH ||
      seen.has(key) ||
      !containsComparable(availableText, form)
    ) {
      continue;
    }
    seen.add(key);
    normalized.push(form);
    if (normalized.length >= DICTIONARY_OBSERVED_FORM_MAX_COUNT) break;
  }
  return normalized;
};

const findExistingEntry = (entries: DictionaryEntry[], term: string) => {
  const termKey = buildDictionaryTermKey(term);
  return entries.find((entry) => entry.termKey === termKey);
};

const normalizePreferredTerm = (
  candidate: ModelDictionaryTeachingDraft,
  availableText: string,
) => {
  if (!candidate.preferredTerm) return null;
  const term = normalizeDictionaryTerm(candidate.preferredTerm);
  if (!term || term.length > DICTIONARY_TERM_MAX_LENGTH) return null;
  return containsComparable(availableText, term) ? term : null;
};

const normalizeTeachingDescription = (
  candidate: ModelDictionaryTeachingDraft,
) => {
  const description = normalizeDictionaryDefinition(candidate.description);
  if (!description || description.length > DICTIONARY_DEFINITION_MAX_LENGTH) {
    return null;
  }
  return description;
};

const normalizeTeachingEvidence = (
  candidate: ModelDictionaryTeachingDraft,
  instruction: string,
  context?: DictionaryTeachingContext,
) =>
  (candidate.evidence ?? [])
    .map((item) => ({ ...item, quote: item.quote.trim() }))
    .filter(
      (item) =>
        item.quote.length > 0 &&
        containsComparable(
          sourceText(item.source, instruction, context),
          item.quote,
        ),
    )
    .slice(0, 6);

const resolveDraftAction = (
  preferredTerm: string | null,
  conflictEntry?: DictionaryEntry,
  exactEntry?: DictionaryEntry,
): DictionaryTeachingDraft["action"] => {
  if (!preferredTerm) return "needs_input";
  if (conflictEntry) return "conflict";
  if (exactEntry) return "update";
  return "create";
};

const toDictionaryTeachingDraft = (
  candidate: ModelDictionaryTeachingDraft,
  params: {
    availableText: string;
    instruction: string;
    context?: DictionaryTeachingContext;
    existingEntries: DictionaryEntry[];
  },
): DictionaryTeachingDraft => {
  const preferredTerm = normalizePreferredTerm(candidate, params.availableText);
  const observedForms = normalizeObservedForms(
    candidate.observedForms ?? [],
    params.availableText,
  ).filter(
    (form) =>
      !preferredTerm ||
      buildDictionaryTermKey(form) !== buildDictionaryTermKey(preferredTerm),
  );
  const exactEntry = preferredTerm
    ? findExistingEntry(params.existingEntries, preferredTerm)
    : undefined;
  const conflictEntry = preferredTerm
    ? findDictionaryObservedConflict(
        params.existingEntries,
        preferredTerm,
        observedForms,
      )
    : undefined;
  return {
    draftId: uuidv4(),
    preferredTerm,
    observedForms,
    description: normalizeTeachingDescription(candidate),
    ambiguity:
      candidate.ambiguity?.trim() ||
      (!preferredTerm
        ? "Confirm the exact spelling Chronote should use."
        : null),
    evidence: normalizeTeachingEvidence(
      candidate,
      params.instruction,
      params.context,
    ),
    action: resolveDraftAction(preferredTerm, conflictEntry, exactEntry),
    existingEntry: conflictEntry ?? exactEntry,
  };
};

export function parseDictionaryTeachingResponse(params: {
  raw: string;
  instruction: string;
  context?: DictionaryTeachingContext;
  existingEntries: DictionaryEntry[];
}): DictionaryTeachingDraft[] {
  const parsed = modelResponseSchema.parse(JSON.parse(params.raw));
  const availableText = allSourceText(params.instruction, params.context);

  const drafts = parsed.drafts
    .slice(0, DICTIONARY_TEACHING_MAX_DRAFTS)
    .map((candidate) =>
      toDictionaryTeachingDraft(candidate, {
        availableText,
        instruction: params.instruction,
        context: params.context,
        existingEntries: params.existingEntries,
      }),
    );

  const seenPreferredTerms = new Set<string>();
  return drafts.filter((draft) => {
    if (!draft.preferredTerm) return true;
    const key = buildDictionaryTermKey(draft.preferredTerm);
    if (seenPreferredTerms.has(key)) return false;
    seenPreferredTerms.add(key);
    return true;
  });
}

const entrySearchScore = (entry: DictionaryEntry, query: string) => {
  const term = normalizeComparable(entry.term);
  const definition = normalizeComparable(entry.definition ?? "");
  const observed = (entry.observedForms ?? []).map(normalizeComparable);
  let score = query.includes(term) ? 100 : 0;
  for (const token of query.split(/[^\p{L}\p{N}]+/u).filter(Boolean)) {
    if (term.includes(token)) score += 10;
    if (definition.includes(token)) score += 2;
    if (observed.some((form) => form.includes(token))) score += 5;
  }
  return score;
};

export function selectDictionaryTeachingConflicts(
  entries: DictionaryEntry[],
  instruction: string,
  context?: DictionaryTeachingContext,
) {
  const query = normalizeComparable(allSourceText(instruction, context));
  return [...entries]
    .map((entry) => ({ entry, score: entrySearchScore(entry, query) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      return b.entry.updatedAt.localeCompare(a.entry.updatedAt);
    })
    .slice(0, 25)
    .map(({ entry }) => entry);
}

const formatExistingEntriesForPrompt = (entries: DictionaryEntry[]) => {
  if (entries.length === 0) return "None.";
  return entries
    .map((entry) => {
      if (!entry.definition) return `- ${entry.term}`;
      return `- ${entry.term}: ${entry.definition}`;
    })
    .join("\n");
};

const buildDictionaryTeachingPromptVariables = (
  params: DictionaryTeachingGenerationParams,
) => ({
  instruction: params.instruction,
  notesDiff: params.context?.notesDiff ?? "",
  transcriptExcerpt: params.context?.transcriptExcerpt ?? "",
  existingEntries: formatExistingEntriesForPrompt(
    selectDictionaryTeachingConflicts(
      params.existingEntries,
      params.instruction,
      params.context,
    ),
  ),
});

const resolveDictionaryTeachingModelChoice = (modelOverride?: string) =>
  getModelChoice(
    "dictionaryTeaching",
    buildModelOverrides(
      modelOverride ? { dictionaryTeaching: modelOverride } : undefined,
    ),
  );

const buildDictionaryTeachingTraceMetadata = (
  params: DictionaryTeachingGenerationParams,
) => ({
  guildId: params.guildId,
  source: params.context?.source ?? "settings",
  instructionLength: params.instruction.length,
  notesDiffLength: params.context?.notesDiff?.length ?? 0,
  transcriptExcerptLength: params.context?.transcriptExcerpt?.length ?? 0,
});

export async function generateDictionaryTeachingDrafts(
  params: DictionaryTeachingGenerationParams,
): Promise<{
  drafts: DictionaryTeachingDraft[];
  model: DictionaryTeachingModelMetadata;
}> {
  const { messages, langfusePrompt } = await getLangfuseChatPrompt({
    name: config.langfuse.dictionaryTeachingPromptName,
    variables: buildDictionaryTeachingPromptVariables(params),
  });
  const modelChoice = resolveDictionaryTeachingModelChoice(
    params.modelOverride,
  );
  const chatParams = resolveChatParamsForRole({
    role: "dictionaryTeaching",
    model: modelChoice.model,
    config: params.modelParams,
  });
  const openAIClient = createOpenAIClient({
    traceName: "dictionary-teaching",
    generationName: "dictionary-teaching",
    userId: params.userId,
    tags: ["feature:dictionary_teaching"],
    metadata: buildDictionaryTeachingTraceMetadata(params),
    langfusePrompt,
  });
  const completion = await openAIClient.chat.completions.create({
    model: modelChoice.model,
    messages,
    ...chatParams,
    response_format: { type: "json_object" },
    max_completion_tokens: 8_000,
  });
  const raw = completion.choices[0]?.message?.content;
  if (!raw?.trim()) {
    throw new Error("Dictionary teaching returned no drafts.");
  }
  return {
    drafts: parseDictionaryTeachingResponse({
      raw,
      instruction: params.instruction,
      context: params.context,
      existingEntries: params.existingEntries,
    }),
    model: {
      model: modelChoice.model,
      promptName: config.langfuse.dictionaryTeachingPromptName,
      promptVersion: langfusePrompt?.version,
    },
  };
}
