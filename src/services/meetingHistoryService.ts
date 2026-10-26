import { stableJson } from "../utils/stableJson";
import {
  meetingUpdateDeliverySchema,
  presentationPartSchema,
} from "../types/meetingUpdateDelivery";
import { isDeepStrictEqual } from "node:util";
import {
  publicationSnapshot,
  initialMeetingUpdatePolicy,
  PUBLICATION_SNAPSHOT_FIELDS,
} from "../types/meetingPublication";
import type { RuntimeApiOperation } from "./runtimeApiOperationService";
import type { MeetingData } from "../types/meeting-data";
import {
  HISTORY_TRANSITION_FIELDS,
  type HistoryTransition,
} from "../types/deploymentControl";
import type {
  MeetingAccessGrant,
  MeetingHistory,
  NotesEditSource,
  SuggestionHistoryEntry,
} from "../types/db";
import type { MeetingStatus } from "../types/meetingLifecycle";
import { getMeetingHistoryRepository } from "../repositories/meetingHistoryRepository";
import {
  replaceMeetingUserIndexForMeetingService,
  writeMeetingUserIndexForMeetingService,
} from "./meetingUserIndexService";
import { updateMeeting } from "./meetingUpdateService";
import type { MeetingUpdateMutation } from "../types/meetingUpdateDelivery";

export async function writeMeetingHistoryService(history: MeetingHistory) {
  await getMeetingHistoryRepository().write(history);
  try {
    await writeMeetingUserIndexForMeetingService(history);
  } catch (error) {
    console.error("Failed to update meeting user index", {
      guildId: history.guildId,
      meetingId: history.meetingId,
      error,
    });
  }
}

export async function getMeetingHistoryService(
  guildId: string,
  channelIdTimestamp: string,
) {
  return getMeetingHistoryRepository().get(guildId, channelIdTimestamp);
}

export async function listRecentMeetingsForGuildService(
  guildId: string,
  limit?: number,
  options?: {
    archivedOnly?: boolean;
    includeArchived?: boolean;
    signal?: AbortSignal;
  },
) {
  return getMeetingHistoryRepository().listRecentByGuild(
    guildId,
    limit,
    options,
  );
}

export async function listMeetingsForGuildInRangeService(
  guildId: string,
  startTimestamp: string,
  endTimestamp: string,
  limit?: number,
) {
  return getMeetingHistoryRepository().listByGuildTimestampRange(
    guildId,
    startTimestamp,
    endTimestamp,
    limit,
  );
}

const MIN_TIMESTAMP_ISO = "1970-01-01T00:00:00.000Z";
const MAX_TIMESTAMP_ISO = "9999-12-31T23:59:59.999Z";

export async function listAllMeetingsForGuildService(
  guildId: string,
  signal?: AbortSignal,
) {
  return getMeetingHistoryRepository().listByGuildTimestampRange(
    guildId,
    MIN_TIMESTAMP_ISO,
    MAX_TIMESTAMP_ISO,
    undefined,
    signal,
  );
}

export async function listRecentMeetingsForChannelService(
  guildId: string,
  channelId: string,
  limit?: number,
  signal?: AbortSignal,
) {
  return getMeetingHistoryRepository().listRecentByChannel(
    guildId,
    channelId,
    limit,
    signal ? { signal } : undefined,
  );
}

export async function updateMeetingNotesService(
  params: {
    guildId: string;
    channelId_timestamp: string;
    notes: string;
    notesDelta?: unknown | null;
    notesVersion: number;
    editedBy: string;
    summarySentence?: string;
    summaryLabel?: string;
    meetingName?: string;
    suggestion?: SuggestionHistoryEntry;
    source?: NotesEditSource;
    expectedPreviousVersion?: number;
    metadata?: { notesMessageIds?: string[]; notesChannelId?: string };
  },
  signal?: AbortSignal,
  operation?: RuntimeApiOperation,
) {
  const changes: Extract<
    MeetingUpdateMutation,
    { kind: "correction" }
  >["changes"] = [
    {
      kind: "notes",
      notes: params.notes,
      ...(params.notesDelta !== undefined
        ? { notesDelta: params.notesDelta }
        : {}),
    },
  ];
  if (params.meetingName !== undefined)
    changes.push({ kind: "rename", meetingName: params.meetingName });
  if (params.summarySentence !== undefined)
    changes.push({ kind: "summarySentence", value: params.summarySentence });
  if (params.summaryLabel !== undefined)
    changes.push({ kind: "summaryLabel", value: params.summaryLabel });
  const result = await updateMeeting({
    key: {
      guildId: params.guildId,
      channelId_timestamp: params.channelId_timestamp,
    },
    mutation:
      changes.length === 1
        ? {
            kind: "notes",
            notes: params.notes,
            ...(params.notesDelta !== undefined
              ? { notesDelta: params.notesDelta }
              : {}),
          }
        : { kind: "correction", changes },
    actor: { editedBy: params.editedBy },
    notesEdit: {
      expectedNotesVersion:
        params.expectedPreviousVersion ?? params.notesVersion - 1,
      source: params.source,
      suggestion: params.suggestion,
    },
    signal,
    operation,
  });
  return result.kind === "saved";
}

export async function updateMeetingNameService(params: {
  guildId: string;
  channelId_timestamp: string;
  meetingName: string;
}) {
  const result = await updateMeeting({
    key: {
      guildId: params.guildId,
      channelId_timestamp: params.channelId_timestamp,
    },
    mutation: { kind: "rename", meetingName: params.meetingName },
    actor: { editedBy: "legacy-rename" },
  });
  return result.kind === "saved";
}

export async function updateMeetingTagsService(
  guildId: string,
  channelIdTimestamp: string,
  tags?: string[],
) {
  await getMeetingHistoryRepository().updateTags(
    guildId,
    channelIdTimestamp,
    tags,
  );
}

export async function updateMeetingStatusService(params: {
  guildId: string;
  channelId_timestamp: string;
  status: MeetingStatus;
}) {
  return getMeetingHistoryRepository().updateStatus(
    params.guildId,
    params.channelId_timestamp,
    params.status,
  );
}

export async function updateMeetingArchiveService(params: {
  guildId: string;
  channelId_timestamp: string;
  archived: boolean;
  archivedByUserId: string;
}) {
  return getMeetingHistoryRepository().updateArchive(params);
}

export async function updateMeetingAccessGrantsService(params: {
  guildId: string;
  channelId_timestamp: string;
  accessGrants: MeetingAccessGrant[];
}) {
  const repository = getMeetingHistoryRepository();
  const previous = await repository.get(
    params.guildId,
    params.channelId_timestamp,
  );
  if (!previous) return false;
  const ok = await repository.updateAccessGrants(params);
  if (!ok) return false;
  const updated = await repository.get(
    params.guildId,
    params.channelId_timestamp,
  );
  if (updated)
    await replaceMeetingUserIndexForMeetingService(previous, updated);
  return true;
}

import {
  canonicalFieldsSupersededAfter,
  originalCompletionExportView,
} from "../types/meetingCanonicalContent";

/** Canonical recording lifecycle writes never replace the owned history row. */
function preserveCanonicalHistory(input: {
  row: MeetingHistory;
  patch: HistoryTransition["patch"];
  canonicalBaseline: number | undefined;
}): HistoryTransition["patch"] {
  const { row, canonicalBaseline, patch } = input;
  if (canonicalBaseline === undefined) return patch;
  const superseded = canonicalFieldsSupersededAfter(row, canonicalBaseline);
  if (!superseded)
    throw new Error("Recording history canonical baseline is stale");
  return Object.fromEntries(
    Object.entries(patch).filter(([field]) => !superseded.has(field)),
  );
}
function hasRecordingHistoryOwnership(
  row: MeetingHistory | undefined,
  reservation: NonNullable<MeetingData["reservation"]>,
  allowedStatuses: readonly MeetingStatus[],
): row is MeetingHistory & { status: MeetingStatus } {
  return Boolean(
    row &&
    row.meetingId === reservation.meetingId &&
    row.ownerInstanceId === reservation.ownerInstanceId &&
    row.executionVersion === reservation.executionVersion &&
    row.status &&
    allowedStatuses.includes(row.status),
  );
}

const MAX_OWNED_HISTORY_TRANSITION_ATTEMPTS = 3;

function assertOwnedHistoryNotAborted(meeting: MeetingData): void {
  meeting.ownershipSignal?.throwIfAborted();
  meeting.finalization?.controller.signal.throwIfAborted();
}

function canonicalDeliveryAdvanced(
  previous: MeetingHistory,
  current: MeetingHistory,
): boolean {
  const before = previous.updateDelivery;
  const after = current.updateDelivery;
  if (!after) return !before;
  const expected =
    before ??
    meetingUpdateDeliverySchema.parse({
      revision: after.revision,
      policy: initialMeetingUpdatePolicy(previous),
      parts: after.parts,
      progress: {
        kind: "pending",
        nextCheckAt:
          "nextCheckAt" in after.progress ? after.progress.nextCheckAt : 0,
      },
    });
  // Content requests may advance desired parts, never publication authority or receipts.
  return (
    stableJson({
      ...expected,
      revision: after.revision,
      parts: after.parts,
    }) === stableJson(after) &&
    presentationPartSchema.options.every(
      (part) =>
        after.parts[part].acknowledged ===
          (before?.parts[part].acknowledged ?? 0) &&
        after.parts[part].desired >= (before?.parts[part].desired ?? 0) &&
        after.parts[part].desired <= (current.contentRevision ?? 0),
    )
  );
}

function canonicalContentAdvanced(
  previous: MeetingHistory,
  current: MeetingHistory,
): boolean {
  const baseline = previous.contentRevision ?? 0;
  if ((current.contentRevision ?? 0) <= baseline) return false;
  const changed = canonicalFieldsSupersededAfter(current, baseline);
  if (!changed || !canonicalDeliveryAdvanced(previous, current)) return false;
  const canonicalFields = new Set([
    ...changed,
    "contentRevision",
    "contentMutation",
    "updateDelivery",
  ]);
  return PUBLICATION_SNAPSHOT_FIELDS.every(
    (field) =>
      canonicalFields.has(field) ||
      isDeepStrictEqual(previous[field], current[field]),
  );
}

async function commitOwnedMeetingHistory(
  meeting: MeetingData,
  patch: HistoryTransition["patch"],
  allowedStatuses: readonly MeetingStatus[],
  canonicalBaseline?: number,
): Promise<MeetingHistory> {
  const reservation = meeting.reservation;
  if (!reservation || reservation.sessionMode !== "meeting")
    throw new Error("Recording history requires its owned reservation");
  const repository = getMeetingHistoryRepository();
  let previous: MeetingHistory | undefined;
  for (
    let attempt = 0;
    attempt < MAX_OWNED_HISTORY_TRANSITION_ATTEMPTS;
    attempt++
  ) {
    assertOwnedHistoryNotAborted(meeting);
    const row = await repository.getOwned(reservation.historyKey);
    assertOwnedHistoryNotAborted(meeting);
    if (!hasRecordingHistoryOwnership(row, reservation, allowedStatuses))
      throw new Error("Recording history ownership or status changed");
    if (previous && !canonicalContentAdvanced(previous, row))
      throw new Error("Recording history transition was fenced");
    const nextPatch = {
      ...preserveCanonicalHistory({ row, patch, canonicalBaseline }),
      updatedAt: new Date().toISOString(),
    };
    const result = await repository.transitionOwned({
      expectedPublication: publicationSnapshot(row),
      key: reservation.historyKey,
      expectedMeetingId: reservation.meetingId,
      expectedOwnerInstanceId: reservation.ownerInstanceId,
      expectedExecutionVersion: reservation.executionVersion,
      expectedStatus: row.status,
      patch: nextPatch,
    });
    assertOwnedHistoryNotAborted(meeting);
    if (result === "applied") return { ...row, ...nextPatch };
    previous = row;
  }
  throw new Error("Recording history transition was fenced");
}

export async function transitionOwnedMeetingHistoryService(
  meeting: MeetingData,
  patch: HistoryTransition["patch"],
  allowedStatuses: readonly MeetingStatus[],
  canonicalBaseline?: number,
): Promise<void> {
  await commitOwnedMeetingHistory(
    meeting,
    patch,
    allowedStatuses,
    canonicalBaseline,
  );
}

export async function saveOwnedMeetingHistoryService(
  meeting: MeetingData,
  history: MeetingHistory,
): Promise<MeetingHistory> {
  const patch = Object.fromEntries(
    HISTORY_TRANSITION_FIELDS.map((key) => [key, history[key]]),
  );
  const committed = await commitOwnedMeetingHistory(
    meeting,
    patch,
    history.status === "cancelled"
      ? ["processing", "cancelled"]
      : ["processing"],
    history.contentRevision ?? 0,
  );
  const canonical = originalCompletionExportView(history, committed);
  try {
    await writeMeetingUserIndexForMeetingService(canonical);
  } catch (error) {
    console.error("Failed to update meeting user index", {
      meetingId: history.meetingId,
      error,
    });
  }
  return canonical;
}
