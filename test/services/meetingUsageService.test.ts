import {
  getNextAvailableAt,
  sumMeetingSecondsInWindow,
} from "../../src/services/meetingUsageService";
import type { MeetingHistory } from "../../src/types/db";

const buildMeeting = (
  timestamp: string,
  durationSeconds: number,
): MeetingHistory => ({
  guildId: "guild",
  channelId_timestamp: `voice#${timestamp}`,
  meetingId: `meeting-${timestamp}`,
  channelId: "voice",
  timestamp,
  participants: [],
  duration: durationSeconds,
  transcribeMeeting: true,
  generateNotes: true,
});

describe("meetingUsageService", () => {
  it("sums meeting seconds inside a rolling window", () => {
    const now = Date.parse("2025-01-10T00:00:00Z");
    const windowStart = Date.parse("2025-01-03T00:00:00Z");
    const meetings: MeetingHistory[] = [
      buildMeeting("2025-01-02T12:00:00Z", 600),
      buildMeeting("2025-01-05T12:00:00Z", 900),
      buildMeeting("2025-01-09T12:00:00Z", 300),
    ];

    const total = sumMeetingSecondsInWindow(meetings, windowStart, now);
    expect(total).toBe(1200);
  });

  it("finds the next available time once the rolling window drops under cap", () => {
    const now = Date.parse("2025-01-10T00:00:00Z");
    const windowMs = 7 * 24 * 60 * 60 * 1000;
    const windowStart = now - windowMs;
    const meetings: MeetingHistory[] = [
      buildMeeting("2025-01-04T00:00:00Z", 1200),
      buildMeeting("2025-01-05T00:00:00Z", 1200),
      buildMeeting("2025-01-09T00:00:00Z", 1200),
    ];

    const nextAvailableAt = getNextAvailableAt(
      meetings,
      windowStart,
      windowMs,
      1800,
    );

    expect(nextAvailableAt).toBe("2025-01-12T00:00:00.000Z");
  });

  it("skips a meeting with no transcript but still counts an unknown outcome", () => {
    const now = Date.parse("2025-01-10T00:00:00Z");
    const windowStart = Date.parse("2025-01-03T00:00:00Z");
    const meetings: MeetingHistory[] = [
      {
        ...buildMeeting("2025-01-05T12:00:00Z", 7200),
        processing: { transcription: "empty" },
      },
      buildMeeting("2025-01-06T12:00:00Z", 600),
    ];

    expect(sumMeetingSecondsInWindow(meetings, windowStart, now)).toBe(600);
  });
});
