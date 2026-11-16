import type { MeetingData } from "../types/meeting-data";
import type { TranscriptionContentInput } from "./transcriptionService";
import {
  getMeetingProcessingSignal,
  runMeetingProcessingEffect,
} from "./meetingProcessingLifetime";

export function liveTranscriptionInput(
  meeting: MeetingData,
): TranscriptionContentInput {
  return {
    meetingId: meeting.meetingId,
    creator: { id: meeting.creator.id },
    guild: { id: meeting.guild.id },
    voiceChannel: { id: meeting.voiceChannel.id },
    signal: getMeetingProcessingSignal(meeting),
    runtimeConfig: meeting.runtimeConfig,
    effect: (run) => runMeetingProcessingEffect(meeting, run),
  };
}
