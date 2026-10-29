import { createHash } from "node:crypto";
import { getMeetingHistoryRepository } from "../repositories/meetingHistoryRepository";
import { getMeetingUserIndexRepository } from "../repositories/meetingUserIndexRepository";
import type { MeetingHistory } from "../types/db";
import type { McpTokenRestriction } from "../types/mcpOAuth";
import type { MeetingBrowseFilters } from "../types/meetingBrowse";
import { MEETING_STATUS } from "../types/meetingLifecycle";
import type { Participant } from "../types/participants";
import type { TranscriptPayload } from "../types/transcript";
import {
  projectMeetingCapture,
  resolveCaptureStatus,
} from "../utils/meetingCaptureNotice";
import {
  isPersonalMeeting,
  PERSONAL_MEETING_CHANNEL_NAME,
  PERSONAL_MEETING_SERVER_NAME,
} from "../utils/meetingOwnership";
import {
  buildGuildShareIndexPrincipal,
  isMeetingIndexedForUser,
  isRecordedMeetingAttendee,
} from "../utils/meetingUserIndex";
import { buildPortalMeetingUrl } from "../utils/portalLinks";
import { resolveAttendeeAccessEnabled } from "./attendeeAccessSetting";
import { config } from "./configService";
import { listGuildChannelsCached } from "./discordCacheService";
import { isDiscordApiError } from "./discordService";
import {
  assertMcpGuildMembership,
  ensureMcpMeetingAccess,
  resolveMcpMeetingAccessContext,
  type McpMeetingAccessContext,
} from "./mcpMeetingAccess";
import { McpMeetingAccessError } from "./mcpMeetingErrors";
import { listMcpServersForToken } from "./mcpMeetingServers";
import {
  resolveMeetingArtifactAccess,
  resolveServerMeetingArtifactAccess,
  type MeetingArtifactAccess,
} from "./meetingArtifactAccessService";
import { collectMeetingBrowsePage } from "./meetingBrowseCollector";
import type { MeetingBrowseLookup } from "./meetingBrowseCursor";
import {
  decodeMeetingBrowseCursor,
  encodeMeetingBrowseCursor,
  InvalidMeetingBrowseCursorError,
  meetingBrowseFingerprint,
  type MeetingBrowseCursorPayload,
  type MeetingBrowseSource,
} from "./meetingBrowseCursor";
import {
  getMeetingHistoryService,
  listMeetingsForGuildInRangeService,
  listRecentMeetingsForGuildService,
} from "./meetingHistoryService";
import {
  buildMeetingMentionReplacer,
  createMeetingMentionReplacer,
  resolveGuildRoleNames,
} from "./meetingMentionService";
import { fetchJsonFromS3 } from "./storageService";
export { McpMeetingAccessError } from "./mcpMeetingErrors";
export {
  listMcpServersForToken,
  listMcpServersForUser,
} from "./mcpMeetingServers";

const MIN_TIMESTAMP_ISO = "1970-01-01T00:00:00.000Z";
const MAX_TIMESTAMP_ISO = "9999-12-31T23:59:59.999Z";
const DEFAULT_MEETING_LIMIT = 25;
const MAX_MEETING_LIMIT = 100;
const MCP_MEETING_SCAN_LIMIT_MULTIPLIER = 5;
const MCP_CHANNEL_MAP_BATCH_SIZE = 5;
export const DEFAULT_MCP_TRANSCRIPT_MAX_CHARS = 20_000;
export const MAX_MCP_TRANSCRIPT_MAX_CHARS = 100_000;
const MS_PER_DAY = 1000 * 60 * 60 * 24;
const MCP_MEETING_ID_FORMAT_ERROR =
  "Use the meeting `id` returned by list tools in `channelId#ISO-timestamp` form.";

export type McpMyMeetingsMode = "attended" | "accessible";
export type McpMyMeetingsRange = "all" | "today" | "past_7_days" | "custom";

type ListMcpMeetingsInput = {
  userId: string;
  guildId: string;
  limit?: number;
  channelId?: string;
  startDate?: string;
  endDate?: string;
  tags?: string[];
  includeArchived?: boolean;
  restriction?: McpTokenRestriction;
};

type MeetingListFilters = {
  channelId?: string;
  tags?: string[];
  archivedOnly?: boolean;
  includeArchived?: boolean;
  /**
   * Bounds carried by a service account token. Unlike `channelId` these are
   * hard limits rather than caller-chosen filters, so they apply on every read
   * path a restricted token can reach.
   */
  restriction?: McpTokenRestriction;
};

export type ListMcpMyMeetingsInput = {
  browse?: MeetingBrowseFilters;
  userId: string;
  mode?: McpMyMeetingsMode;
  range?: McpMyMeetingsRange;
  limit?: number;
  cursor?: string;
  startDate?: string;
  endDate?: string;
  timeZoneOffsetMinutes?: number;
  serverIds?: string[];
  tags?: string[];
  archivedOnly?: boolean;
  includeArchived?: boolean;
  restriction?: McpTokenRestriction;
};

type MyMeetingsCursor = {
  timestamp: string;
  identity: string;
  startDate?: string;
  endDate?: string;
  mode?: McpMyMeetingsMode;
  serverIds?: string[];
  tags?: string[];
  archivedOnly?: boolean;
  includeArchived?: boolean;
};

type ResolvedMyMeetingsFilters = {
  mode: McpMyMeetingsMode;
  serverIds?: string[];
  tags?: string[];
  archivedOnly?: boolean;
  includeArchived?: boolean;
};

const parseChannelIdTimestamp = (channelIdTimestamp: string) => {
  const hashIndex = channelIdTimestamp.indexOf("#");
  if (hashIndex <= 0 || hashIndex >= channelIdTimestamp.length - 1) {
    throw new McpMeetingAccessError(MCP_MEETING_ID_FORMAT_ERROR, "bad_request");
  }
  return {
    channelId: channelIdTimestamp.slice(0, hashIndex),
    timestamp: channelIdTimestamp.slice(hashIndex + 1),
  };
};

const resolveMeetingLookupId = (id: string) => {
  const { timestamp } = parseChannelIdTimestamp(id);
  const parsedTimestamp = new Date(timestamp);
  if (
    Number.isNaN(parsedTimestamp.getTime()) ||
    parsedTimestamp.toISOString() !== timestamp
  ) {
    throw new McpMeetingAccessError(MCP_MEETING_ID_FORMAT_ERROR, "bad_request");
  }
  return id;
};

type TranscriptWindow = {
  offset: number;
  maxChars: number;
};

const normalizeTranscriptWindow = (input?: {
  offset?: number;
  maxChars?: number;
}): TranscriptWindow => ({
  offset: Math.max(0, Math.trunc(input?.offset ?? 0)),
  maxChars: Math.min(
    MAX_MCP_TRANSCRIPT_MAX_CHARS,
    Math.max(
      1,
      Math.trunc(input?.maxChars ?? DEFAULT_MCP_TRANSCRIPT_MAX_CHARS),
    ),
  ),
});

const resolveParticipantLabel = (participant: Participant) =>
  participant.serverNickname ||
  participant.displayName ||
  participant.username ||
  participant.tag ||
  "Unknown";

const resolveMeetingAttendees = (history: MeetingHistory) => {
  if (history.participants?.length) {
    return history.participants.map(resolveParticipantLabel);
  }
  return history.attendees ?? [];
};

const resolveMeetingChannelId = (meeting: MeetingHistory) =>
  meeting.channelId ??
  parseChannelIdTimestamp(meeting.channelId_timestamp).channelId;

const resolveMeetingDuration = (meeting: MeetingHistory) => {
  if (
    meeting.status === MEETING_STATUS.IN_PROGRESS ||
    meeting.status === MEETING_STATUS.PROCESSING ||
    (meeting.status == null && meeting.duration === 0)
  ) {
    return Math.max(
      0,
      Math.floor((Date.now() - Date.parse(meeting.timestamp)) / 1000),
    );
  }
  return meeting.duration;
};

const resolveChannelMap = async (guildId: string) => {
  try {
    const channels = await listGuildChannelsCached(guildId);
    return new Map(channels.map((channel) => [channel.id, channel.name]));
  } catch (error) {
    if (isDiscordApiError(error) && error.status === 429) {
      throw new McpMeetingAccessError(
        "Discord rate limited. Please retry.",
        "rate_limited",
      );
    }
    console.warn("Unable to resolve MCP meeting channels", { guildId, error });
    return new Map<string, string>();
  }
};

const summarizeMeeting = (
  meeting: MeetingHistory,
  channelMap: Map<string, string>,
  artifactAccess: MeetingArtifactAccess,
  resolveMentions: (text: string) => string = (text) => text,
) => {
  const channelId = resolveMeetingChannelId(meeting);
  const personalMeeting = isPersonalMeeting(meeting);
  return {
    id: meeting.channelId_timestamp,
    meetingId: meeting.meetingId,
    ownershipScope: personalMeeting ? "personal" : "guild",
    ownerUserId: meeting.ownerUserId,
    ...projectMeetingCapture(meeting),
    status: resolveCaptureStatus(meeting),
    ...(meeting.processing ? { processing: meeting.processing } : {}),
    channelId,
    channelName: personalMeeting
      ? PERSONAL_MEETING_CHANNEL_NAME
      : (channelMap.get(channelId) ?? channelId),
    timestamp: meeting.timestamp,
    duration: resolveMeetingDuration(meeting),
    tags: meeting.tags ?? [],
    meetingName: meeting.meetingName,
    summarySentence: meeting.summarySentence
      ? resolveMentions(meeting.summarySentence)
      : meeting.summarySentence,
    summaryLabel: meeting.summaryLabel,
    notesAvailable: Boolean(meeting.notes),
    transcriptAvailable:
      artifactAccess.transcriptAccessEnabled &&
      Boolean(meeting.transcriptS3Key),
    audioAvailable:
      artifactAccess.audioAccessEnabled && Boolean(meeting.audioS3Key),
    archivedAt: meeting.archivedAt,
    portalUrl: buildPortalMeetingUrl({
      baseUrl: config.frontend.siteUrl,
      guildId: meeting.guildId,
      meetingId: meeting.channelId_timestamp,
    }),
  };
};

const isMeetingChannelAllowed = (
  meeting: MeetingHistory,
  allowedChannelIds?: string[],
) =>
  !allowedChannelIds ||
  allowedChannelIds.includes(resolveMeetingChannelId(meeting));

const assertMeetingChannelAllowed = (
  meeting: MeetingHistory,
  allowedChannelIds?: string[],
) => {
  if (isMeetingChannelAllowed(meeting, allowedChannelIds)) return;
  // Same shape as a permission denial so a restricted token cannot use the
  // error to tell an out-of-scope meeting apart from one that does not exist.
  throw new McpMeetingAccessError("Meeting access required.", "forbidden");
};

const meetingMatchesListFilters = (
  meeting: MeetingHistory,
  input: MeetingListFilters,
  requestedTags: Set<string>,
) => {
  if (meeting.status === MEETING_STATUS.CANCELLED) return false;
  if (input.archivedOnly && !meeting.archivedAt) return false;
  if (!input.archivedOnly && !input.includeArchived && meeting.archivedAt) {
    return false;
  }
  if (!isMeetingChannelAllowed(meeting, input.restriction?.channelIds))
    return false;
  if (input.channelId && resolveMeetingChannelId(meeting) !== input.channelId) {
    return false;
  }
  if (requestedTags.size === 0) return true;
  const meetingTags = new Set(
    (meeting.tags ?? []).map((tag) => tag.toLowerCase()),
  );
  return Array.from(requestedTags).every((tag) => meetingTags.has(tag));
};

const normalizeMcpMeetingLimit = (limit?: number) =>
  Math.max(0, Math.min(limit ?? DEFAULT_MEETING_LIMIT, MAX_MEETING_LIMIT));

const normalizeInputDateIso = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new McpMeetingAccessError(
      "Invalid meeting date range.",
      "bad_request",
    );
  }
  return date.toISOString();
};

const resolveTodayStartIso = (nowMs: number, timeZoneOffsetMinutes = 0) => {
  const localMs = nowMs - timeZoneOffsetMinutes * 60 * 1000;
  const localDate = new Date(localMs);
  const localStartMs = Date.UTC(
    localDate.getUTCFullYear(),
    localDate.getUTCMonth(),
    localDate.getUTCDate(),
  );
  return new Date(
    localStartMs + timeZoneOffsetMinutes * 60 * 1000,
  ).toISOString();
};

const resolveMyMeetingsRange = (input: ListMcpMyMeetingsInput) =>
  input.range ?? (input.startDate ? "custom" : "past_7_days");

const assertMyMeetingsDateRangeInput = (
  input: ListMcpMyMeetingsInput,
  range: McpMyMeetingsRange,
) => {
  if (input.range && range !== "custom" && (input.startDate || input.endDate)) {
    throw new McpMeetingAccessError(
      "startDate and endDate are only allowed when range is custom.",
      "bad_request",
    );
  }
  if (range === "custom" && !input.startDate) {
    throw new McpMeetingAccessError(
      "startDate is required when range is custom.",
      "bad_request",
    );
  }
};

const MY_MEETINGS_CURSOR_ERROR = "Invalid My Meetings cursor.";

const assertIsoTimestamp = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== value) {
    throw new McpMeetingAccessError(MY_MEETINGS_CURSOR_ERROR, "bad_request");
  }
};

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const isMyMeetingsCursor = (value: unknown): value is MyMeetingsCursor =>
  typeof value === "object" &&
  value !== null &&
  "timestamp" in value &&
  "identity" in value &&
  typeof value.timestamp === "string" &&
  typeof value.identity === "string" &&
  value.identity.trim().length > 0 &&
  (!("startDate" in value) || typeof value.startDate === "string") &&
  (!("endDate" in value) || typeof value.endDate === "string") &&
  (!("mode" in value) ||
    value.mode === "attended" ||
    value.mode === "accessible") &&
  (!("serverIds" in value) || isStringArray(value.serverIds)) &&
  (!("tags" in value) || isStringArray(value.tags)) &&
  (!("archivedOnly" in value) || typeof value.archivedOnly === "boolean") &&
  (!("includeArchived" in value) || typeof value.includeArchived === "boolean");

const decodeMyMeetingsCursor = (cursor?: string) => {
  if (!cursor) return undefined;
  try {
    const decoded: unknown = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    );
    if (!isMyMeetingsCursor(decoded)) {
      throw new McpMeetingAccessError(MY_MEETINGS_CURSOR_ERROR, "bad_request");
    }
    assertIsoTimestamp(decoded.timestamp);
    if (decoded.startDate) assertIsoTimestamp(decoded.startDate);
    if (decoded.endDate) assertIsoTimestamp(decoded.endDate);
    return decoded;
  } catch (error) {
    if (error instanceof McpMeetingAccessError) throw error;
    throw new McpMeetingAccessError(MY_MEETINGS_CURSOR_ERROR, "bad_request");
  }
};

const resolveMyMeetingsStartDate = (
  input: ListMcpMyMeetingsInput,
  range: McpMyMeetingsRange,
  nowMs: number,
  cursor?: MyMeetingsCursor,
) => {
  if (input.startDate) return normalizeInputDateIso(input.startDate);
  if (cursor?.startDate) return cursor.startDate;
  if (range === "today") {
    return resolveTodayStartIso(nowMs, input.timeZoneOffsetMinutes);
  }
  if (range === "past_7_days") {
    return new Date(nowMs - 7 * MS_PER_DAY).toISOString();
  }
  return MIN_TIMESTAMP_ISO;
};

const assertMyMeetingsDateRangeOrder = (startDate: string, endDate: string) => {
  if (Date.parse(startDate) <= Date.parse(endDate)) return;
  throw new McpMeetingAccessError("Invalid meeting date range.", "bad_request");
};

const resolveMyMeetingsDateRange = (input: ListMcpMyMeetingsInput) => {
  const nowMs = Date.now();
  const decodedCursor = decodeMyMeetingsCursor(input.cursor);
  const requestedEndDate = input.endDate
    ? normalizeInputDateIso(input.endDate)
    : (decodedCursor?.endDate ?? new Date(nowMs).toISOString());
  const endDate =
    decodedCursor && decodedCursor.timestamp < requestedEndDate
      ? decodedCursor.timestamp
      : requestedEndDate;
  const range = resolveMyMeetingsRange(input);
  assertMyMeetingsDateRangeInput(input, range);
  const startDate = resolveMyMeetingsStartDate(
    input,
    range,
    nowMs,
    decodedCursor,
  );
  assertMyMeetingsDateRangeOrder(startDate, endDate);

  return { startDate, endDate, cursor: decodedCursor };
};

const resolveMyMeetingsFilters = (
  input: ListMcpMyMeetingsInput,
  cursor?: MyMeetingsCursor,
): ResolvedMyMeetingsFilters => ({
  mode: input.mode ?? cursor?.mode ?? "attended",
  serverIds: input.serverIds ?? cursor?.serverIds,
  tags: input.tags ?? cursor?.tags,
  archivedOnly: input.archivedOnly ?? cursor?.archivedOnly,
  includeArchived: input.includeArchived ?? cursor?.includeArchived,
});

const filterMcpServers = (
  servers: Array<{ id: string; name: string; icon?: string | null }>,
  serverIds?: string[],
) => {
  if (!serverIds?.length) return servers;
  const requested = new Set(serverIds);
  return servers.filter((server) => requested.has(server.id));
};

const runInBatches = async <Item, Result>(
  items: Item[],
  batchSize: number,
  task: (item: Item) => Promise<Result>,
) => {
  const results: Result[] = [];
  for (let index = 0; index < items.length; index += batchSize) {
    results.push(
      ...(await Promise.all(items.slice(index, index + batchSize).map(task))),
    );
  }
  return results;
};

const collectAccessibleMeetings = async (
  meetings: MeetingHistory[],
  input: ListMcpMeetingsInput,
  limit: number,
  accessContext: McpMeetingAccessContext,
) => {
  const allowedMeetings: MeetingHistory[] = [];
  for (const meeting of meetings) {
    try {
      await ensureMcpMeetingAccess({
        guildId: input.guildId,
        meeting,
        userId: input.userId,
        accessContext,
        restricted: Boolean(input.restriction),
      });
      allowedMeetings.push(meeting);
      if (allowedMeetings.length >= limit) break;
    } catch (error) {
      if (
        error instanceof McpMeetingAccessError &&
        error.code === "forbidden"
      ) {
        continue;
      }
      throw error;
    }
  }
  return allowedMeetings;
};

export async function listMcpMeetings(input: ListMcpMeetingsInput) {
  const limit = normalizeMcpMeetingLimit(input.limit);
  if (limit === 0) return { meetings: [] };

  let accessContext: McpMeetingAccessContext;
  try {
    accessContext = await resolveMcpMeetingAccessContext(
      input.guildId,
      input.userId,
      { restricted: Boolean(input.restriction) },
    );
  } catch (error) {
    if (error instanceof McpMeetingAccessError && error.code === "forbidden") {
      return { meetings: [] };
    }
    throw error;
  }
  const scanLimit = limit * MCP_MEETING_SCAN_LIMIT_MULTIPLIER;
  const hasRange = input.startDate || input.endDate;
  const meetings = hasRange
    ? await listMeetingsForGuildInRangeService(
        input.guildId,
        input.startDate ?? MIN_TIMESTAMP_ISO,
        input.endDate ?? MAX_TIMESTAMP_ISO,
        scanLimit,
      )
    : await listRecentMeetingsForGuildService(input.guildId, scanLimit, {
        includeArchived: input.includeArchived,
      });
  const requestedTags = new Set(
    (input.tags ?? []).map((tag) => tag.toLowerCase()),
  );
  const filtered = meetings.filter((meeting) =>
    meetingMatchesListFilters(meeting, input, requestedTags),
  );
  const allowedMeetings = await collectAccessibleMeetings(
    filtered,
    input,
    limit,
    accessContext,
  );
  const channelMap = await resolveChannelMap(input.guildId);
  const roleNamesByGuildId = new Map([
    [input.guildId, await resolveGuildRoleNames(input.guildId)],
  ]);
  const artifactAccess = await resolveServerMeetingArtifactAccess(
    input.guildId,
  );
  return {
    meetings: allowedMeetings.map((meeting) =>
      summarizeMeeting(
        meeting,
        channelMap,
        artifactAccess,
        buildMeetingMentionReplacer(meeting, roleNamesByGuildId).toText,
      ),
    ),
  };
}

const summarizeUserMeetings = async (
  meetings: MeetingHistory[],
  serverMap: Map<string, { id: string; name: string; icon?: string | null }>,
) => {
  const guildIds = Array.from(
    new Set(
      meetings
        .filter((meeting) => !isPersonalMeeting(meeting))
        .map((meeting) => meeting.guildId),
    ),
  );
  // Batched per guild, not per meeting, so a user with meetings across many
  // servers does not fan out one Discord request per row.
  const guildEntries = await runInBatches(
    guildIds,
    MCP_CHANNEL_MAP_BATCH_SIZE,
    async (guildId) => ({
      guildId,
      channelMap: await resolveChannelMap(guildId),
      roleNames: await resolveGuildRoleNames(guildId),
      artifactAccess: await resolveServerMeetingArtifactAccess(guildId),
    }),
  );
  const channelMaps = new Map<string, Map<string, string>>();
  const roleNamesByGuildId = new Map<string, Map<string, string>>();
  const artifactAccessByGuildId = new Map<string, MeetingArtifactAccess>();
  guildEntries.forEach((entry) => {
    channelMaps.set(entry.guildId, entry.channelMap);
    roleNamesByGuildId.set(entry.guildId, entry.roleNames);
    artifactAccessByGuildId.set(entry.guildId, entry.artifactAccess);
  });

  return meetings.map((meeting) => {
    const server = serverMap.get(meeting.guildId);
    return {
      ...summarizeMeeting(
        meeting,
        channelMaps.get(meeting.guildId) ?? new Map<string, string>(),
        isPersonalMeeting(meeting)
          ? { transcriptAccessEnabled: true, audioAccessEnabled: true }
          : (artifactAccessByGuildId.get(meeting.guildId) ?? {
              transcriptAccessEnabled: false,
              audioAccessEnabled: false,
            }),
        buildMeetingMentionReplacer(meeting, roleNamesByGuildId).toText,
      ),
      serverId: meeting.guildId,
      serverName: isPersonalMeeting(meeting)
        ? PERSONAL_MEETING_SERVER_NAME
        : (server?.name ?? "Previous server"),
      serverIcon: server?.icon ?? null,
    };
  });
};

type BrowseAuthorization = {
  input: ListMcpMyMeetingsInput;
  browse: MeetingBrowseFilters;
  filters: ResolvedMyMeetingsFilters;
  state: MeetingBrowseCursorPayload;
  sharedGuildIds: string[];
};
function matchesBrowseScope(
  meeting: MeetingHistory,
  input: ListMcpMyMeetingsInput,
  browse: MeetingBrowseFilters,
  filters: ResolvedMyMeetingsFilters,
) {
  const personal = isPersonalMeeting(meeting);
  if (
    input.restriction &&
    (meeting.guildId !== input.restriction.guildId || personal)
  )
    return false;
  if (filters.serverIds?.length && !filters.serverIds.includes(meeting.guildId))
    return false;
  if (browse.scope.kind === "personal" && !personal) return false;
  if (
    browse.scope.kind === "guild" &&
    (personal || meeting.guildId !== browse.scope.serverId)
  )
    return false;
  return true;
}
function matchesBrowseRequest(
  meeting: MeetingHistory,
  input: ListMcpMyMeetingsInput,
  browse: MeetingBrowseFilters,
  filters: ResolvedMyMeetingsFilters,
  requestedTags: Set<string>,
) {
  if (!matchesBrowseScope(meeting, input, browse, filters)) return false;
  if (browse.attendedOnly && !isRecordedMeetingAttendee(meeting, input.userId))
    return false;
  if (
    !input.browse &&
    filters.mode === "attended" &&
    !isMeetingIndexedForUser(meeting, input.userId)
  )
    return false;
  if (
    !meetingMatchesListFilters(
      meeting,
      {
        ...filters,
        restriction: input.restriction,
        channelId: browse.channelId,
      },
      requestedTags,
    )
  )
    return false;
  return true;
}
function createBrowseAuthorizer({
  input,
  browse,
  filters,
  state,
  sharedGuildIds,
}: BrowseAuthorization) {
  const requestedTags = new Set(
    (filters.tags ?? []).map((tag) => tag.toLowerCase()),
  );
  const accessContexts = new Map<string, McpMeetingAccessContext>();
  return async (key: MeetingBrowseLookup) => {
    const meeting = await getMeetingHistoryRepository().get(
      key.guildId,
      key.channelId_timestamp,
    );
    if (
      !meeting ||
      meeting.timestamp !== key.timestamp ||
      meeting.timestamp < state.startTimestamp ||
      meeting.timestamp > state.endTimestamp
    )
      return;
    if (!matchesBrowseRequest(meeting, input, browse, filters, requestedTags))
      return;
    const personal = isPersonalMeeting(meeting);
    try {
      let context = accessContexts.get(meeting.guildId);
      if (!context) {
        context = {
          attendeeOverrideEnabled: personal
            ? false
            : !input.restriction &&
              (await resolveAttendeeAccessEnabled(meeting.guildId)),
          sharedGuildIds,
        };
        accessContexts.set(meeting.guildId, context);
      }
      // Only actual recorded attendance permits a former member to retain a
      // real guild recording. Creator, trigger and share pointers are discovery,
      // never membership or authorization evidence.
      if (
        !personal &&
        !(
          context.attendeeOverrideEnabled &&
          isRecordedMeetingAttendee(meeting, input.userId)
        )
      )
        await assertMcpGuildMembership(meeting.guildId, input.userId);
      await ensureMcpMeetingAccess({
        guildId: meeting.guildId,
        meeting,
        userId: input.userId,
        accessContext: context,
        restricted: Boolean(input.restriction),
      });
      return meeting;
    } catch (error) {
      if (error instanceof McpMeetingAccessError && error.code === "forbidden")
        return;
      throw error;
    }
  };
}

function browseRequestFingerprint(
  input: ListMcpMyMeetingsInput,
  filters: ResolvedMyMeetingsFilters,
  limit: number,
) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        portal: Boolean(input.browse),
        mode: filters.mode,
        range: resolveMyMeetingsRange(input),
        startDate: input.startDate
          ? normalizeInputDateIso(input.startDate)
          : null,
        endDate: input.endDate ? normalizeInputDateIso(input.endDate) : null,
        timeZoneOffsetMinutes: input.timeZoneOffsetMinutes ?? 0,
        limit,
        serverIds: [...new Set(filters.serverIds ?? [])].sort(),
        tags: [
          ...new Set((filters.tags ?? []).map((tag) => tag.toLowerCase())),
        ].sort(),
        archivedOnly: filters.archivedOnly ?? false,
        includeArchived: filters.includeArchived ?? false,
        restriction: input.restriction ?? null,
      }),
    )
    .digest("hex");
}
function restoreLegacyBrowseInput(
  input: ListMcpMyMeetingsInput,
  state: MeetingBrowseCursorPayload,
) {
  if (!input.browse && state.legacy) {
    const previous = state.legacy;
    return {
      ...input,
      mode: input.mode ?? previous.mode,
      range: input.range ?? previous.range,
      startDate: input.startDate ?? previous.startDate,
      endDate: input.endDate ?? previous.endDate,
      timeZoneOffsetMinutes:
        input.timeZoneOffsetMinutes ?? previous.timeZoneOffsetMinutes,
      serverIds: input.serverIds ?? previous.serverIds,
      tags: input.tags ?? previous.tags,
      archivedOnly: input.archivedOnly ?? previous.archivedOnly,
      includeArchived: input.includeArchived ?? previous.includeArchived,
    };
  }
  return input;
}
async function prepareMeetingBrowseRequest(
  input: ListMcpMyMeetingsInput,
  limit: number,
) {
  const v2 = input.cursor?.includes(".") === true;
  if (input.browse && input.cursor && !v2)
    throw new McpMeetingAccessError("Invalid Meetings cursor.", "bad_request");
  const browse: MeetingBrowseFilters = input.browse ?? {
    scope: { kind: "all" },
    attendedOnly: false,
  };
  let state: MeetingBrowseCursorPayload | undefined;
  if (v2 && input.cursor) {
    try {
      state = await decodeMeetingBrowseCursor(
        input.cursor,
        input.userId,
        browse,
      );
    } catch (error) {
      if (error instanceof InvalidMeetingBrowseCursorError)
        throw new McpMeetingAccessError(error.message, "bad_request");
      throw error;
    }
    input = restoreLegacyBrowseInput(input, state);
  }
  const legacyRange = resolveMyMeetingsDateRange({
    ...input,
    cursor: v2 ? undefined : input.cursor,
  });
  const filters = resolveMyMeetingsFilters(input, legacyRange.cursor);
  // Bind all server-side choices, including legacy restrictions and the range preset.
  // Fixed computed date bounds live in the snapshot rather than changing with the clock.
  const requestFingerprint = browseRequestFingerprint(input, filters, limit);
  if (state) {
    if (state.requestFingerprint !== requestFingerprint)
      throw new McpMeetingAccessError(
        "Invalid Meetings cursor filters.",
        "bad_request",
      );
  }
  return { input, browse, state, legacyRange, filters, requestFingerprint };
}

function meetingBrowseSources(
  input: ListMcpMyMeetingsInput,
  browse: MeetingBrowseFilters,
  servers: ReturnType<typeof filterMcpServers>,
) {
  const sources: MeetingBrowseSource[] = [];
  if (!input.restriction)
    sources.push({ kind: "user", id: input.userId, exhausted: false });
  for (const server of servers) {
    if (
      browse.scope.kind !== "personal" &&
      (browse.scope.kind !== "guild" || browse.scope.serverId === server.id)
    )
      sources.push({ kind: "guild", id: server.id, exhausted: false });
    if (!input.restriction && browse.scope.kind !== "guild")
      sources.push({ kind: "guild_share", id: server.id, exhausted: false });
  }
  return sources;
}

export async function listMcpMyMeetings(input: ListMcpMyMeetingsInput) {
  if (
    input.browse &&
    (input.mode !== "accessible" || input.serverIds?.length)
  ) {
    throw new McpMeetingAccessError(
      "Browse requires accessible mode and uses scope instead of serverIds.",
      "bad_request",
    );
  }
  const limit = normalizeMcpMeetingLimit(input.limit);
  if (limit === 0)
    return {
      meetings: [],
      hasMore: false,
      nextCursor: null,
      discoveryComplete: true,
    };
  const prepared = await prepareMeetingBrowseRequest(input, limit);
  input = prepared.input;
  const { browse, legacyRange, filters, requestFingerprint } = prepared;
  let state = prepared.state;
  const allServers = await listMcpServersForToken({
    userId: input.userId,
    restriction: input.restriction,
  });
  const servers = filterMcpServers(allServers, filters.serverIds);
  const sharedGuildIds = allServers.map((server) => server.id);
  if (!state) {
    state = {
      version: 2,
      actorId: input.userId,
      filterFingerprint: meetingBrowseFingerprint(browse),
      requestFingerprint,
      startTimestamp: legacyRange.startDate,
      endTimestamp: legacyRange.endDate,
      expiresAt: Date.now() + 3600000,
      sources: meetingBrowseSources(input, browse, servers),
      pending: [],
      watermark: legacyRange.cursor
        ? {
            timestamp: legacyRange.cursor.timestamp,
            identity: legacyRange.cursor.identity,
          }
        : undefined,
    };
    if (!input.browse)
      state.legacy = {
        ...filters,
        range: resolveMyMeetingsRange(input),
        startDate: input.startDate,
        endDate: input.endDate,
        timeZoneOffsetMinutes: input.timeZoneOffsetMinutes,
      };
  }
  const result = await collectMeetingBrowsePage({
    state,
    limit,
    read: async (source, options) => {
      if (source.kind === "guild")
        return getMeetingHistoryRepository().listByGuildTimestampPage(
          source.id,
          options,
        );
      return getMeetingUserIndexRepository().listByPrincipalTimestampPage(
        source.kind === "user"
          ? source.id
          : buildGuildShareIndexPrincipal(source.id),
        options,
      );
    },
    authorize: createBrowseAuthorizer({
      input,
      browse,
      filters,
      state,
      sharedGuildIds,
    }),
  });
  return {
    range: { startDate: state.startTimestamp, endDate: state.endTimestamp },
    mode: filters.mode,
    meetings: await summarizeUserMeetings(
      result.meetings,
      new Map(allServers.map((server) => [server.id, server])),
    ),
    hasMore: !result.discoveryComplete,
    discoveryComplete: result.discoveryComplete,
    nextCursor: result.discoveryComplete
      ? null
      : await encodeMeetingBrowseCursor(state),
  };
}
export type MeetingBrowsePage = Awaited<ReturnType<typeof listMcpMyMeetings>>;

export async function getMcpMeetingSummary(input: {
  userId: string;
  guildId: string;
  id: string;
  restriction?: McpTokenRestriction;
}) {
  const meeting = await getMeetingHistoryService(
    input.guildId,
    resolveMeetingLookupId(input.id),
  );
  if (!meeting) {
    throw new McpMeetingAccessError("Meeting not found.", "not_found");
  }
  assertMeetingChannelAllowed(meeting, input.restriction?.channelIds);
  await ensureMcpMeetingAccess({
    guildId: input.guildId,
    meeting,
    userId: input.userId,
    restricted: Boolean(input.restriction),
  });
  const channelMap = isPersonalMeeting(meeting)
    ? new Map<string, string>()
    : await resolveChannelMap(input.guildId);
  const resolveMentions = await createMeetingMentionReplacer(meeting);
  const artifactAccess = await resolveMeetingArtifactAccess(meeting);
  return {
    meeting: {
      ...summarizeMeeting(
        meeting,
        channelMap,
        artifactAccess,
        resolveMentions.toText,
      ),
      notes: resolveMentions.toText(meeting.notes ?? ""),
      notesVersion: meeting.notesVersion ?? 1,
      attendees: resolveMeetingAttendees(meeting),
      notesChannelId: meeting.notesChannelId,
      notesMessageId: meeting.notesMessageIds?.[0],
    },
  };
}

// `<@&` plus a 20 digit snowflake plus `>` is 24 characters; round up.
const MAX_MENTION_TOKEN_LENGTH = 32;
const MENTION_TOKEN_PATTERN = /<@[!&]?\d+>/g;

/**
 * Moves a page boundary back to just before a mention it would otherwise cut
 * in half, so a client following `nextOffset` never receives raw id fragments
 * like `<@&1` and `23>` on adjacent pages. Offsets stay in stored transcript
 * coordinates, and the page only ever gets shorter, never past `maxChars`.
 * A mention longer than the whole page is left split, since shrinking to
 * nothing would stall paging.
 */
const clampEndToWholeMention = (
  transcript: string,
  offset: number,
  end: number,
): number => {
  const searchStart = Math.max(offset, end - MAX_MENTION_TOKEN_LENGTH);
  const region = transcript.slice(searchStart, end + MAX_MENTION_TOKEN_LENGTH);
  for (const match of region.matchAll(MENTION_TOKEN_PATTERN)) {
    const tokenStart = searchStart + match.index;
    const tokenEnd = tokenStart + match[0].length;
    if (tokenStart >= end || tokenEnd <= end) continue;
    // Ending before the token would leave an empty page and stall paging when
    // the page begins inside or exactly at a mention, so the page is extended
    // to the end of that token instead. This is the only case where a page
    // exceeds maxChars, and it is bounded by one mention.
    return tokenStart > offset ? tokenStart : tokenEnd;
  }
  return end;
};

function sliceTranscript(
  transcript: string,
  transcriptWindow: TranscriptWindow,
) {
  const totalChars = transcript.length;
  const offset = Math.min(transcriptWindow.offset, totalChars);
  const requestedEnd = Math.min(offset + transcriptWindow.maxChars, totalChars);
  const end =
    requestedEnd < totalChars
      ? clampEndToWholeMention(transcript, offset, requestedEnd)
      : requestedEnd;
  const transcriptSlice = transcript.slice(offset, end);
  const nextOffset = offset + transcriptSlice.length;
  return {
    transcript: transcriptSlice,
    offset,
    totalChars,
    truncated: nextOffset < totalChars,
    nextOffset: nextOffset < totalChars ? nextOffset : undefined,
  };
}

export async function getMcpMeetingTranscript(input: {
  userId: string;
  guildId: string;
  id: string;
  offset?: number;
  maxChars?: number;
  restriction?: McpTokenRestriction;
}) {
  const meeting = await getMeetingHistoryService(
    input.guildId,
    resolveMeetingLookupId(input.id),
  );
  if (!meeting) {
    throw new McpMeetingAccessError("Meeting not found.", "not_found");
  }
  assertMeetingChannelAllowed(meeting, input.restriction?.channelIds);
  await ensureMcpMeetingAccess({
    guildId: input.guildId,
    meeting,
    userId: input.userId,
    restricted: Boolean(input.restriction),
  });
  const artifactAccess = await resolveMeetingArtifactAccess(meeting);
  if (!artifactAccess.transcriptAccessEnabled) {
    throw new McpMeetingAccessError(
      "Transcript access is disabled for this server.",
      "artifact_unavailable",
    );
  }
  const transcriptPayload = meeting.transcriptS3Key
    ? await fetchJsonFromS3<TranscriptPayload>(meeting.transcriptS3Key)
    : undefined;
  const resolveMentions = await createMeetingMentionReplacer(meeting);
  // Page the stored transcript, then resolve only the page. Resolution changes
  // text length and depends on a Discord lookup that can fail, so offsets
  // taken over resolved text would shift between requests and a client
  // following nextOffset would skip or repeat characters.
  //
  // offset, nextOffset, totalChars, and maxChars are therefore all in stored
  // transcript coordinates. Resolution is a display transform applied after
  // paging, so a page whose mentions resolve to longer names can exceed
  // maxChars slightly. Sizing the window to the resolved length instead would
  // put the bound and the offsets in different coordinate systems and make the
  // response shape depend on whether a Discord lookup succeeded, which is the
  // instability this ordering exists to avoid.
  const transcript = transcriptPayload?.text ?? meeting.transcript ?? "";
  const transcriptWindow = sliceTranscript(
    transcript,
    normalizeTranscriptWindow(input),
  );
  return {
    meetingId: meeting.meetingId,
    id: meeting.channelId_timestamp,
    transcript: resolveMentions.toText(transcriptWindow.transcript),
    ...projectMeetingCapture(meeting),
    transcriptAvailable: Boolean(transcript),
    offset: transcriptWindow.offset,
    totalChars: transcriptWindow.totalChars,
    truncated: transcriptWindow.truncated,
    nextOffset: transcriptWindow.nextOffset,
  };
}
