import type { MeetingBrowseScope } from "./meetingBrowse";
import type { McpTokenRestriction } from "./mcpOAuth";
export type MeetingRef = { serverId: string; id: string };
export type MeetingSearchPrincipal = {
  userId: string;
  scope?: MeetingBrowseScope;
  restriction?: McpTokenRestriction;
  serverIds: string[];
  channelId?: string;
  tags?: string[];
};
export type MeetingSearchFilters = {
  serverIds?: string[];
  meetingIds?: MeetingRef[];
  from?: string;
  before?: string;
  channelId?: string;
  tags?: string[];
  archive?: "active" | "all" | "archived";
};
export type MeetingSearchRequest = {
  query: string;
  filters?: MeetingSearchFilters;
  pageSize?: number;
  cursor?: string;
};
export type TranscriptSearchRequest = {
  query: string;
  meetingIds: MeetingRef[];
  pageSize?: number;
  cursor?: string;
};
export type SearchCoverage = {
  status: "ready" | "partial" | "unavailable";
  semanticStatus: "ready" | "partial" | "unavailable";
  ranking: "authorized_partition_order";
  windowLimited?: boolean;
};
export type MeetingSearchHit = {
  meeting: MeetingRef;
  title: string;
  startedAt: string;
  tags: string[];
  archived: boolean;
  summary?: string;
  notes: string;
  notesRevision: string;
  transcriptAvailable: boolean;
};
export type TranscriptSearchHit = {
  meeting: MeetingRef;
  revision: string;
  text: string;
  location: { start: number; end: number };
  passageRef: string;
};
export type MeetingSearchCandidate = {
  key: string;
  meeting: MeetingRef;
  sourceRevision: string;
  transcriptHash?: string;
  start?: number;
  end?: number;
};
export class MeetingSearchError extends Error {
  constructor(
    public readonly code:
      | "invalid_argument"
      | "not_available"
      | "source_unavailable"
      | "source_changed"
      | "invalid_cursor"
      | "temporarily_unavailable",
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "MeetingSearchError";
  }
}
