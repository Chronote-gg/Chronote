import { TRPCError } from "@trpc/server";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { router, manageGuildProcedure } from "../trpc";
import {
  clearDictionaryEntriesService,
  listDictionaryEntriesService,
  removeDictionaryEntryService,
  upsertDictionaryEntryService,
} from "../../services/dictionaryService";
import {
  DICTIONARY_OBSERVED_FORM_MAX_COUNT,
  DICTIONARY_TEACHING_INPUT_MAX_LENGTH,
  DICTIONARY_TEACHING_MAX_DRAFTS,
  DICTIONARY_TEACHING_TOKEN_TTL_MS,
  type DictionaryTeachingCommitEntry,
  type DictionaryTeachingDraft,
  type DictionaryTeachingDraftRecord,
} from "../../types/dictionaryTeaching";
import type { DictionaryEntry } from "../../types/db";
import {
  DICTIONARY_DEFINITION_MAX_LENGTH,
  DICTIONARY_TERM_MAX_LENGTH,
  buildDictionaryTermKey,
  normalizeDictionaryDefinition,
  normalizeDictionaryObservedForms,
  normalizeDictionaryTerm,
} from "../../utils/dictionary";
import {
  findDictionaryObservedConflict,
  generateDictionaryTeachingDrafts,
} from "../../services/dictionaryTeachingService";
import { createDictionaryTeachingTokenStore } from "../../services/dictionaryTeachingTokenStore";
import { resolveModelParamsForContext } from "../../services/openaiModelParams";
import { resolveModelChoicesForContext } from "../../services/modelChoiceService";
import { captureEvent } from "../../services/analyticsService";

const serverSchema = z.object({
  serverId: z.string().min(1),
});

const dictionaryTeachingTokenStore = createDictionaryTeachingTokenStore({
  maxPending: 200,
});

const teachingEntrySchema = z.object({
  draftId: z.string().uuid(),
  preferredTerm: z.string().min(1).max(DICTIONARY_TERM_MAX_LENGTH),
  observedForms: z
    .array(z.string().min(1).max(DICTIONARY_TERM_MAX_LENGTH))
    .max(DICTIONARY_OBSERVED_FORM_MAX_COUNT)
    .optional(),
  description: z.string().max(DICTIONARY_DEFINITION_MAX_LENGTH).optional(),
});

interface TeachingCommitInput {
  serverId: string;
  token: string;
  entries: DictionaryTeachingCommitEntry[];
}

interface TeachingCommitResult {
  draftId: string;
  ok: boolean;
  entry?: DictionaryEntry;
  error?: string;
}

const assertTeachingDraftScope = (
  record: DictionaryTeachingDraftRecord | null,
  serverId: string,
  userId: string,
): DictionaryTeachingDraftRecord => {
  if (!record) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "This teaching draft has expired. Analyze it again.",
    });
  }
  if (record.guildId !== serverId || record.requesterId !== userId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "This teaching draft belongs to another request.",
    });
  }
  return record;
};

const indexAndValidateTeachingDrafts = (
  record: DictionaryTeachingDraftRecord,
  entries: DictionaryTeachingCommitEntry[],
) => {
  const draftsById = new Map(
    record.drafts.map((draft) => [draft.draftId, draft]),
  );
  if (entries.some((entry) => !draftsById.has(entry.draftId))) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "A submitted term was not part of this teaching draft.",
    });
  }
  const submittedTermKeys = entries.map((entry) =>
    buildDictionaryTermKey(normalizeDictionaryTerm(entry.preferredTerm)),
  );
  if (new Set(submittedTermKeys).size !== submittedTermKeys.length) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Each approved entry needs unique exact spelling.",
    });
  }
  return draftsById;
};

const normalizeTeachingEntry = (
  submitted: DictionaryTeachingCommitEntry,
  current?: DictionaryEntry,
) => ({
  preferredTerm: normalizeDictionaryTerm(submitted.preferredTerm),
  observedForms: normalizeDictionaryObservedForms([
    ...(submitted.observedForms ?? []),
    ...(current?.observedForms ?? []),
  ]),
  description:
    submitted.description === undefined
      ? current?.definition
      : normalizeDictionaryDefinition(submitted.description),
});

const teachingDraftWasEdited = (
  draft: DictionaryTeachingDraft,
  submitted: DictionaryTeachingCommitEntry,
) => {
  const submittedObservedForms =
    submitted.observedForms === undefined
      ? draft.observedForms
      : normalizeDictionaryObservedForms(submitted.observedForms);
  const submittedDescription =
    submitted.description === undefined
      ? draft.description
      : normalizeDictionaryDefinition(submitted.description);
  return (
    draft.preferredTerm !== normalizeDictionaryTerm(submitted.preferredTerm) ||
    draft.description !== (submittedDescription ?? null) ||
    JSON.stringify(draft.observedForms) !==
      JSON.stringify(submittedObservedForms ?? [])
  );
};

const findTeachingBatchConflictDraftIds = (
  entries: Array<{
    submitted: DictionaryTeachingCommitEntry;
    normalized: ReturnType<typeof normalizeTeachingEntry>;
  }>,
) => {
  const conflictDraftIds = new Set<string>();
  for (let leftIndex = 0; leftIndex < entries.length; leftIndex += 1) {
    const left = entries[leftIndex];
    const leftPreferredKey = buildDictionaryTermKey(
      left.normalized.preferredTerm,
    );
    const leftObservedKeys = new Set(
      (left.normalized.observedForms ?? []).map(buildDictionaryTermKey),
    );
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < entries.length;
      rightIndex += 1
    ) {
      const right = entries[rightIndex];
      const rightPreferredKey = buildDictionaryTermKey(
        right.normalized.preferredTerm,
      );
      const rightObservedKeys = new Set(
        (right.normalized.observedForms ?? []).map(buildDictionaryTermKey),
      );
      const conflicts =
        leftPreferredKey === rightPreferredKey ||
        leftObservedKeys.has(rightPreferredKey) ||
        rightObservedKeys.has(leftPreferredKey) ||
        [...leftObservedKeys].some((key) => rightObservedKeys.has(key));
      if (conflicts) {
        conflictDraftIds.add(left.submitted.draftId);
        conflictDraftIds.add(right.submitted.draftId);
      }
    }
  }
  return conflictDraftIds;
};

const saveTeachingEntry = async (params: {
  serverId: string;
  userId: string;
  submitted: DictionaryTeachingCommitEntry;
  normalized: ReturnType<typeof normalizeTeachingEntry>;
  record: DictionaryTeachingDraftRecord;
}): Promise<TeachingCommitResult> => {
  try {
    const entry = await upsertDictionaryEntryService({
      guildId: params.serverId,
      term: params.normalized.preferredTerm,
      definition: params.normalized.description,
      observedForms: params.normalized.observedForms,
      lastTeaching: {
        method: "llm_assisted",
        source: params.record.source,
        meetingId: params.record.meetingId,
        correctionId: params.record.correctionId,
        model: params.record.model.model,
        promptName: params.record.model.promptName,
        promptVersion: params.record.model.promptVersion,
        approvedBy: params.userId,
        approvedAt: new Date().toISOString(),
      },
      userId: params.userId,
    });
    return { draftId: params.submitted.draftId, ok: true, entry };
  } catch (error) {
    return {
      draftId: params.submitted.draftId,
      ok: false,
      error: error instanceof Error ? error.message : "Save failed.",
    };
  }
};

const prepareTeachingEntrySave = (params: {
  submitted: DictionaryTeachingCommitEntry;
  draft: DictionaryTeachingDraft;
  current?: DictionaryEntry;
  currentEntries: DictionaryEntry[];
}) => {
  const normalized = normalizeTeachingEntry(params.submitted, params.current);
  const reviewedEntryRenamed =
    params.draft.existingEntry !== undefined &&
    buildDictionaryTermKey(normalized.preferredTerm) !==
      params.draft.existingEntry.termKey;
  const targetsUnreviewedEntry =
    params.current !== undefined &&
    params.draft.existingEntry?.termKey !== params.current.termKey;
  const reviewedEntryChanged =
    params.current !== undefined &&
    params.draft.existingEntry?.termKey === params.current.termKey &&
    params.draft.existingEntry.updatedAt !== params.current.updatedAt;
  const observedConflict = findDictionaryObservedConflict(
    params.currentEntries,
    normalized.preferredTerm,
    normalizeDictionaryObservedForms(
      params.submitted.observedForms ?? params.draft.observedForms,
    ) ?? [],
  );
  const targetsUnreviewedObservedConflict =
    observedConflict !== undefined &&
    params.draft.existingEntry?.termKey !== observedConflict.termKey;
  const conflictError = reviewedEntryRenamed
    ? "The exact spelling changed from the reviewed existing entry. Revise and analyze the request again before updating it."
    : targetsUnreviewedEntry
      ? "This exact spelling now matches an existing entry. Revise and analyze the request again before updating it."
      : reviewedEntryChanged
        ? "This dictionary entry changed after the proposal was generated. Revise and analyze the request again before updating it."
        : targetsUnreviewedObservedConflict
          ? "This spelling or one of its observed forms now conflicts with another entry. Revise and analyze the request again before saving it."
          : undefined;
  return {
    edited: teachingDraftWasEdited(params.draft, params.submitted),
    conflictError,
    normalized,
    submitted: params.submitted,
  };
};

const commitDictionaryTeaching = async (
  input: TeachingCommitInput,
  userId: string,
) => {
  const record = assertTeachingDraftScope(
    await dictionaryTeachingTokenStore.getDraft(input.token),
    input.serverId,
    userId,
  );
  const draftsById = indexAndValidateTeachingDrafts(record, input.entries);
  const currentEntries = await listDictionaryEntriesService(input.serverId);
  const currentByKey = new Map(
    currentEntries.map((entry) => [entry.termKey, entry]),
  );
  const pending = input.entries.map((submitted) => {
    const key = buildDictionaryTermKey(
      normalizeDictionaryTerm(submitted.preferredTerm),
    );
    return prepareTeachingEntrySave({
      submitted,
      draft: draftsById.get(submitted.draftId)!,
      current: currentByKey.get(key),
      currentEntries,
    });
  });
  const batchConflictDraftIds = findTeachingBatchConflictDraftIds(
    pending.filter(({ conflictError }) => conflictError === undefined),
  );
  const results = await Promise.all(
    pending.map(({ conflictError, normalized, submitted }) => {
      const error =
        conflictError ??
        (batchConflictDraftIds.has(submitted.draftId)
          ? "This spelling conflicts with another entry in the same approval batch. Revise the request before saving it."
          : undefined);
      return error
        ? Promise.resolve<TeachingCommitResult>({
            draftId: submitted.draftId,
            ok: false,
            error,
          })
        : saveTeachingEntry({
            serverId: input.serverId,
            userId,
            submitted,
            normalized,
            record,
          });
    }),
  );
  const failedCount = results.filter((result) => !result.ok).length;
  if (failedCount === 0) {
    await dictionaryTeachingTokenStore.deleteDraft(input.token);
  }
  captureEvent("dictionary_teaching_committed", {
    userId,
    guildId: input.serverId,
    properties: {
      source: record.source,
      submitted_count: input.entries.length,
      saved_count: input.entries.length - failedCount,
      failed_count: failedCount,
      edited_draft_count: pending.filter(({ edited }) => edited).length,
    },
  });
  return { results };
};

export const dictionaryRouter = router({
  list: manageGuildProcedure.input(serverSchema).query(async ({ input }) => {
    const entries = await listDictionaryEntriesService(input.serverId);
    return { entries };
  }),
  upsert: manageGuildProcedure
    .input(
      serverSchema.extend({
        term: z.string().min(1).max(DICTIONARY_TERM_MAX_LENGTH),
        definition: z.string().max(DICTIONARY_DEFINITION_MAX_LENGTH).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const entry = await upsertDictionaryEntryService({
        guildId: input.serverId,
        term: input.term,
        definition: input.definition,
        userId: ctx.user!.id,
      });
      return { entry };
    }),
  remove: manageGuildProcedure
    .input(
      serverSchema.extend({
        term: z.string().min(1).max(DICTIONARY_TERM_MAX_LENGTH),
      }),
    )
    .mutation(async ({ input }) => {
      await removeDictionaryEntryService({
        guildId: input.serverId,
        term: input.term,
      });
      return { ok: true };
    }),
  clear: manageGuildProcedure
    .input(serverSchema)
    .mutation(async ({ input }) => {
      await clearDictionaryEntriesService(input.serverId);
      return { ok: true };
    }),
  previewTeaching: manageGuildProcedure
    .input(
      serverSchema.extend({
        instruction: z
          .string()
          .trim()
          .min(1)
          .max(DICTIONARY_TEACHING_INPUT_MAX_LENGTH),
        correctionContextToken: z.string().uuid().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      let contextRecord = null;
      if (input.correctionContextToken) {
        contextRecord = await dictionaryTeachingTokenStore.getContext(
          input.correctionContextToken,
        );
        if (!contextRecord) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "This correction context has expired.",
          });
        }
        if (
          contextRecord.guildId !== input.serverId ||
          contextRecord.requesterId !== ctx.user!.id
        ) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "This correction context belongs to another request.",
          });
        }
      }

      const [entries, modelParams, modelChoices] = await Promise.all([
        listDictionaryEntriesService(input.serverId),
        resolveModelParamsForContext({
          guildId: input.serverId,
          userId: ctx.user!.id,
        }),
        resolveModelChoicesForContext({
          guildId: input.serverId,
          userId: ctx.user!.id,
        }),
      ]);
      const generated = await generateDictionaryTeachingDrafts({
        guildId: input.serverId,
        userId: ctx.user!.id,
        instruction: input.instruction,
        context: contextRecord?.context,
        existingEntries: entries,
        modelParams: modelParams.dictionaryTeaching,
        modelOverride: modelChoices.dictionaryTeaching,
      });
      if (generated.drafts.length === 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Chronote could not identify an exact term. Try stating what it wrote and the exact spelling it should use.",
        });
      }

      const token = uuidv4();
      const expiresAtMs = Date.now() + DICTIONARY_TEACHING_TOKEN_TTL_MS;
      await dictionaryTeachingTokenStore.setDraft(token, {
        guildId: input.serverId,
        requesterId: ctx.user!.id,
        expiresAtMs,
        source: contextRecord?.context.source ?? "settings",
        drafts: generated.drafts,
        model: generated.model,
        meetingId: contextRecord?.context.meetingId,
        correctionId: contextRecord?.context.correctionId,
      });
      captureEvent("dictionary_teaching_previewed", {
        userId: ctx.user!.id,
        guildId: input.serverId,
        properties: {
          source: contextRecord?.context.source ?? "settings",
          instruction_length: input.instruction.length,
          draft_count: generated.drafts.length,
          ambiguous_count: generated.drafts.filter(
            (draft) => draft.action === "needs_input",
          ).length,
          conflict_count: generated.drafts.filter(
            (draft) => draft.action === "conflict",
          ).length,
        },
      });
      return { token, expiresAtMs, drafts: generated.drafts };
    }),
  commitTeaching: manageGuildProcedure
    .input(
      serverSchema.extend({
        token: z.string().uuid(),
        entries: z
          .array(teachingEntrySchema)
          .min(1)
          .max(DICTIONARY_TEACHING_MAX_DRAFTS),
      }),
    )
    .mutation(({ ctx, input }) =>
      commitDictionaryTeaching(input, ctx.user!.id),
    ),
});
