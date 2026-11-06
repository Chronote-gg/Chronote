import type { MeetingHistory } from "../types/db";
import { listMeetingsForGuildInRangeService } from "./meetingHistoryService";
import { getGrantUsageResetAt } from "./entitlementUsageService";

const ROLLING_WINDOW_DAYS = 7;
const ROLLING_WINDOW_MS = ROLLING_WINDOW_DAYS * 24 * 60 * 60 * 1000;

export type RollingUsageWindow = {
  usedSeconds: number;
  windowStartIso: string;
  windowEndIso: string;
  nextAvailableAtIso: string | null;
  meetings: MeetingHistory[];
};

// Metered time has to correspond to something recorded. A missing outcome is
// unknown rather than empty, so it still counts.
function isMeteredMeeting(meeting: MeetingHistory): boolean {
  return meeting.processing?.transcription !== "empty";
}

export function sumMeetingSecondsInWindow(
  meetings: MeetingHistory[],
  windowStartMs: number,
  windowEndMs: number,
): number {
  return meetings.reduce((total, meeting) => {
    if (!meeting.timestamp) return total;
    const ts = Date.parse(meeting.timestamp);
    if (Number.isNaN(ts)) return total;
    if (ts < windowStartMs || ts > windowEndMs) return total;
    if (!isMeteredMeeting(meeting)) return total;
    return total + (meeting.duration ?? 0);
  }, 0);
}

export function getNextAvailableAt(
  meetings: MeetingHistory[],
  windowStartMs: number,
  windowMs: number,
  limitSeconds: number,
): string | null {
  if (limitSeconds <= 0) return null;
  const windowMeetings = meetings
    .filter((meeting) => meeting.timestamp)
    .map((meeting) => ({
      ...meeting,
      timestampMs: Date.parse(meeting.timestamp),
    }))
    .filter((meeting) => !Number.isNaN(meeting.timestampMs))
    .filter((meeting) => meeting.timestampMs >= windowStartMs)
    .filter(isMeteredMeeting)
    .sort((a, b) => a.timestampMs - b.timestampMs);

  const totalSeconds = windowMeetings.reduce(
    (sum, meeting) => sum + (meeting.duration ?? 0),
    0,
  );
  if (totalSeconds <= limitSeconds) return null;

  let remaining = totalSeconds;
  for (const meeting of windowMeetings) {
    remaining -= meeting.duration ?? 0;
    if (remaining <= limitSeconds) {
      return new Date(meeting.timestampMs + windowMs).toISOString();
    }
  }

  const last = windowMeetings[windowMeetings.length - 1];
  return last ? new Date(last.timestampMs + windowMs).toISOString() : null;
}

export async function getRollingUsageForGuild(
  guildId: string,
  now = new Date(),
): Promise<RollingUsageWindow> {
  const windowEndMs = now.getTime();
  const resetAt = await getGrantUsageResetAt(guildId, now);
  const windowStartMs = Math.max(
    windowEndMs - ROLLING_WINDOW_MS,
    resetAt ?? -Infinity,
  );
  const windowStartIso = new Date(windowStartMs).toISOString();
  const windowEndIso = new Date(windowEndMs).toISOString();
  const meetings = await listMeetingsForGuildInRangeService(
    guildId,
    windowStartIso,
    windowEndIso,
  );
  const usedSeconds = sumMeetingSecondsInWindow(
    meetings,
    windowStartMs,
    windowEndMs,
  );

  return {
    usedSeconds,
    windowStartIso,
    windowEndIso,
    nextAvailableAtIso: null,
    meetings,
  };
}

export function getRollingWindowMs() {
  return ROLLING_WINDOW_MS;
}
