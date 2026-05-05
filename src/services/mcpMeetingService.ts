import { config } from "./configService";
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

const MIN_TIMESTAMP_ISO = "1970-01-01T00:00:00.000Z";
const MAX_TIMESTAMP_ISO = "9999-12-31T23:59:59.999Z";
const DEFAULT_MEETING_LIMIT = 25;
const MAX_MEETING_LIMIT = 100;

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
    throw new McpMeetingAccessError("Invalid meeting id.", "bad_request");
  }
  return {
    channelId: channelIdTimestamp.slice(0, hashIndex),
    timestamp: channelIdTimestamp.slice(hashIndex + 1),
  };
};

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

const ensureMcpMeetingAccess = async (options: {
  guildId: string;
  meeting: MeetingHistory;
  userId: string;
}) => {
  try {
    await getGuildMemberCached(options.guildId, options.userId);
  } catch (error) {
    if (isDiscordApiError(error) && error.status === 429) {
      throw new McpMeetingAccessError(
        "Discord rate limited. Please retry.",
        "rate_limited",
      );
    }
    throw new McpMeetingAccessError("Meeting access required.", "forbidden");
  }

  const attendeeOverrideEnabled = await resolveAttendeeAccessEnabled(
    options.guildId,
  );
  const decision = await checkUserMeetingAccess({
    guildId: options.guildId,
    meeting: options.meeting,
    userId: options.userId,
    attendeeOverrideEnabled,
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
    archivedAt: meeting.archivedAt,
    portalUrl: buildPortalMeetingUrl(
      meeting.guildId,
      meeting.channelId_timestamp,
    ),
  };
};

export async function listMcpServersForUser(userId: string) {
  const guilds = await listBotGuildsCached();
  const memberships = await Promise.all(
    guilds.map(async (guild) => {
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
    }),
  );
  return memberships
    .filter((entry) => entry.allowed)
    .map(({ guild }) => ({ id: guild.id, name: guild.name, icon: guild.icon }));
}

export async function listMcpMeetings(input: {
  userId: string;
  guildId: string;
  limit?: number;
  channelId?: string;
  startDate?: string;
  endDate?: string;
  tags?: string[];
  includeArchived?: boolean;
}) {
  const limit = Math.min(
    input.limit ?? DEFAULT_MEETING_LIMIT,
    MAX_MEETING_LIMIT,
  );
  const hasRange = input.startDate || input.endDate;
  const meetings = hasRange
    ? await listMeetingsForGuildInRangeService(
        input.guildId,
        input.startDate ?? MIN_TIMESTAMP_ISO,
        input.endDate ?? MAX_TIMESTAMP_ISO,
      )
    : await listRecentMeetingsForGuildService(input.guildId, limit, {
        includeArchived: input.includeArchived,
      });
  const requestedTags = new Set(
    (input.tags ?? []).map((tag) => tag.toLowerCase()),
  );
  const filtered = meetings
    .filter((meeting) => input.includeArchived || !meeting.archivedAt)
    .filter(
      (meeting) =>
        !input.channelId ||
        resolveMeetingChannelId(meeting) === input.channelId,
    )
    .filter((meeting) => {
      if (requestedTags.size === 0) return true;
      const meetingTags = new Set(
        (meeting.tags ?? []).map((tag) => tag.toLowerCase()),
      );
      return Array.from(requestedTags).every((tag) => meetingTags.has(tag));
    })
    .slice(0, limit);

  const allowedMeetings = [] as MeetingHistory[];
  for (const meeting of filtered) {
    try {
      await ensureMcpMeetingAccess({
        guildId: input.guildId,
        meeting,
        userId: input.userId,
      });
      allowedMeetings.push(meeting);
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
  const channelMap = await resolveChannelMap(input.guildId);
  return {
    meetings: allowedMeetings.map((meeting) =>
      summarizeMeeting(meeting, channelMap),
    ),
  };
}

export async function getMcpMeetingSummary(input: {
  userId: string;
  guildId: string;
  meetingId: string;
}) {
  const meeting = await getMeetingHistoryService(
    input.guildId,
    input.meetingId,
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

export async function getMcpMeetingTranscript(input: {
  userId: string;
  guildId: string;
  meetingId: string;
}) {
  const meeting = await getMeetingHistoryService(
    input.guildId,
    input.meetingId,
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
  return {
    meetingId: meeting.meetingId,
    id: meeting.channelId_timestamp,
    transcript,
    transcriptAvailable: Boolean(transcript),
  };
}
