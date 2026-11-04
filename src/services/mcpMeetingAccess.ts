import type { MeetingHistory } from "../types/db";
import { isPersonalMeeting } from "../utils/meetingOwnership";
import { isRecordedMeetingAttendee } from "../utils/meetingUserIndex";
import { resolveAttendeeAccessEnabled } from "./attendeeAccessSetting";
import { getGuildMemberCached } from "./discordCacheService";
import { isDiscordApiError } from "./discordService";
import { McpMeetingAccessError } from "./mcpMeetingErrors";
import { listMcpServersForUser } from "./mcpMeetingServers";
import { checkUserMeetingAccess } from "./meetingAccessService";

export type McpMeetingAccessContext = {
  attendeeOverrideEnabled: boolean;
  sharedGuildIds?: string[];
};

export const assertMcpGuildMembership = async (
  guildId: string,
  userId: string,
) => {
  try {
    await getGuildMemberCached(guildId, userId);
  } catch (error) {
    if (isDiscordApiError(error) && error.status === 429) {
      throw new McpMeetingAccessError(
        "Discord rate limited. Please retry.",
        "rate_limited",
      );
    }
    if (
      isDiscordApiError(error) &&
      (error.status === 403 || error.status === 404)
    ) {
      throw new McpMeetingAccessError("Meeting access required.", "forbidden");
    }
    throw error;
  }
};

export const resolveMcpMeetingAccessContext = async (
  guildId: string,
  userId: string,
  options: { requireGuildMembership?: boolean; restricted?: boolean } = {},
): Promise<McpMeetingAccessContext> => {
  if (options.requireGuildMembership !== false) {
    await assertMcpGuildMembership(guildId, userId);
  }
  return {
    // Attendee access is a permanent grant recorded at meeting time, and the
    // participant snapshot in `meetings.ts` does not filter bots out of a voice
    // channel. A bot that once sat in a private channel would therefore keep
    // reading that meeting after its roles were removed, which is exactly the
    // revocation a service account is supposed to honour. Restricted tokens are
    // always evaluated against current channel permissions instead.
    attendeeOverrideEnabled: options.restricted
      ? false
      : await resolveAttendeeAccessEnabled(guildId),
  };
};

const hasPersonalGuildGrants = (meeting: MeetingHistory) =>
  isPersonalMeeting(meeting) &&
  meeting.accessGrants?.some((grant) => grant.targetType === "guild") === true;

const resolveMcpSharedGuildIds = async (userId: string) =>
  (await listMcpServersForUser(userId)).map((server) => server.id);

export const ensureMcpMeetingAccess = async (options: {
  guildId: string;
  meeting: MeetingHistory;
  userId: string;
  accessContext?: McpMeetingAccessContext;
  restricted?: boolean;
}) => {
  const personal = isPersonalMeeting(options.meeting);
  const accessContext =
    options.accessContext ??
    (personal
      ? { attendeeOverrideEnabled: false }
      : await resolveMcpMeetingAccessContext(options.guildId, options.userId, {
          requireGuildMembership: false,
          restricted: options.restricted,
        }));
  if (
    !options.accessContext &&
    !personal &&
    !(
      accessContext.attendeeOverrideEnabled &&
      isRecordedMeetingAttendee(options.meeting, options.userId)
    )
  ) {
    await assertMcpGuildMembership(options.guildId, options.userId);
  }
  let decision = await checkUserMeetingAccess({
    guildId: options.guildId,
    meeting: options.meeting,
    userId: options.userId,
    attendeeOverrideEnabled: accessContext.attendeeOverrideEnabled,
    sharedGuildIds: accessContext.sharedGuildIds,
  });
  if (decision.allowed === false && hasPersonalGuildGrants(options.meeting)) {
    decision = await checkUserMeetingAccess({
      guildId: options.guildId,
      meeting: options.meeting,
      userId: options.userId,
      attendeeOverrideEnabled: accessContext.attendeeOverrideEnabled,
      sharedGuildIds: await resolveMcpSharedGuildIds(options.userId),
    });
  }
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
