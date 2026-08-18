import { useEffect, useMemo, useRef } from "react";
import { trpc } from "../../../services/trpc";
import { useLiveMeetingStream } from "../../../hooks/useLiveMeetingStream";
import {
  buildMeetingDetails,
  type MeetingDetailInput,
  type MeetingDetails,
} from "../../../utils/meetingLibrary";
import {
  MEETING_STATUS,
  type MeetingStatus,
} from "../../../../types/meetingLifecycle";
import type { MeetingEvent } from "../../../../types/meetingTimeline";

type UseMeetingDetailParams = {
  selectedGuildId: string | null;
  selectedMeetingId: string | null;
  channelNameMap: Map<string, string>;
  invalidateMeetingLists: () => Promise<void>;
};

type UseMeetingDetailResult = {
  detail: MeetingDetailInput | null;
  meeting: MeetingDetails | null;
  detailLoading: boolean;
  detailError: unknown;
  liveStreamEnabled: boolean;
  liveStream: ReturnType<typeof useLiveMeetingStream>;
  displayStatus: MeetingStatus;
  displayAttendees: string[];
  displayEvents: MeetingEvent[];
  timelineEmptyLabel: string;
};

const isDetailQueryEnabled = (params: UseMeetingDetailParams) =>
  params.selectedGuildId != null && params.selectedMeetingId != null;

const resolveDetail = (data: { meeting?: MeetingDetailInput } | undefined) => {
  if (!data || !data.meeting) return null;
  return data.meeting;
};

const buildMeetingFromDetail = (
  detail: MeetingDetailInput | null,
  channelNameMap: Map<string, string>,
) => {
  if (!detail) return null;
  return buildMeetingDetails(detail, channelNameMap);
};

const resolveLiveStreamEnabled = (
  meeting: MeetingDetails | null,
  selectedGuildId: string | null,
) => {
  if (!meeting || selectedGuildId == null) {
    return false;
  }
  if (!meeting.transcriptAccessEnabled) {
    return false;
  }
  if (meeting.status === MEETING_STATUS.IN_PROGRESS) {
    return true;
  }
  if (meeting.status === MEETING_STATUS.PROCESSING) {
    return true;
  }
  return false;
};

const shouldRefetchMeeting = (status: string) =>
  status === MEETING_STATUS.COMPLETE || status === MEETING_STATUS.CANCELLED;

const resolveLiveStreamParams = (
  meeting: MeetingDetails | null,
  selectedGuildId: string | null,
  enabled: boolean,
) => {
  const guildId = selectedGuildId ?? "";
  const meetingId = meeting ? meeting.meetingId : "";
  return { guildId, meetingId, enabled };
};

const resolveDisplayStatus = (
  liveStream: ReturnType<typeof useLiveMeetingStream>,
  meeting: MeetingDetails | null,
) => {
  if (liveStream.meeting && liveStream.meeting.status) {
    return liveStream.meeting.status;
  }
  if (meeting && meeting.status) {
    return meeting.status;
  }
  return MEETING_STATUS.COMPLETE;
};

const resolveDisplayAttendees = (
  enabled: boolean,
  liveStream: ReturnType<typeof useLiveMeetingStream>,
  meeting: MeetingDetails | null,
) => {
  if (enabled) {
    return liveStream.attendees;
  }
  if (meeting && meeting.attendees) {
    return meeting.attendees;
  }
  return [];
};

const resolveDisplayEvents = (
  enabled: boolean,
  liveStream: ReturnType<typeof useLiveMeetingStream>,
  meeting: MeetingDetails | null,
) => {
  if (enabled) {
    return liveStream.events;
  }
  if (meeting && meeting.events) {
    return meeting.events;
  }
  return [];
};

const resolveMeetingKey = (meeting: MeetingDetails | null) => {
  if (!meeting) return null;
  return meeting.id;
};

const useLiveStreamRefetch = (params: {
  enabled: boolean;
  status: string;
  meetingKey: string | null;
  selectedGuildId: string | null;
  invalidateMeetingLists: () => Promise<void>;
}) => {
  const trpcUtils = trpc.useUtils();
  const refetchedMeetingRef = useRef<string | null>(null);

  useEffect(() => {
    if (!params.enabled) return;
    if (!shouldRefetchMeeting(params.status)) return;
    if (!params.selectedGuildId || !params.meetingKey) return;
    if (refetchedMeetingRef.current === params.meetingKey) return;
    refetchedMeetingRef.current = params.meetingKey;
    void trpcUtils.meetings.detail.invalidate();
    void params.invalidateMeetingLists();
  }, [
    params.enabled,
    params.status,
    params.selectedGuildId,
    params.meetingKey,
    params.invalidateMeetingLists,
    trpcUtils.meetings.detail,
  ]);
};

const resolveTimelineEmptyLabel = (
  enabled: boolean,
  status: string,
): string => {
  if (!enabled) {
    return "Timeline data will appear after the meeting finishes processing.";
  }
  switch (status) {
    case MEETING_STATUS.PROCESSING:
      return "Meeting finished. Waiting for notes and timeline updates.";
    case MEETING_STATUS.CANCELLED:
      return "Meeting cancelled.";
    default:
      return "Waiting for the first transcript line...";
  }
};

export const useMeetingDetail = (
  params: UseMeetingDetailParams,
): UseMeetingDetailResult => {
  const detailQuery = trpc.meetings.detail.useQuery(
    {
      serverId: params.selectedGuildId ?? "",
      meetingId: params.selectedMeetingId ?? "",
    },
    { enabled: isDetailQueryEnabled(params) },
  );

  const detail = resolveDetail(detailQuery.data);

  const meeting = useMemo(() => {
    return buildMeetingFromDetail(detail, params.channelNameMap);
  }, [detail, params.channelNameMap]);

  const liveStreamEnabled = resolveLiveStreamEnabled(
    meeting,
    params.selectedGuildId,
  );
  const liveStream = useLiveMeetingStream(
    resolveLiveStreamParams(meeting, params.selectedGuildId, liveStreamEnabled),
  );

  const displayStatus = resolveDisplayStatus(liveStream, meeting);
  const displayAttendees = resolveDisplayAttendees(
    liveStreamEnabled,
    liveStream,
    meeting,
  );
  const displayEvents = resolveDisplayEvents(
    liveStreamEnabled,
    liveStream,
    meeting,
  );
  const timelineEmptyLabel = resolveTimelineEmptyLabel(
    liveStreamEnabled,
    liveStream.status,
  );

  const meetingKey = resolveMeetingKey(meeting);
  useLiveStreamRefetch({
    enabled: liveStreamEnabled,
    status: liveStream.status,
    meetingKey,
    selectedGuildId: params.selectedGuildId,
    invalidateMeetingLists: params.invalidateMeetingLists,
  });

  return {
    detail,
    meeting,
    detailLoading: detailQuery.isLoading || detailQuery.isFetching,
    detailError: detailQuery.error,
    liveStreamEnabled,
    liveStream,
    displayStatus,
    displayAttendees,
    displayEvents,
    timelineEmptyLabel,
  };
};
