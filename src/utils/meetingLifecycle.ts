import {
  MEETING_END_REASONS,
  MEETING_START_REASONS,
  type AutoRecordRule,
  type MeetingEndReason,
  type MeetingStartReason,
} from "../types/meetingLifecycle";

export const MEETING_START_REASON_LABELS: Record<MeetingStartReason, string> = {
  [MEETING_START_REASONS.MANUAL_COMMAND]: "Started via /startmeeting",
  [MEETING_START_REASONS.AUTO_RECORD_CHANNEL]: "Auto-recorded (channel rule)",
  [MEETING_START_REASONS.AUTO_RECORD_ALL]: "Auto-recorded (all channels rule)",
};

export const MEETING_END_REASON_LABELS: Record<MeetingEndReason, string> = {
  [MEETING_END_REASONS.BUTTON]: "Ended via End Meeting button",
  [MEETING_END_REASONS.CHANNEL_EMPTY]:
    "Ended because the voice channel was empty",
  [MEETING_END_REASONS.TIMEOUT]:
    "Ended after reaching the maximum meeting duration",
  [MEETING_END_REASONS.LIVE_VOICE]: "Ended via live voice command",
  [MEETING_END_REASONS.BOT_DISCONNECT]: "Ended because the bot disconnected",
  [MEETING_END_REASONS.WEB_UI]: "Ended via web UI",
  [MEETING_END_REASONS.DISMISSED]: "Stopped by a channel member",
  [MEETING_END_REASONS.AUTO_CANCELLED]:
    "Auto-recording cancelled due to lack of content",
  [MEETING_END_REASONS.UNKNOWN]: "Reason unknown",
};

export function describeAutoRecordRule(
  rule?: AutoRecordRule,
  voiceChannelName?: string,
): string {
  if (!rule) return "Auto-record rule unavailable";
  if (rule.mode === "all") {
    return "Auto-record rule: all voice channels";
  }
  if (rule.channelId) {
    return `Auto-record rule: <#${rule.channelId}>`;
  }
  const channelLabel = voiceChannelName ? ` (#${voiceChannelName})` : "";
  return `Auto-record rule: this channel${channelLabel}`;
}
