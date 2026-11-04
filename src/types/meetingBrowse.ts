import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import type { MeetingHistory } from "./db";
export type MeetingBrowseScope =
  { kind: "all" } | { kind: "personal" } | { kind: "guild"; serverId: string };
export type MeetingBrowseFilters = {
  scope: MeetingBrowseScope;
  attendedOnly: boolean;
  channelId?: string;
};
export type GuildShareIndexMetadata = Pick<
  MeetingHistory,
  | "guildId"
  | "channelId_timestamp"
  | "meetingId"
  | "timestamp"
  | "ownershipScope"
  | "ownerUserId"
  | "accessGrants"
>;
export type MeetingBrowseStorageCursor = Record<string, AttributeValue>;
export type MeetingBrowsePageOptions = {
  startTimestamp: string;
  endTimestamp: string;
  limit: number;
  cursor?: MeetingBrowseStorageCursor;
  signal?: AbortSignal;
};
export type MeetingBrowsePage<T> = {
  items: Array<{ record: T; cursorAfter: MeetingBrowseStorageCursor }>;
  nextCursor?: MeetingBrowseStorageCursor;
};
