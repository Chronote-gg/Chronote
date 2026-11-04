import type { MeetingHistory } from "../types/db";
export const createMeeting = (
  meetingId: string,
  overrides: Partial<MeetingHistory> = {},
): MeetingHistory => ({
  guildId: overrides.guildId ?? "guild-1",
  channelId: overrides.channelId ?? "channel-1",
  channelId_timestamp:
    overrides.channelId_timestamp ??
    `${overrides.channelId ?? "channel-1"}#${overrides.timestamp ?? "2026-01-01T00:00:00.000Z"}-${meetingId}`,
  meetingId,
  timestamp: overrides.timestamp ?? "2026-01-01T00:00:00.000Z",
  participants: overrides.participants ?? [],
  duration: overrides.duration ?? 120,
  transcribeMeeting: true,
  generateNotes: true,
  ...overrides,
});
