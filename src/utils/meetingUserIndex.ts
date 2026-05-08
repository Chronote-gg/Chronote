import type { MeetingHistory, MeetingUserIndexRecord } from "../types/db";

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
  return Array.from(userIds);
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
  }));

export const isMeetingIndexedForUser = (
  meeting: MeetingHistory,
  userId: string,
) => resolveMeetingIndexUserIds(meeting).includes(userId);
