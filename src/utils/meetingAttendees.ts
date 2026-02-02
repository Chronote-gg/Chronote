import type { MeetingData } from "../types/meeting-data";
import { resolveAttendeeDisplayName } from "./participants";

export const resolveMeetingAttendees = (meeting: MeetingData): string[] => {
  const participants = meeting.participants ?? new Map();
  return Array.from(meeting.attendance).map((attendee) =>
    resolveAttendeeDisplayName(attendee, participants),
  );
};
