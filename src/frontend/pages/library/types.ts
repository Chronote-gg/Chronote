import type { MeetingStatus } from "../../../types/meetingLifecycle";

export type ArchiveFilter = "active" | "archived" | "all";

export type MeetingSummaryRow = {
  id: string;
  meetingId: string;
  serverId?: string;
  serverName?: string;
  channelId: string;
  channelName: string;
  timestamp: string;
  duration: number;
  tags: string[];
  notes: string;
  meetingName?: string;
  summarySentence?: string;
  summaryLabel?: string;
  notesChannelId?: string;
  notesMessageId?: string;
  audioAvailable: boolean;
  transcriptAvailable: boolean;
  notesAvailable?: boolean;
  portalUrl?: string;
  status?: MeetingStatus;
  archivedAt?: string;
  archivedByUserId?: string;
};

export type MeetingListItem = MeetingSummaryRow & {
  title: string;
  summary: string;
  dateLabel: string;
  durationLabel: string;
  channelLabel: string;
};
