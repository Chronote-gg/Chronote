import { createHash } from "node:crypto";
import { z } from "zod";
import type { MeetingHistory } from "../types/db";
import { MEETING_STATUS } from "../types/meetingLifecycle";
import {
  recordingCaptureStateSchema,
  captureCoverageSummarySchema,
} from "../types/recordingCheckpoint";
import {
  discordBotIdentitySchema,
  discordChannelSchema,
  discordEditorMessageSchema,
  type DiscordEditorMessage,
} from "./discordMessageEditor";
export class PublicationPreviewBlockedError extends Error {}

const id = z.string().regex(/^\d+$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const key = z
  .string()
  .min(1)
  .refine(
    (value) =>
      value
        .split("/")
        .every(
          (part) =>
            part !== "" &&
            part !== "." &&
            part !== ".." &&
            !part.includes("\\"),
        ),
    "Invalid object key",
  );
const object = z.record(z.string(), z.unknown());
export const publicationScopeSchema = z
  .object({
    accountId: z.string().regex(/^\d{12}$/),
    region: z.string().min(1),
    table: z.string().min(1),
    bucket: z.string().min(1),
    guildId: id,
    meetingKey: z.string().min(1),
    recoveryManifestKey: key,
  })
  .strict();
export type PublicationScope = z.infer<typeof publicationScopeSchema>;

const operatorRecoverySchema = z.object({
  appliedAt: z.string().min(1),
  completenessVerified: z.boolean(),
  id: z.string().min(1),
  language: z.string().min(1),
  manifestS3Key: key,
  notesSha256: hash,
  notificationStatus: z.string(),
  notionSyncStatus: z.string(),
  operatorActorArn: z.string().min(1),
  originalNotesVersion: z.number().int().positive(),
  originalTranscriptS3Key: key,
  transcriptSha256: hash,
});
const historyShape = {
  guildId: id,
  channelId_timestamp: z.string().min(1),
  channelId: id,
  timestamp: z.iso.datetime(),
  meetingId: z.string().min(1),
  notes: z.string().min(1),
  notesVersion: z.number().int().positive(),
  meetingName: z.string().optional(),
  summarySentence: z.string().optional(),
  summaryLabel: z.string().optional(),
  transcriptS3Key: key,
  notesChannelId: id,
  notesMessageIds: z.array(id).min(1),
  summaryMessageId: id.optional(),
  textChannelId: id.optional(),
  capture: recordingCaptureStateSchema.optional(),
  captureCoverage: captureCoverageSummarySchema.optional(),
  status: z.enum(MEETING_STATUS).optional(),
  processing: z
    .object({
      transcription: z.enum(["ready", "empty", "partial", "failed"]).optional(),
      notes: z.enum(["generated", "skipped", "failed"]).optional(),
      summary: z.enum(["generated", "skipped", "failed"]).optional(),
    })
    .optional(),
};
type PublicationHistoryFields = Pick<MeetingHistory, keyof typeof historyShape>;
export const publicationHistorySchema = z.object({
  ...historyShape,
  operatorRecovery: operatorRecoverySchema,
});
export type PublicationHistory = PublicationHistoryFields &
  z.infer<typeof publicationHistorySchema>;
export const recoveryPublicationManifestSchema = z.object({
  id: z.string().min(1),
  meetingId: z.string().min(1),
  language: z.string().min(1),
  approvedBy: z.string().min(1),
  approvedScope: z.string().min(1),
  nextNotesVersion: z.number().int().positive(),
  uncertaintiesRetained: z.literal(true),
  processingPartialWarningPreserved: z.literal(true),
  previous: z.object({
    transcriptKey: key,
    notesVersion: z.number().int().positive(),
  }),
  objects: z
    .array(z.object({ role: z.string().min(1), key, sha256: hash }))
    .min(2),
});

export const footer = z.object({
  text: z.string(),
  icon_url: z.string().optional(),
});
const image = z.object({ url: z.string() });
export const editableEmbedSchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  url: z.string().optional(),
  timestamp: z.string().optional(),
  color: z.number().int().min(0).max(0xffffff).optional(),
  footer: footer.optional(),
  image: image.optional(),
  thumbnail: image.optional(),
  author: z
    .object({
      name: z.string(),
      url: z.string().optional(),
      icon_url: z.string().optional(),
    })
    .optional(),
  fields: z
    .array(
      z.object({
        name: z.string(),
        value: z.string(),
        inline: z.boolean().optional(),
      }),
    )
    .optional(),
});
export function normalizePublicationEmbeds(embeds: unknown[]) {
  return embeds.map((embed) => editableEmbedSchema.parse(embed));
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, child]) => [name, canonical(child)]),
    );
  return value;
}
export function stablePublicationJson(value: unknown): string {
  return JSON.stringify(canonical(value));
}
export function publicationDigest(value: unknown): string {
  const parsed = object.parse(value);
  const { previewDigest: _digest, ...data } = parsed;
  void _digest;
  return createHash("sha256").update(stablePublicationJson(data)).digest("hex");
}
export function digest(value: unknown): string {
  return createHash("sha256")
    .update(stablePublicationJson(value))
    .digest("hex");
}
export function publicationMessageFingerprint(
  message: DiscordEditorMessage,
): string {
  return digest({
    id: message.id,
    channel_id: message.channel_id,
    author: { id: message.author.id, bot: message.author.bot },
    webhook_id: message.webhook_id,
    content: message.content,
    embeds: normalizePublicationEmbeds(message.embeds),
    components: message.components,
    attachments: message.attachments.map(
      ({ id, filename, description, size, content_type, ephemeral }) => ({
        id,
        filename,
        description,
        size,
        content_type,
        ephemeral,
      }),
    ),
    flags: message.flags,
  });
}
export const bindingSchema = z.object({
  meetingId: z.string(),
  notesVersion: z.number().int().positive(),
  transcriptS3Key: key,
  storedFieldsDigest: hash,
  manifestDigest: hash,
  artifactFolder: z.string(),
  recoveryPrefix: z.string(),
  claimKey: key,
});
export const targetSchema = z.object({
  role: z.enum(["notes", "summary"]),
  channelId: id,
  messageId: id,
  url: z.string(),
  before: discordEditorMessageSchema,
  beforeFingerprint: hash,
  afterEmbeds: z.array(object),
  afterFingerprint: hash,
  afterEmbedsDigest: hash,
  unchanged: z.boolean(),
  changes: z.array(
    z.object({
      embedIndex: z.number().int().nonnegative(),
      before: object,
      after: object,
    }),
  ),
});
const previewCommon = {
  schemaVersion: z.literal(1),
  scope: publicationScopeSchema,
  createdAt: z.iso.datetime(),
  botId: id.nullable(),
  targets: z.array(targetSchema),
  previewDigest: hash,
};
export const recoveryDiscordPreviewSchema = z.discriminatedUnion("kind", [
  z.object({
    ...previewCommon,
    kind: z.literal("ready"),
    binding: bindingSchema,
    blockers: z.array(z.string()).length(0),
  }),
  z.object({
    ...previewCommon,
    kind: z.literal("blocked"),
    binding: bindingSchema.nullable(),
    blockers: z.array(z.string()).min(1),
  }),
]);
export type RecoveryDiscordPreview = z.infer<
  typeof recoveryDiscordPreviewSchema
>;
export const publicationMessageReceiptSchema = z.object({
  channelId: id,
  messageId: id,
  runId: z.string().min(1),
  state: z.enum(["pending", "submitted", "verified", "failed", "uncertain"]),
  updatedAt: z.iso.datetime(),
  beforeFingerprint: hash,
  desiredFingerprint: hash,
  observedFingerprint: hash.nullable(),
  reason: z.string().nullable(),
});
export const publicationReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().min(1),
  previewDigest: hash,
  meetingId: z.string(),
  notesVersion: z.number().int().positive(),
  storedFieldsDigest: hash,
  status: z.enum([
    "running",
    "verified",
    "partial",
    "uncertain",
    "superseded",
    "failed",
  ]),
  startedAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  messages: z.array(publicationMessageReceiptSchema),
});
export type PublicationReceipt = z.infer<typeof publicationReceiptSchema>;
export const publicationClaimSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().min(1),
  previewDigest: hash,
  meetingId: z.string(),
  notesVersion: z.number().int().positive(),
  state: z.enum(["running", "terminal"]),
  receiptKey: key,
  unresolvedMessageIds: z.array(id),
});
export type PublicationClaim = z.infer<typeof publicationClaimSchema>;
const conditionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("absent") }),
  z.object({ kind: z.literal("match"), etag: z.string().min(1) }),
]);
const targetInput = z.object({ channelId: id, messageId: id });
export const publicationDependenciesSchema = z.object({
  readHistory: z.function({
    input: [publicationScopeSchema],
    output: z.promise(z.unknown()),
  }),
  readManifest: z.function({
    input: [publicationScopeSchema],
    output: z.promise(z.unknown()),
  }),
  now: z.function({ input: [], output: z.iso.datetime() }),
  discord: z.object({
    getBotIdentity: z.function({
      input: [],
      output: z.promise(discordBotIdentitySchema),
    }),
    getChannel: z.function({
      input: [id],
      output: z.promise(discordChannelSchema),
    }),
    getMessage: z.function({
      input: [targetInput],
      output: z.promise(discordEditorMessageSchema.nullable()),
    }),
    editEmbeds: z.function({
      input: [targetInput.extend({ embeds: z.array(object) })],
      output: z.promise(z.enum(["acknowledged", "missing"])),
    }),
  }),
  storage: z.object({
    savePreview: z.function({
      input: [recoveryDiscordPreviewSchema],
      output: z.promise(z.void()),
    }),
    readReceipt: z.function({
      input: [key],
      output: z.promise(
        z
          .object({ value: publicationReceiptSchema, etag: z.string() })
          .nullable(),
      ),
    }),
    saveReceipt: z.function({
      input: [
        z.object({
          key,
          receipt: publicationReceiptSchema,
          condition: conditionSchema,
        }),
      ],
      output: z.promise(z.string()),
    }),
    readClaim: z.function({
      input: [key],
      output: z.promise(
        z
          .object({ value: publicationClaimSchema, etag: z.string() })
          .nullable(),
      ),
    }),
    writeClaim: z.function({
      input: [
        z.object({
          key,
          claim: publicationClaimSchema,
          condition: conditionSchema,
        }),
      ],
      output: z.promise(z.string()),
    }),
  }),
});
export type PublicationDependencies = z.infer<
  typeof publicationDependenciesSchema
>;

export function recoveryPublicationLocation(
  scope: PublicationScope,
  history: PublicationHistory,
  manifest: z.infer<typeof recoveryPublicationManifestSchema>,
) {
  const artifactFolder = manifest.previous.transcriptKey.slice(
    0,
    manifest.previous.transcriptKey.lastIndexOf("/") + 1,
  );
  const expectedSuffix = `${history.guildId}/${history.channelId}_${history.meetingId}_${new Date(history.timestamp).toISOString().replace(/:/g, "-")}/`;
  const recoveryPrefix = scope.recoveryManifestKey.slice(
    0,
    scope.recoveryManifestKey.lastIndexOf("/") + 1,
  );
  if (
    !artifactFolder.endsWith(expectedSuffix) ||
    history.guildId !== scope.guildId ||
    history.channelId_timestamp !== scope.meetingKey ||
    manifest.meetingId !== history.meetingId ||
    recoveryPrefix !== `${artifactFolder}recovery/${manifest.id}/`
  )
    throw new PublicationPreviewBlockedError(
      "Recovery directory does not belong to selected meeting",
    );
  return {
    artifactFolder,
    recoveryPrefix,
    meetingId: manifest.meetingId,
    notesVersion: manifest.nextNotesVersion,
    claimKey: `${artifactFolder}recovery/discord-publication/claims/${manifest.nextNotesVersion}.json`,
  };
}

export function bindRecoveryPublication(
  scope: PublicationScope,
  history: PublicationHistory,
  manifest: z.infer<typeof recoveryPublicationManifestSchema>,
) {
  const recovery = history.operatorRecovery;
  const { artifactFolder, recoveryPrefix } = recoveryPublicationLocation(
    scope,
    history,
    manifest,
  );
  const notes = manifest.objects.filter((entry) => entry.role === "notes");
  const transcripts = manifest.objects.filter(
    (entry) => entry.role === "transcript",
  );
  if (notes.length !== 1 || transcripts.length !== 1)
    throw new PublicationPreviewBlockedError(
      "Stored recovery manifest must identify exactly one notes and transcript object",
    );
  const notesSha256 = createHash("sha256").update(history.notes).digest("hex");
  const identities = [
    [history.guildId, scope.guildId],
    [history.channelId_timestamp, scope.meetingKey],
    [manifest.meetingId, history.meetingId],
    [recoveryPrefix, `${artifactFolder}recovery/${manifest.id}/`],
    [recovery.manifestS3Key, scope.recoveryManifestKey],
    [recovery.id, manifest.id],
    [recovery.language, manifest.language],
    [recovery.notesSha256, notesSha256],
    [history.notesVersion, manifest.nextNotesVersion],
    [recovery.originalNotesVersion, manifest.previous.notesVersion],
    [recovery.originalTranscriptS3Key, manifest.previous.transcriptKey],
    [notes[0].sha256, notesSha256],
    [transcripts[0].key, history.transcriptS3Key],
    [transcripts[0].sha256, recovery.transcriptSha256],
  ];
  const objectsBound = manifest.objects.every(
    (entry) =>
      entry.key.startsWith(recoveryPrefix) &&
      !entry.key.slice(recoveryPrefix.length).includes("/"),
  );
  if (
    !identities.every(([actual, expected]) => actual === expected) ||
    !objectsBound ||
    new Set(manifest.objects.map((entry) => entry.key)).size !==
      manifest.objects.length
  )
    throw new PublicationPreviewBlockedError(
      "Stored meeting and approved recovery manifest do not match",
    );
  return bindingSchema.parse({
    meetingId: history.meetingId,
    notesVersion: history.notesVersion,
    transcriptS3Key: history.transcriptS3Key,
    storedFieldsDigest: digest(history),
    manifestDigest: digest(manifest),
    artifactFolder,
    recoveryPrefix,
    claimKey: `${artifactFolder}recovery/discord-publication/claims/${history.notesVersion}.json`,
  });
}
