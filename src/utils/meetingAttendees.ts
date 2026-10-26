import type { MeetingData } from "../types/meeting-data";
import { resolveAttendeeDisplayName } from "./participants";

export const resolveMeetingAttendees = (
  meeting: Pick<MeetingData, "participants" | "attendance">,
): string[] => {
  const participants = meeting.participants ?? new Map();
  return Array.from(meeting.attendance).map((attendee) =>
    resolveAttendeeDisplayName(attendee, participants),
  );
};
