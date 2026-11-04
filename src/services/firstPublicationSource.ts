import { z } from "zod";
import type { MeetingHistory } from "../types/db";
import {
  publicationKeySchema,
  publicationProfileSchema,
  hash,
  digest,
  keyId,
  type PublicationSelection,
  type PublicationProfile,
  type BoundRecovery,
} from "./firstPublicationTypes";
const entry = z.union([
  publicationKeySchema,
  z.object({ bundle: z.string().min(1) }).strict(),
]);
export function normalizePublicationSelection(
  input: unknown,
  bundles: ReadonlyMap<string, unknown>,
): PublicationSelection {
  const raw = z.array(entry).min(1).parse(input);
  const result = new Map<string, z.infer<typeof publicationKeySchema>>();
  const identities = new Map<string, string>();
  for (const e of raw) {
    const refs =
      "bundle" in e
        ? z
            .object({
              meetings: z.array(
                z.object({
                  key: publicationKeySchema,
                  meetingId: z.string().optional(),
                }),
              ),
            })
            .parse(bundles.get(e.bundle)).meetings
        : [{ key: e, meetingId: undefined }];
    for (const ref of refs) {
      const id = keyId(ref.key),
        prior = identities.get(id);
      if (prior && ref.meetingId && prior !== ref.meetingId)
        throw Error("Conflicting recovery bundle identities");
      if (ref.meetingId) identities.set(id, ref.meetingId);
      result.set(id, ref.key);
    }
  }
  const values = [...result.values()];
  if (values.length < 1 || values.length > 25)
    throw Error("Select 1 to 25 meetings");
  return values;
}
export const recoveryV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    id: z.uuid(),
    manifestS3Key: z.string(),
    notesSha256: z.string(),
    transcriptSha256: z.string(),
    previousNotesVersion: z.number().nullable(),
    previousTranscriptS3Key: z.string().nullable(),
    preparedAt: z.iso.datetime(),
    approvedBy: z.string().min(1),
    language: z.string().min(1),
    classification: z.enum(["partial_notes", "setup_fragment"]),
    completenessVerified: z.literal(false),
    notificationStatus: z.literal("held"),
    notionSyncStatus: z.literal("held"),
  })
  .strict();
const manifestSchema = z
  .object({
    schemaVersion: z.literal(2),
    id: z.uuid(),
    meetingId: z.uuid(),
    key: publicationKeySchema,
    language: z.string(),
    classification: z.enum(["partial_notes", "setup_fragment"]),
    preparedAt: z.iso.datetime(),
    approvedBy: z.string().min(1),
    completenessVerified: z.literal(false),
    objects: z
      .array(
        z
          .object({
            key: z.string(),
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      )
      .length(3),
    publication: z.literal("stored_only"),
    sourceHashes: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
    evidence: z.record(z.string(), z.unknown()),
    unknowns: z.array(z.string()),
  })
  .strict();
export const FIRST_PUBLICATION_SNAPSHOT_FIELDS = [
  "guildId",
  "channelId_timestamp",
  "meetingId",
  "status",
  "ownerInstanceId",
  "executionVersion",
  "canonicalWriter",
  "checkpoint",
  "recovery",
  "completionPolicy",
  "delivery",
  "notes",
  "notesVersion",
  "notesHistory",
  "notesDelta",
  "contentRevision",
  "contentMutation",
  "notesLastEditedAt",
  "notesLastEditedBy",
  "suggestionsHistory",
  "transcriptS3Key",
  "operatorRecovery",
  "textChannelId",
  "channelId",
  "timestamp",
  "archivedAt",
  "archivedByUserId",
  "capture",
  "captureCoverage",
  "processing",
  "updateDelivery",
  "notesChannelId",
  "notesMessageIds",
  "summaryMessageId",
  "publicationRepair",
];
export function firstPublicationSnapshot(
  row: MeetingHistory,
): Record<string, unknown> {
  return Object.fromEntries(
    FIRST_PUBLICATION_SNAPSHOT_FIELDS.filter(
      (k) => Reflect.get(row, k) !== undefined,
    ).map((k) => [k, Reflect.get(row, k)]),
  );
}
function validRecoveryState(
  row: MeetingHistory,
  previousNotesVersion: number | null,
) {
  return [
    !!row.notes?.trim(),
    !!row.textChannelId,
    row.status === "interrupted",
    row.capture?.kind === "interrupted",
    row.processing?.transcription === "partial",
    row.captureCoverage?.kind === "unknown",
    Number.isInteger(row.notesVersion),
    row.notesVersion === (previousNotesVersion ?? 1) + 1,
    row.channelId_timestamp === row.channelId + "#" + row.timestamp,
  ].every(Boolean);
}
export function bindFirstPublicationSource(
  profile: PublicationProfile,
  row: MeetingHistory,
  rawManifest: unknown,
  objects: { notes: string; transcript: string },
): BoundRecovery {
  publicationProfileSchema.parse(profile);
  const r = recoveryV2Schema.parse(row.operatorRecovery),
    m = manifestSchema.parse(rawManifest);
  const key = publicationKeySchema.parse({
      guildId: row.guildId,
      channelId_timestamp: row.channelId_timestamp,
    }),
    prefix = `ops/operator-recovery/${r.id}/${row.meetingId}/`;
  const same = (a: unknown, b: unknown) => digest(a) === digest(b);
  const expected = {
    key,
    meetingId: row.meetingId,
    id: r.id,
    language: r.language,
    classification: r.classification,
    preparedAt: r.preparedAt,
    approvedBy: r.approvedBy,
  };
  const matches = Object.entries(expected).every(([field, value]) =>
    same(Reflect.get(m, field), value),
  );
  const sourceMatches = [
    [r.manifestS3Key, prefix + "manifest.json"],
    [row.transcriptS3Key, prefix + "transcript.json"],
    [row.notes, objects.notes],
    [hash(objects.notes), r.notesSha256],
    [hash(objects.transcript), r.transcriptSha256],
  ].every(([actual, wanted]) => actual === wanted);
  const validObjects = [
    m.objects.some(
      (o) => o.key === prefix + "notes.md" && o.sha256 === r.notesSha256,
    ),
    m.objects.some(
      (o) => o.key === row.transcriptS3Key && o.sha256 === r.transcriptSha256,
    ),
    m.objects.some((o) => o.key === prefix + "before.json"),
    new Set(m.objects.map((o) => o.key)).size === 3,
    m.objects.every(
      (o) =>
        o.key.startsWith(prefix) && !o.key.slice(prefix.length).includes("/"),
    ),
  ].every(Boolean);
  if (
    !validRecoveryState(row, r.previousNotesVersion) ||
    !matches ||
    !sourceMatches ||
    !validObjects
  )
    throw Error("Recovery source binding invalid");
  return {
    key,
    row,
    recoveryId: r.id,
    authority: `${row.meetingId}:${r.id}:${row.notesVersion}`,
    notesSha256: r.notesSha256,
    sourceDigest: digest(firstPublicationSnapshot(row)),
    manifestDigest: digest(m),
  };
}
