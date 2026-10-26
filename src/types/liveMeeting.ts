import type { MeetingEvent } from "./meetingTimeline";
import type { MeetingCapturePresentation } from "../utils/meetingCaptureNotice";
import type {
  AutoRecordRule,
  MeetingEndReason,
  MeetingStartReason,
  MeetingStatus,
} from "./meetingLifecycle";

export type LiveMeetingStatus = MeetingStatus | "unavailable";

export type LiveMeetingMeta = Omit<MeetingCapturePresentation, "status"> & {
  guildId: string;
  meetingId: string;
  channelId: string;
  channelName: string;
  startedAt: string;
  isAutoRecording: boolean;
  status: LiveMeetingStatus;
  attendees: string[];
};

export type LiveMeetingInitPayload = {
  meeting: LiveMeetingMeta;
  events: MeetingEvent[];
};

export type LiveMeetingEventsPayload = {
  events: MeetingEvent[];
  removedEventIds?: string[];
};

export type LiveMeetingAttendeesPayload = {
  attendees: string[];
};

export type LiveMeetingStatusPayload = Omit<
  MeetingCapturePresentation,
  "status"
> & {
  status: LiveMeetingStatus;
  endedAt?: string;
};

export type LiveMeetingStatusResponse = {
  status: LiveMeetingStatus;
  endedAt?: string;
  startReason?: MeetingStartReason;
  startTriggeredByUserId?: string;
  autoRecordRule?: AutoRecordRule;
  endReason?: MeetingEndReason;
  endTriggeredByUserId?: string;
  cancellationReason?: string;
};
