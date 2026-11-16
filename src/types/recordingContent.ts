import { speechRejectionSchema } from "./speechRejection";
import { transcriptCorrespondenceSchema } from "./transcriptCorrespondence";
import {
  autoCompletionPolicySchema,
  completionPolicySchema,
} from "./meetingCompletionPolicy";
import { z } from "zod";
import { savedPromptSchema } from "../services/savedRecordingPrompt";
import { recordingCaptureProvenanceSchema } from "./recordingCheckpoint";
import { speechDetectionModeSchema } from "../config/speechDetection";
const text = z.string();
const number = z.number().finite();
const participant = z
  .object({
    id: text,
    username: text,
    displayName: text.optional(),
    serverNickname: text.optional(),
    tag: text.optional(),
    roleIds: z.array(text).optional(),
  })
  .strict();
const role = z.object({ id: text, name: text }).strict();
const unavailable = z
  .object({ availability: z.literal("unavailable") })
  .strict();
const prompt = z.union([
  unavailable,
  z
    .object({ availability: z.literal("available"), value: savedPromptSchema })
    .strict(),
]);
const model = z
  .object({
    model: text.min(1),
    provider: z.literal("openai"),
    params: z
      .object({
        temperature: number.optional(),
        reasoning_effort: z
          .enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"])
          .optional(),
        verbosity: z.enum(["low", "medium", "high"]).optional(),
      })
      .strict(),
  })
  .strict();
// Recordings saved before the transcription simplification carry settings that
// no longer exist. They still parse so those recordings can finish and recover.
const legacy = z.unknown().optional();
const budgets = z
  .object({
    maxEntries: number,
    maxCharsTranscription: legacy,
    maxCharsContext: number,
  })
  .strict();
const transcription = z
  .object({
    speechDetectionMode: speechDetectionModeSchema.default("off"),
    language: legacy,
    suppressionEnabled: z.boolean(),
    suppressionHardSilenceDbfs: number,
    suppressionRateMaxSeconds: number,
    suppressionRateMinWords: number,
    suppressionRateMinSyllables: number,
    suppressionRateMaxSyllablesPerSecond: number,
    promptEchoEnabled: legacy,
    voteEnabled: legacy,
    fastSilenceMs: number,
    slowSilenceMs: number,
    minSnippetSeconds: number,
    maxSnippetMs: number,
    fastFinalizationEnabled: z.boolean(),
    interjectionEnabled: z.boolean(),
    interjectionMinSpeakerSeconds: number,
    finalPassEnabled: legacy,
    noiseGate: z
      .object({
        enabled: z.boolean(),
        windowMs: number,
        peakDbfs: number,
        minActiveWindows: number,
        minPeakAboveNoiseDb: number,
        applyToFast: z.boolean(),
        applyToSlow: z.boolean(),
      })
      .strict(),
  })
  .strict();
export const savedRecordingSettingsSchema = z
  .object({
    autoCompletion: autoCompletionPolicySchema.optional(),
    processing: z
      .object({
        cleanupMinimumRetainedLineRatio: number.min(0).max(1),
        finalPass: legacy,
      })
      .strict()
      .optional(),
    models: z
      .object({
        notes: model,
        meetingSummary: model,
        transcription: model,
        transcriptionCleanup: model,
        transcriptionCoalesce: legacy,
      })
      .strict(),
    transcription,
    dictionary: budgets,
    premiumTranscription: z
      .object({ enabled: z.boolean(), cleanupEnabled: z.boolean() })
      .strict(),
    visionCaptions: z
      .object({
        enabled: z.boolean(),
        maxImages: number,
        maxTotalChars: number,
      })
      .strict(),
    notes: z
      .object({
        longStoryTestMode: z.boolean(),
        longStoryTargetChars: number,
        contextTestMode: z.boolean(),
        enableMemory: z.boolean(),
        memoryDepth: number,
        maxContextLength: number,
      })
      .strict(),
  })
  .strict();
const context = z
  .object({
    availability: z.enum(["available", "unavailable"]),
    meetingContext: text.optional(),
    serverContext: text.optional(),
    channelContext: text.optional(),
    recentMeetings: z.array(
      z
        .object({
          timestamp: text,
          context: text.optional(),
          notes: text.optional(),
        })
        .strict(),
    ),
    formattedContext: text,
    transcriptionFormattedContext: text.optional(),
    transcriptionMaxContextLength: number.optional(),
    dictionaryEntries: z.array(
      z
        .object({
          term: text,
          definition: text.optional(),
          updatedAt: text.optional(),
        })
        .strict(),
    ),
  })
  .strict();
const base = z.object({
  schemaVersion: z.literal(1),
  capture: recordingCaptureProvenanceSchema,
  capturedAt: z.iso.datetime(),
});
export const generationContextSchema = base
  .extend({
    kind: z.literal("generation_context"),
    completion: completionPolicySchema.optional(),
    captureIncomplete: z.boolean().optional(),
    creatorId: text,
    serverName: text,
    serverDescription: text,
    voiceChannelName: text,
    events: text,
    channelNames: text,
    botDisplayName: text,
    botNames: z.array(text),
    tags: z.array(text),
    participants: z.array(participant),
    attendance: z.array(text),
    promptVisibleRoleIds: z.array(text),
    mentionableRoles: z.array(role),
    chatContext: text,
    participantRoster: text,
    roleRoster: text,
    cleanupRoleNames: text.optional(),
    attendees: text,
    settings: z.union([
      unavailable,
      z
        .object({
          availability: z.literal("available"),
          value: savedRecordingSettingsSchema,
        })
        .strict(),
    ]),
    context,
    recentMeetingNames: z.union([
      unavailable,
      z.object({ availability: z.literal("available"), value: text }).strict(),
    ]),
    prompts: z
      .object({
        notes: prompt.optional(),
        summary: prompt.optional(),
        cleanup: prompt.optional(),
        transcription: legacy,
        coalesce: legacy,
        finalPass: legacy,
      })
      .strict(),
  })
  .strict();
export const completedTranscriptionSchema = base
  .extend({
    kind: z.literal("completed_transcription"),
    speechRejections: z.array(speechRejectionSchema).optional(),
    speechRejectionEvidenceIncomplete: z.boolean().optional(),
    processing: z
      .object({
        finalPass: legacy,
        cleanup: z.enum(["acknowledged", "fallback", "disabled"]),
        finalText: text,
        correspondence: transcriptCorrespondenceSchema.optional(),
        supplementalEntries: z.literal(true).optional(),
      })
      .strict()
      .optional(),
    omitted: transcriptCorrespondenceSchema.optional(),
    entries: z.array(
      z
        .object({
          sourceId: text,
          userId: text,
          source: z.enum(["voice", "chat_tts", "bot"]),
          timestamp: number,
          text: text.min(1),
          speakerLabel: text,
          completedAt: z.iso.datetime(),
          revision: z.number().int().nonnegative(),
          correspondence: transcriptCorrespondenceSchema.optional(),
        })
        .strict()
        .refine(
          (entry) =>
            entry.correspondence?.kind !== "pcm" ||
            entry.correspondence.spans.every(
              (span) => span.sourceId === entry.sourceId,
            ),
          "Transcript receipt source differs from entry",
        ),
    ),
  })
  .strict();
export type SavedRecordingSettings = z.infer<
  typeof savedRecordingSettingsSchema
>;
export type GenerationContextCheckpoint = z.infer<
  typeof generationContextSchema
>;
export type CompletedTranscriptionCheckpoint = z.infer<
  typeof completedTranscriptionSchema
>;
