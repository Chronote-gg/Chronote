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
} from "../../types/dictionaryTeaching";
import {
  DICTIONARY_DEFINITION_MAX_LENGTH,
  DICTIONARY_TERM_MAX_LENGTH,
  buildDictionaryTermKey,
  normalizeDictionaryDefinition,
  normalizeDictionaryObservedForms,
  normalizeDictionaryTerm,
} from "../../utils/dictionary";
import { generateDictionaryTeachingDrafts } from "../../services/dictionaryTeachingService";
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
      if (input.correctionContextToken) {
        await dictionaryTeachingTokenStore.deleteContext(
          input.correctionContextToken,
        );
      }
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
    .mutation(async ({ ctx, input }) => {
      const record = await dictionaryTeachingTokenStore.getDraft(input.token);
      if (!record) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "This teaching draft has expired. Analyze it again.",
        });
      }
      if (
        record.guildId !== input.serverId ||
        record.requesterId !== ctx.user!.id
      ) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "This teaching draft belongs to another request.",
        });
      }
      const draftsById = new Map(
        record.drafts.map((draft) => [draft.draftId, draft]),
      );
      for (const entry of input.entries) {
        if (!draftsById.has(entry.draftId)) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "A submitted term was not part of this teaching draft.",
          });
        }
      }
      const submittedTermKeys = input.entries.map((entry) =>
        buildDictionaryTermKey(normalizeDictionaryTerm(entry.preferredTerm)),
      );
      if (new Set(submittedTermKeys).size !== submittedTermKeys.length) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Each approved entry needs unique exact spelling.",
        });
      }

      const currentEntries = await listDictionaryEntriesService(input.serverId);
      const currentByKey = new Map(
        currentEntries.map((entry) => [entry.termKey, entry]),
      );
      const results: Array<{
        draftId: string;
        ok: boolean;
        entry?: (typeof currentEntries)[number];
        error?: string;
      }> = [];
      let editedFieldCount = 0;

      for (const submitted of input.entries) {
        const draft = draftsById.get(submitted.draftId)!;
        const preferredTerm = normalizeDictionaryTerm(submitted.preferredTerm);
        const current = currentByKey.get(buildDictionaryTermKey(preferredTerm));
        const observedForms = normalizeDictionaryObservedForms([
          ...(current?.observedForms ?? []),
          ...(submitted.observedForms ?? []),
        ]);
        const description =
          submitted.description === undefined
            ? current?.definition
            : normalizeDictionaryDefinition(submitted.description);
        if (
          draft.preferredTerm !== preferredTerm ||
          (draft.description ?? undefined) !== description ||
          JSON.stringify(draft.observedForms) !==
            JSON.stringify(observedForms ?? [])
        ) {
          editedFieldCount += 1;
        }

        try {
          const entry = await upsertDictionaryEntryService({
            guildId: input.serverId,
            term: preferredTerm,
            definition: description,
            observedForms,
            lastTeaching: {
              method: "llm_assisted",
              source: record.source,
              meetingId: record.meetingId,
              correctionId: record.correctionId,
              model: record.model.model,
              promptName: record.model.promptName,
              promptVersion: record.model.promptVersion,
              approvedBy: ctx.user!.id,
              approvedAt: new Date().toISOString(),
            },
            userId: ctx.user!.id,
          });
          currentByKey.set(entry.termKey, entry);
          results.push({ draftId: submitted.draftId, ok: true, entry });
        } catch (error) {
          results.push({
            draftId: submitted.draftId,
            ok: false,
            error: error instanceof Error ? error.message : "Save failed.",
          });
        }
      }

      const failedCount = results.filter((result) => !result.ok).length;
      if (failedCount === 0) {
        await dictionaryTeachingTokenStore.deleteDraft(input.token);
      }
      captureEvent("dictionary_teaching_committed", {
        userId: ctx.user!.id,
        guildId: input.serverId,
        properties: {
          source: record.source,
          submitted_count: input.entries.length,
          saved_count: input.entries.length - failedCount,
          failed_count: failedCount,
          edited_draft_count: editedFieldCount,
        },
      });
      return { results };
    }),
});
