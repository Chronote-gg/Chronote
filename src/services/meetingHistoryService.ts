import type { RuntimeApiOperation } from "./runtimeApiOperationService";
import type {
  MeetingAccessGrant,
  MeetingHistory,
  NotesEditSource,
  SuggestionHistoryEntry,
} from "../types/db";
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
