import { validateFixtureCapture } from "./fixtureEvidenceValidation";
import { fixtureOutputSnapshot } from "./fixtureInputService";
import { isDeepStrictEqual } from "node:util";
import type { RuntimeApiOperation } from "./runtimeApiOperationService";
import { assertNotionOutcomeKnown } from "./notionOperationLifetime";
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
import { maybeAutoSyncMeetingNotes } from "./notionAutomationService";

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
  signal?.throwIfAborted();
  const repository = getMeetingHistoryRepository();
  const ok = await (operation
    ? operation.mutate(() => repository.updateNotes(params))
    : repository.updateNotes(params));
  signal?.throwIfAborted();
  if (!ok) return false;
  try {
    const updated = await repository.get(
      params.guildId,
      params.channelId_timestamp,
    );
    if (updated) {
      signal?.throwIfAborted();
      await maybeAutoSyncMeetingNotes(updated, signal);
    }
  } catch (error) {
    assertNotionOutcomeKnown(error, signal);
    console.warn("Failed to sync Notion after notes update", {
      guildId: params.guildId,
      meetingId: params.channelId_timestamp,
      error,
    });
  }
  return true;
}

export async function updateMeetingNotesMessageMetadataService(
  params: {
    guildId: string;
    channelId_timestamp: string;
    notesMessageIds: string[];
    notesChannelId: string;
    expectedNotesVersion: number;
  },
  signal?: AbortSignal,
  operation?: RuntimeApiOperation,
) {
  signal?.throwIfAborted();
  return operation
    ? operation.mutate(() =>
        getMeetingHistoryRepository().updateNotesMessageMetadata(params),
      )
    : getMeetingHistoryRepository().updateNotesMessageMetadata(params);
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

function validateLiveFixtureHistory(
  meeting: MeetingData,
  patch: HistoryTransition["patch"],
  row: MeetingHistory,
) {
  if (patch.fixtureInput) {
    const actual = fixtureOutputSnapshot(meeting);
    if (
      !row.checkpoint ||
      !isDeepStrictEqual(actual, {
        fixtureInput: patch.fixtureInput,
        fixtureGeneration: patch.fixtureGeneration,
        ...(patch.fixtureTranscript
          ? { fixtureTranscript: patch.fixtureTranscript }
          : {}),
      })
    )
      throw new Error("Fixture completion requires live original evidence");
    validateFixtureCapture(
      row.checkpoint.capture,
      patch.fixtureInput,
      row.fixtureInput,
    );
  }
}

/** Canonical recording lifecycle writes never replace the owned history row. */
export async function transitionOwnedMeetingHistoryService(
  meeting: MeetingData,
  patch: HistoryTransition["patch"],
  allowedStatuses: readonly MeetingStatus[],
): Promise<void> {
  const reservation = meeting.reservation;
  if (!reservation || reservation.sessionMode !== "meeting")
    throw new Error("Recording history requires its owned reservation");
  const repository = getMeetingHistoryRepository();
  meeting.ownershipSignal?.throwIfAborted();
  meeting.finalization?.controller.signal.throwIfAborted();
  const row = await repository.getOwned(reservation.historyKey);
  meeting.ownershipSignal?.throwIfAborted();
  meeting.finalization?.controller.signal.throwIfAborted();
  if (
    !row ||
    row.meetingId !== reservation.meetingId ||
    row.ownerInstanceId !== reservation.ownerInstanceId ||
    row.executionVersion !== reservation.executionVersion ||
    !row.status ||
    !allowedStatuses.includes(row.status)
  )
    throw new Error("Recording history ownership or status changed");
  validateLiveFixtureHistory(meeting, patch, row);
  const result = await repository.transitionOwned({
    key: reservation.historyKey,
    expectedMeetingId: reservation.meetingId,
    expectedOwnerInstanceId: reservation.ownerInstanceId,
    expectedExecutionVersion: reservation.executionVersion,
    expectedStatus: row.status,
    patch: { ...patch, updatedAt: new Date().toISOString() },
  });
  meeting.ownershipSignal?.throwIfAborted();
  meeting.finalization?.controller.signal.throwIfAborted();
  if (result !== "applied")
    throw new Error("Recording history transition was fenced");
}

export async function saveOwnedMeetingHistoryService(
  meeting: MeetingData,
  history: MeetingHistory,
): Promise<void> {
  const patch = Object.fromEntries(
    HISTORY_TRANSITION_FIELDS.map((key) => [key, history[key]]),
  );
  await transitionOwnedMeetingHistoryService(
    meeting,
    patch,
    history.status === "cancelled"
      ? ["processing", "cancelled"]
      : ["processing"],
  );
  try {
    await writeMeetingUserIndexForMeetingService(history);
  } catch (error) {
    console.error("Failed to update meeting user index", {
      meetingId: history.meetingId,
      error,
    });
  }
}
