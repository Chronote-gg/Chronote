import { z } from "zod";
import {
  fixtureAdmissionReferenceSchema,
  fixtureSessionOwnershipSchema,
} from "./productionIntroduction";
import type { LangfusePromptMeta } from "../services/langfusePromptService";
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const timestamp = z.string().datetime().nullable();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const fixtureFailureSchema = z.enum([
  "unbound_member",
  "unbound_audio",
  "chat_input",
  "tts_input",
  "actor_absent",
  "observer_gap",
  "decoder_failure",
  "ownership_lost",
  "input_profile_mismatch",
  "counter_overflow",
  "reattachment",
  "incomplete_closure",
]);
export type FixtureFailure = z.infer<typeof fixtureFailureSchema>;
export const fixtureInputEvidenceSchema = z
  .object({
    schemaVersion: z.literal(1),
    profile: z.literal("manual_script_v1"),
    reference: fixtureAdmissionReferenceSchema,
    commandId: z.string().min(1),
    actorUserId: z.string().min(1),
    scriptSha256: digest,
    checklistSha256: digest,
    ownership: fixtureSessionOwnershipSchema,
    historyKey: z
      .object({
        guildId: z.string().min(1),
        channelId_timestamp: z.string().min(1),
      })
      .strict(),
    observationStartedAt: timestamp,
    captureStartedAt: timestamp,
    captureEndedAt: timestamp,
    observationEndedAt: timestamp,
    acceptedSourceId: z.string().min(1),
    acceptedPcmChunks: count,
    acceptedPcmBytes: count,
    unexpectedMembers: count,
    unexpectedSourceAttempts: count,
    rejectedMessages: count,
    rejectedAttachments: count,
    ttsAttempts: count,
    continuityFailures: count,
    overflow: z.boolean(),
    state: z.enum(["observing", "closed", "incomplete", "contaminated"]),
    failureReasons: z
      .array(fixtureFailureSchema)
      .max(fixtureFailureSchema.options.length),
  })
  .strict();
export type FixtureInputEvidence = z.infer<typeof fixtureInputEvidenceSchema>;
const promptSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z.object({ kind: z.literal("missing") }).strict(),
  z
    .object({
      kind: z.literal("resolved"),
      name: z.string().min(1).max(256),
      version: count,
      fallback: z.boolean(),
    })
    .strict(),
]);
export const fixtureGenerationSchema = z
  .object({
    schemaVersion: z.literal(1),
    submitted: count,
    acknowledged: count,
    missing: count,
    overflow: z.boolean(),
    tuples: z
      .array(
        z
          .object({
            stage: z.string().min(1).max(64),
            requestedModel: z.string().min(1).max(256),
            returnedModel: z.string().min(1).max(256).nullable(),
            providerRevision: z.literal("unavailable"),
            prompt: promptSchema,
            count,
          })
          .strict(),
      )
      .max(64),
  })
  .strict();
export type FixtureGenerationEvidence = z.infer<typeof fixtureGenerationSchema>;
export type GenerationObserver = (
  stage: string,
  requestedModel: string,
  prompt: LangfusePromptMeta | null | undefined,
) => (returnedModel: string | null) => void;
export const fixtureTranscriptSchema = z
  .object({
    key: z.string().min(1),
    checksumSha256: digest,
    byteLength: count,
    acknowledgment: z.discriminatedUnion("state", [
      z.object({ state: z.literal("unknown") }).strict(),
      z
        .object({
          state: z.literal("acknowledged"),
          versionId: z.string().min(1).nullable(),
        })
        .strict(),
    ]),
  })
  .strict();
export type FixtureTranscriptEvidence = z.infer<typeof fixtureTranscriptSchema>;
