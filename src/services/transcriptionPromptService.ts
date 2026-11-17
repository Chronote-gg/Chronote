import type { MeetingData } from "../types/meeting-data";
import { buildMeetingContext, formatContextForPrompt } from "./contextService";
import { config } from "./configService";
import { getLangfuseChatPrompt } from "./langfusePromptService";
import { resolveMeetingAttendees } from "../utils/meetingAttendees";

export async function getTranscriptionCleanupPrompt(
  meeting: MeetingData,
  transcription: string,
) {
  const contextData = await buildMeetingContext(meeting, false);
  const formattedContext = formatContextForPrompt(contextData, "transcription");

  const serverName = meeting.guild.name;
  const serverDescription = meeting.guild.description ?? "";
  const roles = meeting.guild.roles
    .valueOf()
    .map((role) => role.name)
    .join(", ");
  const events = meeting.guild.scheduledEvents
    .valueOf()
    .map((event) => event.name)
    .join(", ");
  const channelNames = meeting.guild.channels
    .valueOf()
    .map((channel) => channel.name)
    .join(", ");

  return await getLangfuseChatPrompt({
    name: config.langfuse.transcriptionCleanupPromptName,
    variables: {
      formattedContext,
      attendees: resolveMeetingAttendees(meeting).join(", "),
      serverName,
      serverDescription,
      voiceChannelName: meeting.voiceChannel.name,
      roles,
      events,
      channelNames,
      transcription,
    },
  });
}
