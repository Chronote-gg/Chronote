import type { MeetingData } from "../types/meeting-data";
import { isFixture, fixtureLabels } from "./fixtureInputService";
import { resolveMeetingAttendees } from "../utils/meetingAttendees";
export function recordingPromptLabels(meeting: MeetingData) {
  if (isFixture(meeting))
    return {
      ...fixtureLabels,
      serverDescription: "",
      events: "",
      channelNames: "",
      cleanupRoleNames: "",
    };
  return {
    serverName: meeting.guild.name,
    serverDescription: meeting.guild.description ?? "",
    voiceChannelName: meeting.voiceChannel.name,
    attendees: resolveMeetingAttendees(meeting).join(", "),
    botDisplayName:
      meeting.guild.members.me?.displayName ||
      meeting.guild.members.me?.nickname ||
      meeting.guild.members.me?.user.username ||
      "Meeting Notes Bot",
    events: meeting.guild.scheduledEvents
      .valueOf()
      .map((event) => event.name)
      .join(", "),
    channelNames: meeting.guild.channels
      .valueOf()
      .map((channel) => channel.name)
      .join(", "),
    cleanupRoleNames: meeting.guild.roles
      .valueOf()
      .map((role) => role.name)
      .join(", "),
  };
}
