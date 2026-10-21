import type { VoiceState } from "discord.js";
import type { MeetingData } from "../types/meeting-data";
import { allowFixtureActor, fixtureParticipant } from "./fixtureInputService";
import {
  fromMember,
  formatParticipantLabel,
  formatUserMention,
} from "../utils/participants";
export function recordMeetingParticipantEvent(
  meeting: MeetingData,
  state: VoiceState,
  kind: "join" | "leave",
): boolean {
  if (!allowFixtureActor(meeting, state.id)) return false;
  const participant =
    fixtureParticipant(meeting, state.id) ?? fromMember(state.member!);
  const userLabel = formatParticipantLabel(participant, {
    includeUsername: false,
    fallbackName: participant.username,
  });
  console.log(
    `${userLabel} ${kind === "join" ? "joined" : "left"} the voice channel.`,
  );
  meeting.participants.set(participant.id, participant);
  if (meeting.storeChatLog !== false) {
    if (kind === "join")
      meeting.attendance.add(formatUserMention(participant.id));
    meeting.chatLog.push({
      type: kind,
      user: participant,
      channelId: state.channelId!,
      timestamp: new Date().toISOString(),
    });
  }
  return true;
}
