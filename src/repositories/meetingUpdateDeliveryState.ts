import {
  canonicalWriterAllowsEdit,
  canonicalWriterSchema,
} from "../types/meetingCanonicalWriter";
import { repairPublicationOwnerSchema } from "../types/meetingPublication";
import { matchesPublicationSnapshot } from "../types/meetingPublication";
import {
  nextCanonicalFieldRevisions,
  validateCanonicalFieldRevisions,
} from "../types/meetingCanonicalContent";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { marshall } from "@aws-sdk/util-dynamodb";
import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import type { MeetingHistory } from "../types/db";
import type { MeetingContentWrite } from "./meetingUpdateDeliveryRepository";
import {
  assertMeetingUpdateDeliveryTransition,
  meetingUpdateDeliverySchema,
  meetingUpdateDeliveryTransitionSchema,
  meetingUpdateMutationSchema,
  meetingUpdateDeliveryNextCheck,
  notesPointersSchema,
  presentationPartSchema,
  readMeetingUpdateRevisions,
  requestMeetingUpdateDelivery,
  MEETING_UPDATE_DELIVERY_QUEUE,
  knownCreatedCandidates,
  candidateRegisteredOrDeleted,
  type MeetingUpdateDelivery,
  type MeetingUpdateDeliveryTransition,
  type NotesPointers,
  type MeetingUpdateMutation,
} from "../types/meetingUpdateDelivery";
import { retainCleanupCandidates } from "../types/meetingUpdateCleanup";
import { trimNotesForHistory } from "../utils/notesHistory";

export const MAX_MEETING_ITEM_BYTES = 400 * 1024;
const NUMBER_STORAGE_OVERHEAD_BYTES = 2;
const seconds = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const meetingUpdateKeySchema = z
  .object({
    guildId: z.string().min(1).max(512),
    channelId_timestamp: z.string().min(1).max(512),
  })
  .strict();
const rowBoundary = z.object({
  guildId: z.string().min(1),
  channelId_timestamp: z.string().min(1),
  meetingId: z.string().min(1),
  channelId: z.string(),
  timestamp: z.string(),
  participants: z.array(z.unknown()),
  duration: z.number(),
  transcribeMeeting: z.boolean(),
  generateNotes: z.boolean(),
});
export function parseMeetingUpdateHistory(
  raw: Record<string, unknown>,
): MeetingHistory {
  rowBoundary.parse(raw);
  validateCanonicalFieldRevisions(raw);
  if (raw.canonicalWriter !== undefined)
    raw = {
      ...raw,
      canonicalWriter: canonicalWriterSchema.parse(raw.canonicalWriter),
    };
  if (raw.publicationRepair !== undefined)
    raw = {
      ...raw,
      publicationRepair: repairPublicationOwnerSchema.parse(
        raw.publicationRepair,
      ),
    };
  readMeetingUpdateRevisions(raw);
  if (raw.updateDelivery !== undefined)
    raw = {
      ...raw,
      updateDelivery: meetingUpdateDeliverySchema.parse(raw.updateDelivery),
    };
  // Legacy history has no complete runtime schema. Validate identity and owned state here.
  return raw as unknown as MeetingHistory;
}
export function pointersFor(history: MeetingHistory): NotesPointers {
  return notesPointersSchema.parse({
    notesChannelId: history.notesChannelId ?? null,
    notesMessageIds: history.notesMessageIds ?? [],
  });
}
export function withDelivery(
  history: MeetingHistory,
  delivery: MeetingUpdateDelivery,
): MeetingHistory {
  const next = {
    ...history,
    updateDelivery: meetingUpdateDeliverySchema.parse(delivery),
  };
  const due = meetingUpdateDeliveryNextCheck(next.updateDelivery);
  delete next.updateDeliveryQueue;
  delete next.updateDeliveryDueAt;
  if (due !== undefined && history.publicationRepair?.kind !== "running") {
    next.updateDeliveryQueue = MEETING_UPDATE_DELIVERY_QUEUE;
    next.updateDeliveryDueAt = due;
  }
  return next;
}
export function contentMatches(
  history: MeetingHistory,
  input: Pick<
    MeetingContentWrite,
    "expectedContentRevision" | "expectedDeliveryRevision"
  >,
): boolean {
  return (
    readMeetingUpdateRevisions(history).contentRevision ===
      input.expectedContentRevision &&
    (history.updateDelivery?.revision ?? null) ===
      input.expectedDeliveryRevision
  );
}
export function mutationFingerprint(input: MeetingContentWrite): string {
  return createHash("sha256")
    .update(JSON.stringify(marshall(input, { removeUndefinedValues: true })))
    .digest("hex");
}

export function canCompareContentWrite(
  row: MeetingHistory | undefined,
  input: MeetingContentWrite,
): row is MeetingHistory {
  return Boolean(
    row &&
    canonicalWriterAllowsEdit(row) &&
    contentMatches(row, input) &&
    (!input.expectedPublication ||
      matchesPublicationSnapshot(row, input.expectedPublication)) &&
    (!input.notesEdit ||
      readMeetingUpdateRevisions(row).notesVersion ===
        input.notesEdit.expectedNotesVersion),
  );
}

export function prepareContentWrite(
  history: MeetingHistory,
  input: MeetingContentWrite,
): MeetingHistory {
  meetingUpdateKeySchema.parse(input.key);
  seconds.parse(input.expectedContentRevision);
  z.string().min(1).max(512).nullable().parse(input.expectedDeliveryRevision);
  z.string().min(1).max(512).parse(input.mutationId);
  seconds.parse(input.at);
  const mutation = meetingUpdateMutationSchema.parse(input.mutation);
  const requested = requestMeetingUpdateDelivery({
    history,
    mutation,
    revision: input.nextDelivery.revision,
    now: input.at,
    policy: input.nextDelivery.policy,
  });
  if (
    !isDeepStrictEqual(
      requested,
      meetingUpdateDeliverySchema.parse(input.nextDelivery),
    )
  )
    throw new Error("Content write must preserve the exact requested delivery");
  const changes =
    mutation.kind === "correction" ? mutation.changes : [mutation];
  const notes = changes.find((change) => change.kind === "notes");
  if (Boolean(notes) !== Boolean(input.notesEdit))
    throw new Error("Notes mutation requires notes edit provenance");
  const editedAt = new Date(input.at * 1000).toISOString();
  let next = withDelivery(
    {
      ...history,
      contentRevision: input.expectedContentRevision + 1,
      updatedAt: editedAt,
      contentMutation: {
        id: input.mutationId,
        fingerprint: mutationFingerprint(input),
        ...nextCanonicalFieldRevisions(
          history,
          changes,
          input.expectedContentRevision + 1,
        ),
      },
    },
    requested,
  );
  for (const change of changes) {
    if (change.kind === "rename") next.meetingName = change.meetingName;
    if (change.kind === "summarySentence") next.summarySentence = change.value;
    if (change.kind === "summaryLabel") next.summaryLabel = change.value;
  }
  if (notes && input.notesEdit)
    next = withNotesAudit(history, next, notes, input.notesEdit, editedAt);
  assertMeetingItemSize(next);
  return next;
}

function withNotesAudit(
  history: MeetingHistory,
  next: MeetingHistory,
  notes: Extract<MeetingUpdateMutation, { kind: "notes" }>,
  edit: NonNullable<MeetingContentWrite["notesEdit"]>,
  editedAt: string,
): MeetingHistory {
  z.number().int().positive().parse(edit.expectedNotesVersion);
  z.string().min(1).parse(edit.editedBy);
  const notesVersion = edit.expectedNotesVersion + 1;
  return {
    ...next,
    notes: notes.notes,
    notesVersion,
    notesLastEditedBy: edit.editedBy,
    notesLastEditedAt: editedAt,
    notesDelta:
      notes.notesDelta === null
        ? undefined
        : notes.notesDelta === undefined
          ? history.notesDelta
          : notes.notesDelta,
    notesHistory: [
      ...(history.notesHistory ?? []),
      {
        version: notesVersion,
        notes: trimNotesForHistory(notes.notes),
        editedBy: edit.editedBy,
        editedAt,
        source: edit.source,
      },
    ],
    suggestionsHistory: edit.suggestion
      ? [...(history.suggestionsHistory ?? []), edit.suggestion]
      : history.suggestionsHistory,
  };
}
export function isExactContentMutation(
  row: MeetingHistory | undefined,
  input: MeetingContentWrite,
): row is MeetingHistory {
  return Boolean(
    row &&
    row.contentMutation?.id === input.mutationId &&
    row.contentMutation.fingerprint === mutationFingerprint(input),
  );
}

export function applyDeliveryChange(
  before: MeetingUpdateDelivery,
  raw: MeetingUpdateDeliveryTransition,
): MeetingUpdateDelivery {
  const change = meetingUpdateDeliveryTransitionSchema.parse(raw);
  let next: MeetingUpdateDelivery;
  if (change.kind === "progress")
    next = { ...before, revision: change.revision, progress: change.progress };
  else if (change.kind === "policy") {
    const progress =
      before.progress.kind === "pending" || before.progress.kind === "retrying"
        ? { ...before.progress, nextCheckAt: change.nextCheckAt }
        : before.progress;
    next = {
      ...before,
      revision: change.revision,
      policy: change.policy,
      progress,
    };
  } else next = completeCapturedDelivery(before, change);
  if (change.kind === "progress") {
    if (
      change.progress.kind === "retrying" ||
      (change.progress.kind === "blocked" &&
        change.progress.reason === "retry_exhausted")
    )
      next.attempts = before.attempts + 1;
  }
  const candidates =
    "attempt" in next.progress
      ? before.createdCandidates
      : [
          ...before.createdCandidates,
          ...knownCreatedCandidates(before.progress),
        ];
  next.createdCandidates = candidates.filter(
    (candidate, index) =>
      !candidateRegisteredOrDeleted(candidate, before.progress) &&
      candidates.findIndex((other) => isDeepStrictEqual(candidate, other)) ===
        index,
  );
  next.cleanupCandidates =
    "attempt" in next.progress
      ? before.cleanupCandidates
      : retainCleanupCandidates(before);
  assertMeetingUpdateDeliveryTransition(before, next);
  return meetingUpdateDeliverySchema.parse(next);
}

function completeCapturedDelivery(
  before: MeetingUpdateDelivery,
  change: Extract<MeetingUpdateDeliveryTransition, { kind: "complete" }>,
): MeetingUpdateDelivery {
  if (
    !("attempt" in before.progress) ||
    before.progress.attempt.attemptId !== change.attemptId
  )
    throw new Error("Completion requires the exact captured attempt");
  const parts = structuredClone(before.parts);
  for (const part of presentationPartSchema.options)
    parts[part].acknowledged = Math.max(
      parts[part].acknowledged,
      before.progress.attempt.capturedParts[part] ?? 0,
    );
  const pending = presentationPartSchema.options.some(
    (part) => parts[part].desired !== parts[part].acknowledged,
  );
  return {
    ...before,
    revision: change.revision,
    parts,
    attempts: 0,
    lastSuccess: {
      at: change.completedAt,
      contentRevision: before.progress.attempt.contentRevision,
    },
    progress: pending
      ? { kind: "pending", nextCheckAt: change.completedAt }
      : { kind: "synced", syncedAt: change.completedAt },
  };
}

function numberBytes(value: string): number {
  // Text length plus two bytes bounds packed digits, exponent and sign overhead.
  return Buffer.byteLength(value) + NUMBER_STORAGE_OVERHEAD_BYTES;
}
function attributeBytes(value: AttributeValue): number {
  if (value.S !== undefined) return Buffer.byteLength(value.S);
  if (value.N !== undefined) return numberBytes(value.N);
  if (value.B !== undefined) return value.B.byteLength;
  if (value.M !== undefined)
    return (
      3 +
      Object.entries(value.M).reduce(
        (sum, [key, item]) =>
          sum + Buffer.byteLength(key) + 1 + attributeBytes(item),
        0,
      )
    );
  if (value.L !== undefined)
    return 3 + value.L.reduce((sum, item) => sum + 1 + attributeBytes(item), 0);
  if (value.SS !== undefined)
    return value.SS.reduce((sum, item) => sum + Buffer.byteLength(item), 0);
  if (value.NS !== undefined)
    return value.NS.reduce((sum, item) => sum + numberBytes(item), 0);
  if (value.BS !== undefined)
    return value.BS.reduce((sum, item) => sum + item.byteLength, 0);
  return 1;
}
export function assertMeetingItemSize(history: MeetingHistory): void {
  const item = marshall(history, { removeUndefinedValues: true });
  const size = Object.entries(item).reduce(
    (sum, [key, value]) => sum + Buffer.byteLength(key) + attributeBytes(value),
    0,
  );
  if (size > MAX_MEETING_ITEM_BYTES)
    throw new Error("Meeting item size exceeds DynamoDB limit");
}
