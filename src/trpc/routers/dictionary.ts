import { TRPCError } from "@trpc/server";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { router, manageGuildProcedure } from "../trpc";
import {
  clearDictionaryEntriesService,
  DICTIONARY_REVIEW_CONFLICT_MESSAGE,
  getDictionarySnapshotService,
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
  type DictionaryTeachingContext,
  type DictionaryTeachingContextRecord,
  type DictionaryTeachingDraft,
  type DictionaryTeachingDraftRecord,
} from "../../types/dictionaryTeaching";
import type { DictionaryEntry } from "../../types/db";
import {
  DICTIONARY_DEFINITION_MAX_LENGTH,
  DICTIONARY_TERM_MAX_LENGTH,
  buildDictionaryTermKey,
  findDictionaryObservedConflict,
  normalizeDictionaryDefinition,
  normalizeDictionaryObservedForms,
  normalizeDictionaryTerm,
} from "../../utils/dictionary";
import { generateDictionaryTeachingDrafts } from "../../services/dictionaryTeachingService";
import { createDictionaryTeachingTokenStore } from "../../services/dictionaryTeachingTokenStore";
import { resolveModelParamsForContext } from "../../services/openaiModelParams";
import { resolveModelChoicesForContext } from "../../services/modelChoiceService";
import { captureEvent } from "../../services/analyticsService";
import {
  resolveServerAttendeeAccessEnabled,
  resolveServerMeetingArtifactAccess,
} from "../../services/meetingArtifactAccessService";
import { getMeetingHistoryService } from "../../services/meetingHistoryService";
import { checkUserMeetingAccess } from "../../services/meetingAccessService";
import { createMeetingMentionReplacer } from "../../services/meetingMentionService";

const serverSchema = z.object({
  serverId: z.string().min(1),
});

const dictionaryTeachingTokenStore = createDictionaryTeachingTokenStore({
  maxPending: 200,
});

const analyticsDisabledForRequest = (
  request: {
    headers?: Record<string, string | string[] | undefined>;
  },
  clientDoNotTrack: boolean,
) => clientDoNotTrack || request.headers?.dnt === "1";

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

interface TeachingPreviewInput {
  serverId: string;
  instruction: string;
  correctionContextToken?: string;
  doNotTrack: boolean;
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
  const submittedDraftIds = entries.map((entry) => entry.draftId);
  if (new Set(submittedDraftIds).size !== submittedDraftIds.length) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Each teaching draft can be approved only once.",
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
    ...(current?.observedForms ?? []),
    ...(submitted.observedForms ?? []),
  ]),
  description:
    submitted.description === undefined
      ? current?.definition
      : normalizeDictionaryDefinition(submitted.description),
});

const dropsSubmittedObservedForm = (
  submitted: DictionaryTeachingCommitEntry,
  normalized: ReturnType<typeof normalizeTeachingEntry>,
) => {
  const retainedKeys = new Set(
    (normalized.observedForms ?? []).map(buildDictionaryTermKey),
  );
  return (normalizeDictionaryObservedForms(submitted.observedForms) ?? []).some(
    (form) => !retainedKeys.has(buildDictionaryTermKey(form)),
  );
};

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
  captureAnalytics: boolean;
  expectedUpdatedAt: string | null;
  expectedRevision: number;
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
      captureAnalytics: params.captureAnalytics,
      expectedUpdatedAt: params.expectedUpdatedAt,
      expectedRevision: params.expectedRevision,
    });
    return { draftId: params.submitted.draftId, ok: true, entry };
  } catch (error) {
    console.error("Failed saving dictionary teaching entry", {
      guildId: params.serverId,
      draftId: params.submitted.draftId,
      error,
    });
    return {
      draftId: params.submitted.draftId,
      ok: false,
      error:
        error instanceof Error &&
        error.message === DICTIONARY_REVIEW_CONFLICT_MESSAGE
          ? error.message
          : "This dictionary entry could not be saved. Try again.",
    };
  }
};

const reviewedEntryWasRenamed = (
  draft: DictionaryTeachingDraft,
  normalized: ReturnType<typeof normalizeTeachingEntry>,
) =>
  draft.action === "update" &&
  draft.existingEntry !== undefined &&
  buildDictionaryTermKey(normalized.preferredTerm) !==
    draft.existingEntry.termKey;

const targetsUnreviewedEntry = (
  draft: DictionaryTeachingDraft,
  current?: DictionaryEntry,
) => current !== undefined && draft.existingEntry?.termKey !== current.termKey;

const reviewedEntryWasChanged = (
  draft: DictionaryTeachingDraft,
  current?: DictionaryEntry,
) =>
  current !== undefined &&
  draft.existingEntry?.termKey === current.termKey &&
  draft.existingEntry.updatedAt !== current.updatedAt;

const reviewedEntryWasDeleted = (
  draft: DictionaryTeachingDraft,
  current?: DictionaryEntry,
) =>
  draft.action === "update" &&
  draft.existingEntry !== undefined &&
  current === undefined;

const targetsUnreviewedObservedConflict = (params: {
  draft: DictionaryTeachingDraft;
  current?: DictionaryEntry;
  currentEntries: DictionaryEntry[];
  normalized: ReturnType<typeof normalizeTeachingEntry>;
}) => {
  const observedConflict = findDictionaryObservedConflict(
    params.currentEntries,
    params.normalized.preferredTerm,
    params.normalized.observedForms ?? [],
  );
  if (!observedConflict) return false;
  const updatesReviewedEntry =
    params.draft.action === "update" &&
    params.current !== undefined &&
    params.current.termKey === params.draft.existingEntry?.termKey;
  return !(
    updatesReviewedEntry && observedConflict.termKey === params.current?.termKey
  );
};

const findTeachingEntryConflict = (params: {
  draft: DictionaryTeachingDraft;
  current?: DictionaryEntry;
  currentEntries: DictionaryEntry[];
  normalized: ReturnType<typeof normalizeTeachingEntry>;
}): string | undefined => {
  if (reviewedEntryWasRenamed(params.draft, params.normalized)) {
    return "The exact spelling changed from the reviewed existing entry. Revise and analyze the request again before updating it.";
  }
  if (reviewedEntryWasDeleted(params.draft, params.current)) {
    return "This dictionary entry was deleted after the proposal was generated. Revise and analyze the request again before updating it.";
  }
  if (targetsUnreviewedEntry(params.draft, params.current)) {
    return "This exact spelling now matches an existing entry. Revise and analyze the request again before updating it.";
  }
  if (reviewedEntryWasChanged(params.draft, params.current)) {
    return "This dictionary entry changed after the proposal was generated. Revise and analyze the request again before updating it.";
  }
  if (targetsUnreviewedObservedConflict(params)) {
    return "This spelling or one of its observed forms now conflicts with another entry. Revise and analyze the request again before saving it.";
  }
  return undefined;
};

const prepareTeachingEntrySave = (params: {
  submitted: DictionaryTeachingCommitEntry;
  draft: DictionaryTeachingDraft;
  current?: DictionaryEntry;
  currentEntries: DictionaryEntry[];
}) => {
  const normalized = normalizeTeachingEntry(params.submitted, params.current);
  return {
    edited: teachingDraftWasEdited(params.draft, params.submitted),
    conflictError: dropsSubmittedObservedForm(params.submitted, normalized)
      ? `This entry already has the maximum ${DICTIONARY_OBSERVED_FORM_MAX_COUNT} observed forms. Remove one before approving another.`
      : findTeachingEntryConflict({
          draft: params.draft,
          current: params.current,
          currentEntries: params.currentEntries,
          normalized,
        }),
    expectedUpdatedAt: params.current?.updatedAt ?? null,
    normalized,
    submitted: params.submitted,
  };
};

const loadTeachingContextRecord = async (params: {
  token?: string;
  serverId: string;
  userId: string;
}): Promise<DictionaryTeachingContextRecord | null> => {
  if (!params.token) return null;
  const record = await dictionaryTeachingTokenStore.getContext(params.token);
  if (!record) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "This correction context has expired.",
    });
  }
  if (
    record.guildId !== params.serverId ||
    record.requesterId !== params.userId
  ) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "This correction context belongs to another request.",
    });
  }
  return record;
};

const resolveTeachingContext = async (params: {
  record: DictionaryTeachingContextRecord | null;
  serverId: string;
  userId: string;
}): Promise<DictionaryTeachingContext | undefined> => {
  let context = params.record?.context;
  if (context?.meetingId) {
    const [meeting, attendeeOverrideEnabled] = await Promise.all([
      getMeetingHistoryService(params.serverId, context.meetingId),
      resolveServerAttendeeAccessEnabled(params.serverId),
    ]);
    const access = meeting
      ? await checkUserMeetingAccess({
          guildId: params.serverId,
          meeting,
          userId: params.userId,
          attendeeOverrideEnabled,
        })
      : null;
    if (!meeting || access?.allowed !== true) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "You no longer have access to this correction context.",
      });
    }
    const resolveMentions = await createMeetingMentionReplacer(meeting);
    context = {
      ...context,
      notesDiff: context.notesDiff
        ? resolveMentions.toText(context.notesDiff)
        : undefined,
      transcriptExcerpt: context.transcriptExcerpt
        ? resolveMentions.toText(context.transcriptExcerpt)
        : undefined,
    };
  }
  if (context?.transcriptExcerpt) {
    const access = await resolveServerMeetingArtifactAccess(params.serverId);
    if (!access.transcriptAccessEnabled) {
      context = { ...context, transcriptExcerpt: undefined };
    }
  }
  return context;
};

const previewDictionaryTeaching = async (params: {
  input: TeachingPreviewInput;
  userId: string;
  request: { headers?: Record<string, string | string[] | undefined> };
}) => {
  const contextRecord = await loadTeachingContextRecord({
    token: params.input.correctionContextToken,
    serverId: params.input.serverId,
    userId: params.userId,
  });
  const context = await resolveTeachingContext({
    record: contextRecord,
    serverId: params.input.serverId,
    userId: params.userId,
  });
  const [entries, modelParams, modelChoices] = await Promise.all([
    listDictionaryEntriesService(params.input.serverId),
    resolveModelParamsForContext({
      guildId: params.input.serverId,
      userId: params.userId,
    }),
    resolveModelChoicesForContext({
      guildId: params.input.serverId,
      userId: params.userId,
    }),
  ]);
  const generated = await generateDictionaryTeachingDrafts({
    guildId: params.input.serverId,
    userId: params.userId,
    instruction: params.input.instruction,
    context,
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
  const source = contextRecord?.context.source ?? "settings";
  await dictionaryTeachingTokenStore.setDraft(token, {
    guildId: params.input.serverId,
    requesterId: params.userId,
    expiresAtMs,
    source,
    drafts: generated.drafts,
    model: generated.model,
    meetingId: contextRecord?.context.meetingId,
    correctionId: contextRecord?.context.correctionId,
  });
  if (!analyticsDisabledForRequest(params.request, params.input.doNotTrack)) {
    captureEvent("dictionary_teaching_previewed", {
      userId: params.userId,
      guildId: params.input.serverId,
      properties: {
        source,
        instruction_length: params.input.instruction.length,
        draft_count: generated.drafts.length,
        ambiguous_count: generated.drafts.filter(
          (draft) => draft.action === "needs_input",
        ).length,
        conflict_count: generated.drafts.filter(
          (draft) => draft.action === "conflict",
        ).length,
      },
    });
  }
  return { token, expiresAtMs, drafts: generated.drafts };
};

const commitDictionaryTeaching = async (
  input: TeachingCommitInput,
  userId: string,
  captureAnalytics: boolean,
) => {
  const record = assertTeachingDraftScope(
    await dictionaryTeachingTokenStore.getDraft(input.token),
    input.serverId,
    userId,
  );
  const draftsById = indexAndValidateTeachingDrafts(record, input.entries);
  const snapshot = await getDictionarySnapshotService(input.serverId);
  const currentEntries = snapshot.entries;
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
  const results: TeachingCommitResult[] = [];
  let expectedRevision = snapshot.revision;
  let snapshotInvalidated = false;
  for (const {
    conflictError,
    expectedUpdatedAt,
    normalized,
    submitted,
  } of pending) {
    const error =
      conflictError ??
      (batchConflictDraftIds.has(submitted.draftId)
        ? "This spelling conflicts with another entry in the same approval batch. Revise the request before saving it."
        : snapshotInvalidated
          ? DICTIONARY_REVIEW_CONFLICT_MESSAGE
          : undefined);
    const result = error
      ? { draftId: submitted.draftId, ok: false, error }
      : await saveTeachingEntry({
          serverId: input.serverId,
          userId,
          submitted,
          normalized,
          record,
          captureAnalytics,
          expectedUpdatedAt,
          expectedRevision,
        });
    results.push(result);
    if (result.ok) {
      expectedRevision += 1;
    } else if (error === undefined) {
      snapshotInvalidated = true;
    }
  }
  const failedCount = results.filter((result) => !result.ok).length;
  if (failedCount === 0) {
    try {
      await dictionaryTeachingTokenStore.deleteDraft(input.token);
    } catch (error) {
      console.warn(
        "Failed deleting completed dictionary teaching draft",
        error,
      );
    }
  }
  if (captureAnalytics) {
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
  }
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
        doNotTrack: z.boolean().optional().default(false),
      }),
    )
    .mutation(({ ctx, input }) =>
      previewDictionaryTeaching({
        input,
        userId: ctx.user!.id,
        request: ctx.req,
      }),
    ),
  commitTeaching: manageGuildProcedure
    .input(
      serverSchema.extend({
        token: z.string().uuid(),
        entries: z
          .array(teachingEntrySchema)
          .min(1)
          .max(DICTIONARY_TEACHING_MAX_DRAFTS),
        doNotTrack: z.boolean().optional().default(false),
      }),
    )
    .mutation(({ ctx, input }) =>
      commitDictionaryTeaching(
        input,
        ctx.user!.id,
        !analyticsDisabledForRequest(ctx.req, input.doNotTrack),
      ),
    ),
});
