import { MeetingData } from "../types/meeting-data";
import { getNotes } from "./notesService";
import {
  generateMeetingSummaries,
  type MeetingSummaries,
} from "./meetingSummaryService";
import { resolveMeetingNameFromSummary } from "./meetingNameService";

export async function ensureMeetingNotes(
  meeting: MeetingData,
): Promise<string | undefined> {
  if (!meeting.generateNotes) return meeting.notesText;
  if (meeting.notesText) return meeting.notesText;
  if (!meeting.finalTranscript) {
    console.warn(
      "Skipping notes generation because final transcript is missing.",
    );
    return meeting.notesText;
  }
  try {
    const notes = await getNotes(meeting);
    meeting.notesText = notes;
    return notes;
  } catch (error) {
    console.error("Error generating meeting notes:", error);
    return meeting.notesText;
  }
}

export async function ensureMeetingSummaries(
  meeting: MeetingData,
  notes: string | undefined,
): Promise<MeetingSummaries> {
  if (meeting.summarySentence || meeting.summaryLabel) {
    return {
      summarySentence: meeting.summarySentence,
      summaryLabel: meeting.summaryLabel,
    };
  }
  if (!notes || !notes.trim()) {
    return {};
  }
  const summaries = await generateMeetingSummaries({
    guildId: meeting.guildId,
    notes,
    serverName: meeting.guild.name,
    channelName: meeting.voiceChannel.name,
    tags: meeting.tags,
    now: meeting.startTime ?? new Date(),
    meetingId: meeting.meetingId,
    parentSpanContext: meeting.langfuseParentSpanContext,
    modelParams: meeting.runtimeConfig?.modelParams?.meetingSummary,
    modelOverride: meeting.runtimeConfig?.modelChoices?.meetingSummary,
  });
  meeting.summarySentence = summaries.summarySentence;
  meeting.summaryLabel = summaries.summaryLabel;
  if (!meeting.meetingName) {
    meeting.meetingName = await resolveMeetingNameFromSummary({
      guildId: meeting.guildId,
      meetingId: meeting.meetingId,
      summaryLabel: summaries.summaryLabel,
    });
  }
  return summaries;
}
