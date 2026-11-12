import type { MeetingHistory } from "../../src/types/db";

/** A synthetic recording row in its starting state. */
export const history: MeetingHistory = {
  guildId: "guild",
  channelId_timestamp: "channel#2026-01-01T00:00:00Z",
  meetingId: "meeting",
  channelId: "channel",
  timestamp: "2026-01-01T00:00:00Z",
  participants: [],
  duration: 0,
  transcribeMeeting: true,
  generateNotes: true,
  status: "starting",
  ownerInstanceId: "old",
  executionVersion: 1,
};
