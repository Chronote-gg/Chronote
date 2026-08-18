import type { MeetingEvent } from "../../../../types/meetingTimeline";
import type {
  MeetingDetailInput,
  MeetingDetails,
} from "../../../utils/meetingLibrary";

export type MeetingExport = {
  meeting: {
    id: string;
    meetingId: string;
    channelId: string;
    timestamp: string;
    duration: number;
    tags: string[];
    notes: string;
    notesChannelId?: string;
    notesMessageId?: string;
    transcript?: string;
    audioUrl?: string;
    archivedAt?: string;
    attendees: string[];
    events: MeetingEvent[];
    title: string;
    meetingName?: string;
    summary: string;
    summarySentence?: string;
    summaryLabel?: string;
    dateLabel: string;
    durationLabel: string;
    channel: string;
  };
};

const normalizeOptionalString = (
  value: string | null | undefined,
): string | undefined => (value == null ? undefined : value);

export const buildMeetingExport = (
  detail: MeetingDetailInput,
  meeting: MeetingDetails,
): MeetingExport => ({
  meeting: {
    id: detail.id,
    meetingId: detail.meetingId,
    channelId: detail.channelId,
    timestamp: detail.timestamp,
    duration: detail.duration,
    tags: detail.tags ?? [],
    notes: detail.notes ?? "",
    notesChannelId: normalizeOptionalString(detail.notesChannelId),
    notesMessageId: normalizeOptionalString(detail.notesMessageId),
    ...(detail.transcriptAccessEnabled !== false
      ? { transcript: detail.transcript ?? "" }
      : {}),
    ...(detail.audioAccessEnabled !== false
      ? { audioUrl: normalizeOptionalString(detail.audioUrl) }
      : {}),
    archivedAt: normalizeOptionalString(detail.archivedAt),
    attendees: detail.attendees ?? [],
    events:
      detail.transcriptAccessEnabled !== false ? (detail.events ?? []) : [],
    title: meeting.title,
    meetingName: meeting.meetingName,
    summary: meeting.summary,
    summarySentence: normalizeOptionalString(detail.summarySentence),
    summaryLabel: normalizeOptionalString(detail.summaryLabel),
    dateLabel: meeting.dateLabel,
    durationLabel: meeting.durationLabel,
    channel: meeting.channel,
  },
});

const toFileSafe = (value: string) =>
  value
    .trim()
    .replace(/[^\w-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");

export const downloadMeetingExport = (
  detail: MeetingDetailInput,
  meeting: MeetingDetails,
) => {
  const payload = buildMeetingExport(detail, meeting);
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const meetingName = toFileSafe(meeting.title || "meeting") || "meeting";
  const dateLabel = toFileSafe(meeting.dateLabel);
  const link = document.createElement("a");
  link.href = url;
  link.download = dateLabel
    ? `${meetingName}-${dateLabel}.json`
    : `${meetingName}.json`;
  link.click();
  URL.revokeObjectURL(url);
};
