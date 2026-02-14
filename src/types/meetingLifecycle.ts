export const MEETING_START_REASONS = {
  MANUAL_COMMAND: "manual_command",
  AUTO_RECORD_CHANNEL: "auto_record_channel",
  AUTO_RECORD_ALL: "auto_record_all",
} as const;

export type MeetingStartReason =
  (typeof MEETING_START_REASONS)[keyof typeof MEETING_START_REASONS];

export const MEETING_END_REASONS = {
  BUTTON: "button",
  CHANNEL_EMPTY: "channel_empty",
  TIMEOUT: "timeout",
  LIVE_VOICE: "live_voice",
  BOT_DISCONNECT: "bot_disconnect",
  WEB_UI: "web_ui",
  DISMISSED: "dismissed",
  AUTO_CANCELLED: "auto_cancelled",
  UNKNOWN: "unknown",
} as const;

export type MeetingEndReason =
  (typeof MEETING_END_REASONS)[keyof typeof MEETING_END_REASONS];

export const MEETING_STATUS = {
  IN_PROGRESS: "in_progress",
  PROCESSING: "processing",
  COMPLETE: "complete",
  CANCELLED: "cancelled",
} as const;

export type MeetingStatus =
  (typeof MEETING_STATUS)[keyof typeof MEETING_STATUS];

export const resolveMeetingStatus = (options: {
  cancelled?: boolean;
  finished?: boolean;
  finishing?: boolean;
}): MeetingStatus => {
  if (options.cancelled) return MEETING_STATUS.CANCELLED;
  if (options.finished) return MEETING_STATUS.COMPLETE;
  if (options.finishing) return MEETING_STATUS.PROCESSING;
  return MEETING_STATUS.IN_PROGRESS;
};

export type AutoRecordRule = {
  mode: "channel" | "all";
  channelId: string;
};
