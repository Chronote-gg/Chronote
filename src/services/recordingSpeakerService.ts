import type { Client } from "discord.js";
import type { MeetingData } from "../types/meeting-data";
import { formatParticipantLabel } from "../utils/participants";
import { isFixture, fixtureParticipant } from "./fixtureInputService";
export function resolveSpeakerLabel(
  meeting: MeetingData,
  userId: string,
): string {
  const fixture = fixtureParticipant(meeting, userId);
  if (fixture) return fixture.displayName!;
  const participant = meeting.participants?.get(userId);
  if (!participant) return userId;
  return formatParticipantLabel(participant, {
    includeUsername: true,
    fallbackName: participant.username ?? userId,
  });
}

export function finalTranscriptSpeakerLabel(
  client: Client,
  meeting: MeetingData,
  userId: string,
): string {
  if (isFixture(meeting)) return "Fixture speaker";
  const participant = meeting.participants.get(userId);
  const member = meeting.guild.members.cache.get(userId);
  const user = client.users.cache.get(userId);
  const fallbackName =
    member?.nickname ||
    member?.user.globalName ||
    member?.user.username ||
    user?.globalName ||
    user?.username ||
    userId;
  const fallbackUsername = [member?.user.username, user?.username].find(
    Boolean,
  );
  return formatParticipantLabel(participant, {
    includeUsername: true,
    fallbackName,
    fallbackUsername,
  });
}

export function warnMissingSnippetStart(meeting: MeetingData, userId: string) {
  if (!meeting.audioData.missingStartWarnings) {
    meeting.audioData.missingStartWarnings = new Set();
  }
  if (meeting.audioData.missingStartWarnings.has(userId)) {
    return;
  }
  meeting.audioData.missingStartWarnings.add(userId);
  const speakerLabel = resolveSpeakerLabel(meeting, userId);
  console.warn(
    `Missing speaking start timestamp, using receipt time for snippet: guildId=${meeting.guildId} channelId=${meeting.channelId} meetingId=${meeting.meetingId} userId=${userId} speaker=${speakerLabel}`,
  );
}
