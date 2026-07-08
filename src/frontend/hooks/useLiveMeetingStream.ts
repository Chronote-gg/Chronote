import { useCallback, useEffect, useRef, useState } from "react";
import { buildApiUrl } from "../services/apiClient";
import type {
  LiveMeetingAttendeesPayload,
  LiveMeetingEventsPayload,
  LiveMeetingInitPayload,
  LiveMeetingMeta,
  LiveMeetingStatus,
  LiveMeetingStatusPayload,
} from "../../types/liveMeeting";
import type { MeetingEvent } from "../../types/meetingTimeline";
import { MEETING_STATUS } from "../../types/meetingLifecycle";

type LiveStreamStatus =
  "connecting" | "live" | "processing" | "complete" | "cancelled" | "error";

const toStreamStatus = (status: LiveMeetingStatus): LiveStreamStatus => {
  if (status === MEETING_STATUS.COMPLETE) return "complete";
  if (status === MEETING_STATUS.PROCESSING) return "processing";
  if (status === MEETING_STATUS.CANCELLED) return "cancelled";
  return "live";
};

type UseLiveMeetingStreamOptions = {
  guildId: string;
  meetingId: string;
  enabled: boolean;
};

export function useLiveMeetingStream({
  guildId,
  meetingId,
  enabled,
}: UseLiveMeetingStreamOptions) {
  const [meeting, setMeeting] = useState<LiveMeetingMeta | null>(null);
  const [events, setEvents] = useState<MeetingEvent[]>([]);
  const [attendees, setAttendees] = useState<string[]>([]);
  const [status, setStatus] = useState<LiveStreamStatus>("connecting");
  const [retryKey, setRetryKey] = useState(0);
  const seenRef = useRef<Set<string>>(new Set());

  const retry = useCallback(() => {
    setRetryKey((current) => current + 1);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    if (!guildId || !meetingId) return;

    setMeeting(null);
    setEvents([]);
    setAttendees([]);
    setStatus("connecting");
    seenRef.current = new Set();

    const url = buildApiUrl(`/api/live/${guildId}/${meetingId}/stream`);
    const source = new EventSource(url, { withCredentials: true });

    source.addEventListener("init", (event) => {
      const payload = JSON.parse(event.data) as LiveMeetingInitPayload;
      setMeeting(payload.meeting);
      setEvents(payload.events);
      setAttendees(payload.meeting.attendees ?? []);
      seenRef.current = new Set(payload.events.map((entry) => entry.id));
      setStatus(toStreamStatus(payload.meeting.status));
    });

    source.addEventListener("events", (event) => {
      const payload = JSON.parse(event.data) as LiveMeetingEventsPayload;
      const next = payload.events.filter((entry) => {
        if (seenRef.current.has(entry.id)) return false;
        seenRef.current.add(entry.id);
        return true;
      });
      if (next.length > 0) {
        setEvents((current) => [...current, ...next]);
      }
    });

    source.addEventListener("attendees", (event) => {
      const payload = JSON.parse(event.data) as LiveMeetingAttendeesPayload;
      setAttendees(payload.attendees);
    });

    source.addEventListener("status", (event) => {
      const payload = JSON.parse(event.data) as LiveMeetingStatusPayload;
      setMeeting((current) =>
        current ? { ...current, status: payload.status } : current,
      );
      setStatus(toStreamStatus(payload.status));
    });

    source.onerror = () => {
      setStatus((current) =>
        current === MEETING_STATUS.COMPLETE ||
        current === MEETING_STATUS.CANCELLED
          ? current
          : "error",
      );
      source.close();
    };

    return () => {
      source.close();
    };
  }, [enabled, guildId, meetingId, retryKey]);

  return {
    meeting,
    events,
    attendees,
    status,
    retry,
  };
}
