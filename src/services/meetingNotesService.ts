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
  if (meeting.processing?.notes) return meeting.notesText;

  const transcriptionOutcome = meeting.processing?.transcription;
  if (transcriptionOutcome === "empty" || transcriptionOutcome === "failed") {
    meeting.processing = { ...meeting.processing, notes: "skipped" };
    return undefined;
  }
  if (
    meeting.finalTranscript === undefined ||
    !meeting.finalTranscript.trim() ||
    (transcriptionOutcome !== "ready" && transcriptionOutcome !== "partial")
  ) {
    meeting.processing = { ...meeting.processing, notes: "failed" };
    console.error(
      "Cannot generate meeting notes before transcription resolves",
      {
        meetingId: meeting.meetingId,
        transcriptionOutcome,
      },
    );
    return undefined;
  }
  try {
    const notes = await getNotes(meeting);
    if (!notes.trim()) {
      meeting.processing = { ...meeting.processing, notes: "failed" };
      console.error("Meeting notes generation returned an empty result", {
        meetingId: meeting.meetingId,
      });
      return undefined;
    }
    meeting.notesText = notes;
    meeting.processing = { ...meeting.processing, notes: "generated" };
    return meeting.notesText;
  } catch (error) {
    meeting.processing = { ...meeting.processing, notes: "failed" };
    console.error("Error generating meeting notes:", error);
    return undefined;
  }
}

export async function ensureMeetingSummaries(
  meeting: MeetingData,
  notes: string | undefined,
): Promise<MeetingSummaries> {
  if (!meeting.generateNotes) return {};
  if (meeting.summarySentence || meeting.summaryLabel) {
    return {
      summarySentence: meeting.summarySentence,
      summaryLabel: meeting.summaryLabel,
    };
  }
  if (meeting.processing?.summary) {
    return {
      summarySentence: meeting.summarySentence,
      summaryLabel: meeting.summaryLabel,
    };
  }
  if (!notes || !notes.trim()) {
    meeting.processing = { ...meeting.processing, summary: "skipped" };
    return {};
  }
  try {
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
    if (!summaries.summarySentence?.trim() && !summaries.summaryLabel?.trim()) {
      meeting.processing = { ...meeting.processing, summary: "failed" };
      console.error("Meeting summary generation returned an empty result", {
        meetingId: meeting.meetingId,
      });
      return {};
    }
    meeting.summarySentence = summaries.summarySentence;
    meeting.summaryLabel = summaries.summaryLabel;
    meeting.processing = { ...meeting.processing, summary: "generated" };
    if (!meeting.meetingName) {
      meeting.meetingName = await resolveMeetingNameFromSummary({
        guildId: meeting.guildId,
        meetingId: meeting.meetingId,
        summaryLabel: summaries.summaryLabel,
      });
    }
    return summaries;
  } catch (error) {
    meeting.processing = { ...meeting.processing, summary: "failed" };
    console.error("Error generating meeting summaries:", error);
    return {};
  }
}
