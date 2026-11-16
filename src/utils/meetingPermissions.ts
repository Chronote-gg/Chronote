import { GuildMember, PermissionFlagsBits } from "discord.js";
import type { MeetingData } from "../types/meeting-data";

export function canGuildMemberEndMeeting(
  member: GuildMember | null | undefined,
): boolean {
  if (!member) return false;
  return member.permissions.any([
    PermissionFlagsBits.ModerateMembers,
    PermissionFlagsBits.Administrator,
    PermissionFlagsBits.ManageChannels,
    PermissionFlagsBits.ManageGuild,
    PermissionFlagsBits.ManageMessages,
  ]);
}

export function canUserEndMeeting(
  meeting: MeetingData,
  userId: string,
): boolean {
  if (meeting.creator.id === userId) {
    return true;
  }

  return canGuildMemberEndMeeting(meeting.guild.members.cache.get(userId));
}

/** For a session known only by its lease: whoever started it, or a member who may end any meeting. */
export function canMemberEndLease(
  member: GuildMember | null | undefined,
  userId: string,
  startTriggeredByUserId?: string,
): boolean {
  return startTriggeredByUserId === userId || canGuildMemberEndMeeting(member);
}
