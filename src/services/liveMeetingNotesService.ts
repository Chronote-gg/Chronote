import type { MeetingData, MeetingNotesInput } from "../types/meeting-data";
import {
  ensureMeetingNotes,
  ensureMeetingSummaries,
} from "./meetingNotesService";
import { prepareLiveNotesPrompt } from "./notesPromptService";
import { getMeetingProcessingSignal } from "./meetingProcessingLifetime";

export function liveMeetingNotesInput(meeting: MeetingData): MeetingNotesInput {
  return {
    meetingId: meeting.meetingId,
    guildId: meeting.guildId,
    channelId: meeting.channelId,
    transcribeMeeting: meeting.transcribeMeeting,
    generateNotes: meeting.generateNotes,
    startTime: meeting.startTime,
    finalTranscript: meeting.finalTranscript,
    notesText: meeting.notesText,
    processing: meeting.processing,
    summarySentence: meeting.summarySentence,
    summaryLabel: meeting.summaryLabel,
    meetingName: meeting.meetingName,
    tags: meeting.tags,
    participants: meeting.participants,
    attendance: meeting.attendance,
    langfuseParentSpanContext: meeting.langfuseParentSpanContext,
    creator: { id: meeting.creator.id },
    guild: {
      id: meeting.guild.id,
      name: meeting.guild.name,
      description: meeting.guild.description,
    },
    voiceChannel: {
      id: meeting.voiceChannel.id,
      name: meeting.voiceChannel.name,
    },
    runtimeConfig: meeting.runtimeConfig
      ? {
          modelChoices: meeting.runtimeConfig.modelChoices,
          modelParams: meeting.runtimeConfig.modelParams,
          dictionary: meeting.runtimeConfig.dictionary,
          visionCaptions: meeting.runtimeConfig.visionCaptions,
        }
      : undefined,
    signal: getMeetingProcessingSignal(meeting),
  };
}
function applyNotes(meeting: MeetingData, input: MeetingNotesInput) {
  meeting.notesText = input.notesText;
  meeting.processing = input.processing;
  meeting.summarySentence = input.summarySentence;
  meeting.summaryLabel = input.summaryLabel;
  meeting.meetingName = input.meetingName;
}
export async function ensureLiveMeetingNotes(meeting: MeetingData) {
  const input = liveMeetingNotesInput(meeting);
  if (
    input.generateNotes &&
    !input.notesText &&
    !input.processing?.notes &&
    input.finalTranscript?.trim() &&
    ["ready", "partial"].includes(input.processing?.transcription ?? "")
  ) {
    try {
      input.notesPrompt = await prepareLiveNotesPrompt(meeting);
    } catch (error) {
      input.processing = { ...input.processing, notes: "failed" };
      console.error("Error preparing meeting notes:", error);
    }
  }
  const result = await ensureMeetingNotes(input);
  applyNotes(meeting, input);
  return result;
}
export async function ensureLiveMeetingSummaries(
  meeting: MeetingData,
  notes: string | undefined,
) {
  const input = liveMeetingNotesInput(meeting);
  const result = await ensureMeetingSummaries(input, notes);
  applyNotes(meeting, input);
  return result;
}
