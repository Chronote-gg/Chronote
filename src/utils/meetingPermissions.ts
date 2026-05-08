import { PermissionFlagsBits } from "discord.js";
import type { MeetingData } from "../types/meeting-data";

export function canUserEndMeeting(
  meeting: MeetingData,
  userId: string,
): boolean {
  if (meeting.creator.id === userId) {
    return true;
  }

  const member = meeting.guild.members.cache.get(userId);
  if (!member) {
    return false;
  }

  return member.permissions.any([
    PermissionFlagsBits.ModerateMembers,
    PermissionFlagsBits.Administrator,
    PermissionFlagsBits.ManageChannels,
    PermissionFlagsBits.ManageGuild,
    PermissionFlagsBits.ManageMessages,
  ]);
}
