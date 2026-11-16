import type { MeetingData } from "../types/meeting-data";
import type { TranscriptionContentInput } from "./transcriptionService";
import {
  getMeetingProcessingSignal,
  runMeetingProcessingEffect,
} from "./meetingProcessingLifetime";
import {
  buildDictionaryPromptLines,
  DEFAULT_DICTIONARY_BUDGETS,
} from "../utils/dictionary";

export function liveTranscriptionInput(
  meeting: MeetingData,
): TranscriptionContentInput {
  return {
    meetingId: meeting.meetingId,
    creator: { id: meeting.creator.id },
    guild: { id: meeting.guild.id },
    voiceChannel: { id: meeting.voiceChannel.id },
    signal: getMeetingProcessingSignal(meeting),
    keywords: buildDictionaryPromptLines(
      meeting.dictionaryEntries ?? [],
      meeting.runtimeConfig?.dictionary ?? DEFAULT_DICTIONARY_BUDGETS,
    ).transcriptionKeywords,
    runtimeConfig: meeting.runtimeConfig,
    effect: (run) => runMeetingProcessingEffect(meeting, run),
  };
}
