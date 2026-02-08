import type { MeetingHistory, SuggestionHistoryEntry } from "../types/db";
import type { MeetingStatus } from "../types/meetingLifecycle";
import { getMeetingHistoryRepository } from "../repositories/meetingHistoryRepository";

export async function writeMeetingHistoryService(history: MeetingHistory) {
  await getMeetingHistoryRepository().write(history);
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
  options?: { archivedOnly?: boolean; includeArchived?: boolean },
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
) {
  return getMeetingHistoryRepository().listByGuildTimestampRange(
    guildId,
    startTimestamp,
    endTimestamp,
  );
}

const MIN_TIMESTAMP_ISO = "1970-01-01T00:00:00.000Z";
const MAX_TIMESTAMP_ISO = "9999-12-31T23:59:59.999Z";

export async function listAllMeetingsForGuildService(guildId: string) {
  return listMeetingsForGuildInRangeService(
    guildId,
    MIN_TIMESTAMP_ISO,
    MAX_TIMESTAMP_ISO,
  );
}

export async function listRecentMeetingsForChannelService(
  guildId: string,
  channelId: string,
  limit?: number,
) {
  return getMeetingHistoryRepository().listRecentByChannel(
    guildId,
    channelId,
    limit,
  );
}

export async function updateMeetingNotesService(params: {
  guildId: string;
  channelId_timestamp: string;
  notes: string;
  notesDelta?: unknown;
  notesVersion: number;
  editedBy: string;
  summarySentence?: string;
  summaryLabel?: string;
  meetingName?: string;
  suggestion?: SuggestionHistoryEntry;
  expectedPreviousVersion?: number;
  metadata?: { notesMessageIds?: string[]; notesChannelId?: string };
}) {
  return getMeetingHistoryRepository().updateNotes(params);
}

export async function updateMeetingNameService(params: {
  guildId: string;
  channelId_timestamp: string;
  meetingName: string;
}) {
  return getMeetingHistoryRepository().updateMeetingName(
    params.guildId,
    params.channelId_timestamp,
    params.meetingName,
  );
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
