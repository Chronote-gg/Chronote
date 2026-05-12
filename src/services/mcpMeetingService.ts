import { config } from "./configService";
import { buildCacheKey, cache, withCache } from "./cacheService";
import { isDiscordApiError } from "./discordService";
import {
  getGuildMemberCached,
  listBotGuildsCached,
  listGuildChannelsCached,
} from "./discordCacheService";
import {
  getMeetingHistoryService,
  listMeetingsForGuildInRangeService,
  listRecentMeetingsForGuildService,
} from "./meetingHistoryService";
import { listMeetingUserIndexForUserInRangeService } from "./meetingUserIndexService";
import { fetchJsonFromS3 } from "./storageService";
import { checkUserMeetingAccess } from "./meetingAccessService";
import {
  getSnapshotBoolean,
  resolveConfigSnapshot,
} from "./unifiedConfigService";
import { CONFIG_KEYS } from "../config/keys";
import type { MeetingHistory } from "../types/db";
import { MEETING_STATUS } from "../types/meetingLifecycle";
import type { Participant } from "../types/participants";
import type { TranscriptPayload } from "../types/transcript";
import { replaceDiscordMentionsWithDisplayNames } from "../utils/participants";
import { isMeetingIndexedForUser } from "../utils/meetingUserIndex";

const MIN_TIMESTAMP_ISO = "1970-01-01T00:00:00.000Z";
const MAX_TIMESTAMP_ISO = "9999-12-31T23:59:59.999Z";
const DEFAULT_MEETING_LIMIT = 25;
const MAX_MEETING_LIMIT = 100;
const MCP_MEETING_SCAN_LIMIT_MULTIPLIER = 5;
const MCP_INDEX_HISTORY_BATCH_SIZE = 10;
const MCP_SERVER_MEETING_BATCH_SIZE = 5;
const MCP_CHANNEL_MAP_BATCH_SIZE = 5;
const MCP_SERVER_MEMBERSHIP_BATCH_SIZE = 5;
const DEFAULT_MCP_TRANSCRIPT_MAX_CHARS = 20_000;
const MAX_MCP_TRANSCRIPT_MAX_CHARS = 100_000;
const MS_PER_DAY = 1000 * 60 * 60 * 24;
const MCP_MEETING_ID_FORMAT_ERROR =
  "Use the meeting `id` returned by list tools in `channelId#ISO-timestamp` form.";

export type McpMyMeetingsMode = "attended" | "accessible";
export type McpMyMeetingsRange = "today" | "past_7_days" | "custom";

type ListMcpMeetingsInput = {
  userId: string;
  guildId: string;
  limit?: number;
  channelId?: string;
  startDate?: string;
  endDate?: string;
  tags?: string[];
  includeArchived?: boolean;
};

type MeetingListFilters = {
  channelId?: string;
  tags?: string[];
  archivedOnly?: boolean;
  includeArchived?: boolean;
};

type ListMcpMyMeetingsInput = {
  userId: string;
  mode?: McpMyMeetingsMode;
  range?: McpMyMeetingsRange;
  limit?: number;
  startDate?: string;
  endDate?: string;
  timeZoneOffsetMinutes?: number;
  serverIds?: string[];
  tags?: string[];
  archivedOnly?: boolean;
  includeArchived?: boolean;
};

type McpMeetingAccessContext = {
  attendeeOverrideEnabled: boolean;
};

export class McpMeetingAccessError extends Error {
  constructor(
    message: string,
    readonly code: "forbidden" | "not_found" | "rate_limited" | "bad_request",
  ) {
    super(message);
  }
}

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

const buildParticipantMap = (participants?: Participant[]) =>
  new Map(
    (participants ?? []).map((participant) => [participant.id, participant]),
  );

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

const resolveAttendeeAccessEnabled = async (guildId: string) => {
  try {
    const snapshot = await resolveConfigSnapshot({ guildId });
    return getSnapshotBoolean(
      snapshot,
      CONFIG_KEYS.meetings.attendeeAccessEnabled,
    );
  } catch (error) {
    console.warn("Failed to resolve MCP meeting access setting", {
      guildId,
      error,
    });
    return true;
  }
};

const assertMcpGuildMembership = async (guildId: string, userId: string) => {
  try {
    await getGuildMemberCached(guildId, userId);
  } catch (error) {
    if (isDiscordApiError(error) && error.status === 429) {
      throw new McpMeetingAccessError(
        "Discord rate limited. Please retry.",
        "rate_limited",
      );
    }
    throw new McpMeetingAccessError("Meeting access required.", "forbidden");
  }
};

const resolveMcpMeetingAccessContext = async (
  guildId: string,
  userId: string,
): Promise<McpMeetingAccessContext> => {
  await assertMcpGuildMembership(guildId, userId);
  return {
    attendeeOverrideEnabled: await resolveAttendeeAccessEnabled(guildId),
  };
};

const ensureMcpMeetingAccess = async (options: {
  guildId: string;
  meeting: MeetingHistory;
  userId: string;
  accessContext?: McpMeetingAccessContext;
}) => {
  const accessContext =
    options.accessContext ??
    (await resolveMcpMeetingAccessContext(options.guildId, options.userId));
  const decision = await checkUserMeetingAccess({
    guildId: options.guildId,
    meeting: options.meeting,
    userId: options.userId,
    attendeeOverrideEnabled: accessContext.attendeeOverrideEnabled,
  });
  if (decision.allowed === null) {
    throw new McpMeetingAccessError(
      "Discord rate limited. Please retry.",
      "rate_limited",
    );
  }
  if (!decision.allowed) {
    throw new McpMeetingAccessError("Meeting access required.", "forbidden");
  }
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

const buildPortalMeetingUrl = (guildId: string, meetingId: string) => {
  const url = new URL(
    `/portal/server/${guildId}/library`,
    config.frontend.siteUrl,
  );
  url.searchParams.set("meetingId", meetingId);
  return url.toString();
};

const summarizeMeeting = (
  meeting: MeetingHistory,
  channelMap: Map<string, string>,
) => {
  const channelId = resolveMeetingChannelId(meeting);
  return {
    id: meeting.channelId_timestamp,
    meetingId: meeting.meetingId,
    status: meeting.status ?? MEETING_STATUS.COMPLETE,
    channelId,
    channelName: channelMap.get(channelId) ?? channelId,
    timestamp: meeting.timestamp,
    duration: resolveMeetingDuration(meeting),
    tags: meeting.tags ?? [],
    meetingName: meeting.meetingName,
    summarySentence: meeting.summarySentence,
    summaryLabel: meeting.summaryLabel,
    notesAvailable: Boolean(meeting.notes),
    transcriptAvailable: Boolean(meeting.transcriptS3Key),
    audioAvailable: Boolean(meeting.audioS3Key),
    archivedAt: meeting.archivedAt,
    portalUrl: buildPortalMeetingUrl(
      meeting.guildId,
      meeting.channelId_timestamp,
    ),
  };
};

const resolveMcpServerMembership = async (
  guild: { id: string; name: string; icon?: string | null },
  userId: string,
) => {
  try {
    await getGuildMemberCached(guild.id, userId);
    return { guild, allowed: true };
  } catch (error) {
    if (isDiscordApiError(error) && error.status === 429) {
      throw new McpMeetingAccessError(
        "Discord rate limited. Please retry.",
        "rate_limited",
      );
    }
    return { guild, allowed: false };
  }
};

async function listMcpServersForUserUncached(userId: string) {
  const guilds = await listBotGuildsCached();
  const memberships: Array<
    Awaited<ReturnType<typeof resolveMcpServerMembership>>
  > = [];
  for (
    let index = 0;
    index < guilds.length;
    index += MCP_SERVER_MEMBERSHIP_BATCH_SIZE
  ) {
    memberships.push(
      ...(await Promise.all(
        guilds
          .slice(index, index + MCP_SERVER_MEMBERSHIP_BATCH_SIZE)
          .map((guild) => resolveMcpServerMembership(guild, userId)),
      )),
    );
  }
  return memberships
    .filter((entry) => entry.allowed)
    .map(({ guild }) => ({ id: guild.id, name: guild.name, icon: guild.icon }));
}

const cachedMcpServersForUser = cache.define(
  "mcpServersForUser",
  {
    ttl: config.cache.discord.membersTtlSeconds,
    serialize: ({ userId }: { userId: string }) =>
      buildCacheKey(`mcp:serversForUser:${userId}`),
  },
  async ({ userId }: { userId: string }) =>
    listMcpServersForUserUncached(userId),
).mcpServersForUser;

const shouldFallbackMcpServerCache = (error: unknown) =>
  !(error instanceof McpMeetingAccessError);

export async function listMcpServersForUser(userId: string) {
  return withCache(
    "listMcpServersForUser",
    () => cachedMcpServersForUser({ userId }),
    () => listMcpServersForUserUncached(userId),
    shouldFallbackMcpServerCache,
  );
}

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

const resolveMyMeetingsDateRange = (input: ListMcpMyMeetingsInput) => {
  const nowMs = Date.now();
  const endDate = input.endDate
    ? normalizeInputDateIso(input.endDate)
    : new Date(nowMs).toISOString();
  const range = input.range ?? (input.startDate ? "custom" : "past_7_days");
  if (range === "custom" && !input.startDate) {
    throw new McpMeetingAccessError(
      "startDate is required when range is custom.",
      "bad_request",
    );
  }
  const startDate =
    (input.startDate && normalizeInputDateIso(input.startDate)) ||
    (range === "today"
      ? resolveTodayStartIso(nowMs, input.timeZoneOffsetMinutes)
      : range === "past_7_days"
        ? new Date(nowMs - 7 * MS_PER_DAY).toISOString()
        : MIN_TIMESTAMP_ISO);

  if (Date.parse(startDate) > Date.parse(endDate)) {
    throw new McpMeetingAccessError(
      "Invalid meeting date range.",
      "bad_request",
    );
  }

  return { startDate, endDate };
};

const meetingIdentity = (meeting: MeetingHistory) =>
  `${meeting.guildId}#${meeting.channelId_timestamp}`;

const compactUniqueMeetings = (meetings: MeetingHistory[]) => {
  const byId = new Map<string, MeetingHistory>();
  meetings.forEach((meeting) => {
    byId.set(meetingIdentity(meeting), meeting);
  });
  return Array.from(byId.values()).sort((a, b) =>
    b.timestamp.localeCompare(a.timestamp),
  );
};

const filterMcpServers = (
  servers: Array<{ id: string; name: string; icon?: string | null }>,
  serverIds?: string[],
) => {
  if (!serverIds?.length) return servers;
  const requested = new Set(serverIds);
  return servers.filter((server) => requested.has(server.id));
};

const isMeetingHistory = (
  meeting: MeetingHistory | undefined,
): meeting is MeetingHistory => Boolean(meeting);

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

const countMeetingsMatchingListFilters = (
  meetings: MeetingHistory[],
  input: MeetingListFilters,
) => {
  const requestedTags = new Set(
    (input.tags ?? []).map((tag) => tag.toLowerCase()),
  );
  return meetings.filter((meeting) =>
    meetingMatchesListFilters(meeting, input, requestedTags),
  ).length;
};

const listIndexedMeetingsForUser = async (input: {
  userId: string;
  startDate: string;
  endDate: string;
  limit: number;
}) => {
  const records = await listMeetingUserIndexForUserInRangeService(
    input.userId,
    input.startDate,
    input.endDate,
    input.limit,
  );
  const meetings = await runInBatches(
    records,
    MCP_INDEX_HISTORY_BATCH_SIZE,
    async (record) => {
      try {
        return await getMeetingHistoryService(
          record.guildId,
          record.channelId_timestamp,
        );
      } catch (error) {
        console.warn("Failed to resolve MCP indexed meeting", {
          userId: input.userId,
          guildId: record.guildId,
          channelIdTimestamp: record.channelId_timestamp,
          error,
        });
        return undefined;
      }
    },
  );
  return meetings.filter(isMeetingHistory);
};

const listRangeMeetingsForServers = async (input: {
  servers: Array<{ id: string }>;
  startDate: string;
  endDate: string;
  limit: number;
  userId?: string;
}) => {
  const meetingGroups = await runInBatches(
    input.servers,
    MCP_SERVER_MEETING_BATCH_SIZE,
    async (server) => {
      try {
        return await listMeetingsForGuildInRangeService(
          server.id,
          input.startDate,
          input.endDate,
          input.limit,
        );
      } catch (error) {
        console.warn("Failed to list MCP server meetings", {
          userId: input.userId,
          guildId: server.id,
          error,
        });
        return [];
      }
    },
  );
  return meetingGroups.flat();
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
  return {
    meetings: allowedMeetings.map((meeting) =>
      summarizeMeeting(meeting, channelMap),
    ),
  };
}

const collectAccessibleUserMeetings = async (input: {
  meetings: MeetingHistory[];
  userId: string;
  mode: McpMyMeetingsMode;
  limit: number;
  tags?: string[];
  includeArchived?: boolean;
  archivedOnly?: boolean;
}) => {
  const requestedTags = new Set(
    (input.tags ?? []).map((tag) => tag.toLowerCase()),
  );
  const accessContexts = new Map<string, McpMeetingAccessContext>();
  const allowedMeetings: MeetingHistory[] = [];

  for (const meeting of input.meetings) {
    if (
      input.mode === "attended" &&
      !isMeetingIndexedForUser(meeting, input.userId)
    ) {
      continue;
    }
    if (!meetingMatchesListFilters(meeting, input, requestedTags)) {
      continue;
    }
    try {
      let accessContext = accessContexts.get(meeting.guildId);
      if (!accessContext) {
        accessContext = await resolveMcpMeetingAccessContext(
          meeting.guildId,
          input.userId,
        );
        accessContexts.set(meeting.guildId, accessContext);
      }
      await ensureMcpMeetingAccess({
        guildId: meeting.guildId,
        meeting,
        userId: input.userId,
        accessContext,
      });
      allowedMeetings.push(meeting);
      if (allowedMeetings.length >= input.limit) break;
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

const summarizeUserMeetings = async (
  meetings: MeetingHistory[],
  serverMap: Map<string, { id: string; name: string; icon?: string | null }>,
) => {
  const guildIds = Array.from(
    new Set(meetings.map((meeting) => meeting.guildId)),
  );
  const channelEntries = await runInBatches(
    guildIds,
    MCP_CHANNEL_MAP_BATCH_SIZE,
    async (guildId) => ({
      guildId,
      channelMap: await resolveChannelMap(guildId),
    }),
  );
  const channelMaps = new Map<string, Map<string, string>>();
  channelEntries.forEach((entry) => {
    channelMaps.set(entry.guildId, entry.channelMap);
  });

  return meetings.map((meeting) => {
    const server = serverMap.get(meeting.guildId);
    return {
      ...summarizeMeeting(
        meeting,
        channelMaps.get(meeting.guildId) ?? new Map<string, string>(),
      ),
      serverId: meeting.guildId,
      serverName: server?.name ?? meeting.guildId,
      serverIcon: server?.icon ?? null,
    };
  });
};

export async function listMcpMyMeetings(input: ListMcpMyMeetingsInput) {
  const limit = normalizeMcpMeetingLimit(input.limit);
  if (limit === 0) return { meetings: [] };

  const mode = input.mode ?? "attended";
  const range = resolveMyMeetingsDateRange(input);
  const servers = filterMcpServers(
    await listMcpServersForUser(input.userId),
    input.serverIds,
  );
  if (servers.length === 0) return { meetings: [] };

  const serverMap = new Map(servers.map((server) => [server.id, server]));
  const scanLimit = limit * MCP_MEETING_SCAN_LIMIT_MULTIPLIER;
  const indexedMeetings =
    mode === "attended"
      ? await listIndexedMeetingsForUser({
          userId: input.userId,
          startDate: range.startDate,
          endDate: range.endDate,
          limit: scanLimit,
        })
      : [];
  const indexedCandidates = compactUniqueMeetings(
    indexedMeetings.filter((meeting) => serverMap.has(meeting.guildId)),
  );
  const needsRangeFallback =
    mode === "accessible" ||
    countMeetingsMatchingListFilters(indexedCandidates, input) < limit;
  const rangeMeetings = needsRangeFallback
    ? await listRangeMeetingsForServers({
        servers,
        startDate: range.startDate,
        endDate: range.endDate,
        limit: scanLimit,
        userId: input.userId,
      })
    : [];
  const candidateMeetings = compactUniqueMeetings(
    [...indexedCandidates, ...rangeMeetings].filter((meeting) =>
      serverMap.has(meeting.guildId),
    ),
  );
  const allowedMeetings = await collectAccessibleUserMeetings({
    meetings: candidateMeetings,
    userId: input.userId,
    mode,
    limit,
    tags: input.tags,
    includeArchived: input.includeArchived,
    archivedOnly: input.archivedOnly,
  });

  return {
    range,
    mode,
    meetings: await summarizeUserMeetings(allowedMeetings, serverMap),
  };
}

export async function getMcpMeetingSummary(input: {
  userId: string;
  guildId: string;
  id: string;
}) {
  const meeting = await getMeetingHistoryService(
    input.guildId,
    resolveMeetingLookupId(input.id),
  );
  if (!meeting) {
    throw new McpMeetingAccessError("Meeting not found.", "not_found");
  }
  await ensureMcpMeetingAccess({
    guildId: input.guildId,
    meeting,
    userId: input.userId,
  });
  const channelMap = await resolveChannelMap(input.guildId);
  const participants = buildParticipantMap(meeting.participants);
  const notes = replaceDiscordMentionsWithDisplayNames(
    meeting.notes ?? "",
    participants,
  );
  const summarySentence = meeting.summarySentence
    ? replaceDiscordMentionsWithDisplayNames(
        meeting.summarySentence,
        participants,
      )
    : meeting.summarySentence;
  return {
    meeting: {
      ...summarizeMeeting(meeting, channelMap),
      notes,
      notesVersion: meeting.notesVersion ?? 1,
      attendees: resolveMeetingAttendees(meeting),
      summarySentence,
      notesChannelId: meeting.notesChannelId,
      notesMessageId: meeting.notesMessageIds?.[0],
    },
  };
}

function sliceTranscript(
  transcript: string,
  transcriptWindow: TranscriptWindow,
) {
  const totalChars = transcript.length;
  const offset = Math.min(transcriptWindow.offset, totalChars);
  const transcriptSlice = transcript.slice(
    offset,
    offset + transcriptWindow.maxChars,
  );
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
}) {
  const meeting = await getMeetingHistoryService(
    input.guildId,
    resolveMeetingLookupId(input.id),
  );
  if (!meeting) {
    throw new McpMeetingAccessError("Meeting not found.", "not_found");
  }
  await ensureMcpMeetingAccess({
    guildId: input.guildId,
    meeting,
    userId: input.userId,
  });
  const transcriptPayload = meeting.transcriptS3Key
    ? await fetchJsonFromS3<TranscriptPayload>(meeting.transcriptS3Key)
    : undefined;
  const participants = buildParticipantMap(meeting.participants);
  const transcript = replaceDiscordMentionsWithDisplayNames(
    transcriptPayload?.text ?? meeting.transcript ?? "",
    participants,
  );
  const transcriptWindow = sliceTranscript(
    transcript,
    normalizeTranscriptWindow(input),
  );
  return {
    meetingId: meeting.meetingId,
    id: meeting.channelId_timestamp,
    transcript: transcriptWindow.transcript,
    transcriptAvailable: Boolean(transcript),
    offset: transcriptWindow.offset,
    totalChars: transcriptWindow.totalChars,
    truncated: transcriptWindow.truncated,
    nextOffset: transcriptWindow.nextOffset,
  };
}
