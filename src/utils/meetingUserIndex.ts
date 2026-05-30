import type { MeetingHistory, MeetingUserIndexRecord } from "../types/db";
import {
  isPersonalMeeting,
  resolveMeetingOwnerUserId,
} from "./meetingOwnership";

const USER_TIMESTAMP_SEPARATOR = "#";
const DISCORD_USER_MENTION_PATTERN = /^<@!?(\d+)>$/;

export const buildMeetingUserTimestamp = (meeting: {
  timestamp: string;
  guildId: string;
  channelId_timestamp: string;
}) =>
  [meeting.timestamp, meeting.guildId, meeting.channelId_timestamp].join(
    USER_TIMESTAMP_SEPARATOR,
  );

export const resolveMeetingIndexUserIds = (meeting: {
  accessGrants?: MeetingHistory["accessGrants"];
  guildId?: string;
  ownershipScope?: MeetingHistory["ownershipScope"];
  ownerUserId?: string | null;
  participants?: Array<{ id?: string | null }> | null;
  attendees?: string[] | null;
  meetingCreatorId?: string | null;
  startTriggeredByUserId?: string | null;
}) => {
  const userIds = new Set<string>();
  meeting.participants?.forEach((participant) => {
    const id = participant.id?.trim();
    if (id) userIds.add(id);
  });
  meeting.attendees?.forEach((attendee) => {
    const match = attendee.trim().match(DISCORD_USER_MENTION_PATTERN);
    if (match) userIds.add(match[1]);
  });
  const creatorId = meeting.meetingCreatorId?.trim();
  if (creatorId) userIds.add(creatorId);
  const startUserId = meeting.startTriggeredByUserId?.trim();
  if (startUserId) userIds.add(startUserId);
  if (meeting.guildId && isPersonalMeeting(meeting)) {
    const ownerId = resolveMeetingOwnerUserId(meeting)?.trim();
    if (ownerId) userIds.add(ownerId);
    meeting.accessGrants?.forEach((grant) => {
      if (grant.targetType === "user") {
        const userId = grant.userId.trim();
        if (userId) userIds.add(userId);
      }
    });
  }
  return Array.from(userIds);
};

const resolveMeetingIndexAccessReason = (
  meeting: MeetingHistory,
  userId: string,
): MeetingUserIndexRecord["accessReason"] => {
  if (isPersonalMeeting(meeting)) {
    if (resolveMeetingOwnerUserId(meeting) === userId) return "owner";
    if (
      meeting.accessGrants?.some(
        (grant) =>
          grant.targetType === "user" && grant.userId.trim() === userId,
      )
    ) {
      return "user_share";
    }
  }
  return "attendee";
};

export const buildMeetingUserIndexRecords = (
  meeting: MeetingHistory,
): MeetingUserIndexRecord[] =>
  resolveMeetingIndexUserIds(meeting).map((userId) => ({
    userId,
    userTimestamp: buildMeetingUserTimestamp(meeting),
    guildId: meeting.guildId,
    channelId_timestamp: meeting.channelId_timestamp,
    meetingId: meeting.meetingId,
    timestamp: meeting.timestamp,
    accessReason: resolveMeetingIndexAccessReason(meeting, userId),
  }));

export const isMeetingIndexedForUser = (
  meeting: MeetingHistory,
  userId: string,
) => resolveMeetingIndexUserIds(meeting).includes(userId);
