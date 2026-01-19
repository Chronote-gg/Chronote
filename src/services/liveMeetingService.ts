import type { MeetingData } from "../types/meeting-data";
import type { LiveMeetingMeta, LiveMeetingStatus } from "../types/liveMeeting";
import { resolveMeetingStatus } from "../types/meetingLifecycle";
import { resolveAttendeeDisplayName } from "../utils/participants";

export function resolveLiveMeetingAttendees(meeting: MeetingData): string[] {
  const participants = meeting.participants ?? new Map();
  return Array.from(meeting.attendance).map((attendee) =>
    resolveAttendeeDisplayName(attendee, participants),
  );
}

export function buildLiveMeetingMeta(meeting: MeetingData): LiveMeetingMeta {
  const status: LiveMeetingStatus = resolveMeetingStatus({
    cancelled: meeting.cancelled,
    finished: meeting.finished,
    finishing: meeting.finishing,
  });
  return {
    guildId: meeting.guildId,
    meetingId: meeting.meetingId,
    channelId: meeting.voiceChannel.id,
    channelName: meeting.voiceChannel.name,
    startedAt: meeting.startTime.toISOString(),
    isAutoRecording: meeting.isAutoRecording,
    status,
    attendees: resolveLiveMeetingAttendees(meeting),
  };
}
