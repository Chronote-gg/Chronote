import {
  MEETING_END_REASONS,
  type AutoRecordRule,
  type MeetingEndReason,
} from "../types/meetingLifecycle";
import type { MeetingData } from "../types/meeting-data";
import type { MeetingHistory } from "../types/db";

/** Written when a member dismisses an auto-recording, wherever the dismissal is applied. */
export const dismissalCancellationReason = (userId: string): string =>
  `Stopped by <@${userId}>`;

/** Auto-record's creator is the bot; attribute only to a known triggering member. */
export function resolveMeetingActorId(
  meeting: MeetingData,
): string | undefined {
  if (meeting.startTriggeredByUserId) return meeting.startTriggeredByUserId;
  return meeting.isAutoRecording ? undefined : meeting.creator.id;
}

/** The same attribution read from a saved history row. */
export function resolveHistoryActorId(
  history: Pick<
    MeetingHistory,
    "startTriggeredByUserId" | "isAutoRecording" | "meetingCreatorId"
  >,
): string | undefined {
  if (history.startTriggeredByUserId) return history.startTriggeredByUserId;
  return history.isAutoRecording ? undefined : history.meetingCreatorId;
}

export const MEETING_END_REASON_LABELS: Record<MeetingEndReason, string> = {
  [MEETING_END_REASONS.BUTTON]: "Ended via End Meeting button",
  [MEETING_END_REASONS.CHANNEL_EMPTY]:
    "Ended because the voice channel was empty",
  [MEETING_END_REASONS.TIMEOUT]:
    "Ended after reaching the maximum meeting duration",
  [MEETING_END_REASONS.LIVE_VOICE]: "Ended via live voice command",
  [MEETING_END_REASONS.MCP]: "Ended via MCP",
  [MEETING_END_REASONS.BOT_DISCONNECT]: "Ended because the bot disconnected",
  [MEETING_END_REASONS.LEAVE_COMMAND]: "Ended via /leave",
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

export function isMeetingCollectingEvents(
  meeting: MeetingData | undefined,
): meeting is MeetingData {
  return meeting !== undefined && !meeting.finishing && !meeting.finished;
}
