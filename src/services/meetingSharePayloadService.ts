import type { MeetingHistory } from "../types/db";
import type { ChatEntry } from "../types/chat";
import type { MeetingEvent } from "../types/meetingTimeline";
import type { Participant } from "../types/participants";
import type { TranscriptPayload } from "../types/transcript";
import { resolveAttendeeDisplayName } from "../utils/participants";
import { fetchJsonFromS3 } from "./storageService";
import {
  buildParticipantMap,
  createMeetingMentionReplacer,
} from "./meetingMentionService";
import { buildMeetingTimelineEventsFromHistory } from "./meetingTimelineService";

export type SharedMeetingPayload = {
  meeting: {
    title: string;
    meetingName?: string;
    summarySentence?: string;
    summaryLabel?: string;
    timestamp: string;
    duration: number;
    tags: string[];
    notes: string;
    transcript: string;
    archivedAt?: string;
    attendees: string[];
    events: MeetingEvent[];
  };
};

const resolveParticipantLabel = (participant: Participant) =>
  participant.serverNickname ||
  participant.displayName ||
  participant.username ||
  participant.tag ||
  "Unknown";

const resolveMeetingAttendees = (history: {
  participants?: Participant[];
  attendees?: string[];
}) => {
  const participants = buildParticipantMap(history.participants);
  if (history.attendees?.length) {
    return history.attendees.map((attendee) =>
      resolveAttendeeDisplayName(attendee, participants),
    );
  }
  if (history.participants?.length) {
    return history.participants.map((participant) =>
      resolveParticipantLabel(participant),
    );
  }
  return [];
};

export const sanitizeMeetingEventsForShare = (events: MeetingEvent[]) =>
  events.map((event, index) => {
    // MeetingEvent ids currently embed Discord user IDs and message IDs.
    // Shared meeting pages should not leak those.
    const rest = { ...event };
    delete rest.messageId;
    return {
      ...rest,
      id: `evt:${String(index).padStart(4, "0")}:${event.type}`,
    };
  });

export const resolveSharedMeetingTitle = (history: {
  meetingName?: string;
  summaryLabel?: string;
  summarySentence?: string;
}) =>
  history.meetingName?.trim() ||
  history.summaryLabel?.trim() ||
  history.summarySentence?.trim() ||
  "Shared meeting";

export async function buildSharedMeetingPayloadService(
  history: MeetingHistory,
): Promise<SharedMeetingPayload> {
  const transcriptPayload = history.transcriptS3Key
    ? await fetchJsonFromS3<TranscriptPayload>(history.transcriptS3Key)
    : undefined;
  const chatEntries = history.chatS3Key
    ? await fetchJsonFromS3<ChatEntry[]>(history.chatS3Key)
    : undefined;
  const resolveMentions = await createMeetingMentionReplacer(history);
  const transcript = resolveMentions(transcriptPayload?.text ?? "");
  const notes = resolveMentions(history.notes ?? "");
  const summarySentence = history.summarySentence
    ? resolveMentions(history.summarySentence)
    : history.summarySentence;
  // Titles can fall back to the summary sentence, so resolve mentions before
  // deriving one or a raw id leaks into the shared page title.
  const title = resolveSharedMeetingTitle({ ...history, summarySentence });
  const events = buildMeetingTimelineEventsFromHistory({
    history,
    transcriptPayload,
    chatEntries,
  });

  return {
    meeting: {
      title,
      meetingName: history.meetingName,
      summarySentence,
      summaryLabel: history.summaryLabel,
      timestamp: history.timestamp,
      duration: history.duration,
      tags: history.tags ?? [],
      notes,
      transcript,
      archivedAt: history.archivedAt,
      attendees: resolveMeetingAttendees(history),
      events: sanitizeMeetingEventsForShare(events),
    },
  };
}
