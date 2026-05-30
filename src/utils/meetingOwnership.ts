import type { MeetingAccessGrant, MeetingHistory } from "../types/db";

export const PERSONAL_MEETING_GUILD_ID_PREFIX = "personal:";
export const PERSONAL_MEETING_CHANNEL_NAME = "Personal meeting";
export const PERSONAL_MEETING_SERVER_NAME = "Personal";

export const buildPersonalMeetingGuildId = (ownerUserId: string) =>
  `${PERSONAL_MEETING_GUILD_ID_PREFIX}${ownerUserId}`;

export const isPersonalMeeting = (
  meeting: Pick<MeetingHistory, "ownershipScope"> & {
    guildId?: string | null;
  },
) =>
  meeting.ownershipScope === "personal" ||
  meeting.guildId?.startsWith(PERSONAL_MEETING_GUILD_ID_PREFIX) === true;

export const resolveMeetingOwnerUserId = (meeting: {
  ownerUserId?: string | null;
  meetingCreatorId?: string | null;
}) => meeting.ownerUserId?.trim() || meeting.meetingCreatorId?.trim() || null;

const hasUserGrant = (grant: MeetingAccessGrant, userId: string) =>
  grant.targetType === "user" && grant.userId.trim() === userId.trim();

const hasGuildGrant = (grant: MeetingAccessGrant, guildIds: Set<string>) =>
  grant.targetType === "guild" && guildIds.has(grant.guildId.trim());

export const hasPersonalMeetingUserGrant = (
  meeting: Pick<MeetingHistory, "accessGrants">,
  userId: string,
) => (meeting.accessGrants ?? []).some((grant) => hasUserGrant(grant, userId));

export const hasPersonalMeetingGuildGrant = (
  meeting: Pick<MeetingHistory, "accessGrants">,
  guildIds: string[] = [],
) => {
  if (guildIds.length === 0) return false;
  const guildIdSet = new Set(guildIds.map((guildId) => guildId.trim()));
  return (meeting.accessGrants ?? []).some((grant) =>
    hasGuildGrant(grant, guildIdSet),
  );
};

export const resolvePersonalMeetingAccess = (
  meeting: Pick<
    MeetingHistory,
    | "accessGrants"
    | "guildId"
    | "meetingCreatorId"
    | "ownerUserId"
    | "ownershipScope"
  >,
  userId: string,
  guildIds: string[] = [],
): "owner" | "user_share" | "guild_share" | null => {
  if (!isPersonalMeeting(meeting)) return null;
  if (resolveMeetingOwnerUserId(meeting) === userId) return "owner";
  if (hasPersonalMeetingUserGrant(meeting, userId)) return "user_share";
  if (hasPersonalMeetingGuildGrant(meeting, guildIds)) return "guild_share";
  return null;
};
