import type { MeetingUpdatePublicDelivery } from "../../../../services/meetingUpdateStatus";
import { useEffect, useMemo, useRef } from "react";
import { trpc } from "../../../services/trpc";
import { useLiveMeetingStream } from "../../../hooks/useLiveMeetingStream";
import {
  buildMeetingDetails,
  type MeetingDetailInput,
  type MeetingDetails,
} from "../../../utils/meetingLibrary";
import { MEETING_STATUS } from "../../../../types/meetingLifecycle";
import type { LiveMeetingStatus } from "../../../../types/liveMeeting";
import type { MeetingEvent } from "../../../../types/meetingTimeline";
import type { MeetingProcessingRetryProps } from "../components/MeetingProcessingRetry";
import { useProcessingRetry } from "./useProcessingRetry";

const UPDATE_DELIVERY_REFRESH_MS = 5000;
const MAX_UPDATE_DELIVERY_REFRESH_READS = 60;

type UseMeetingDetailParams = {
  opened: boolean;
  acknowledgedDelivery?: MeetingUpdatePublicDelivery;
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
  displayStatus: LiveMeetingStatus;
  displayAttendees: string[];
  displayEvents: MeetingEvent[];
  timelineEmptyLabel: string;
  processingRetry?: MeetingProcessingRetryProps;
};

const isDetailQueryEnabled = (params: UseMeetingDetailParams) =>
  params.opened &&
  params.selectedGuildId != null &&
  params.selectedMeetingId != null;

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
  ["complete", "cancelled", "interrupted", "failed", "unavailable"].includes(
    status,
  );

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
  enabled: boolean,
): LiveMeetingStatus => {
  if (enabled && liveStream.meeting) {
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
    if (!shouldRefetchMeeting(params.status)) {
      refetchedMeetingRef.current = null;
      return;
    }
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
    case "unavailable":
      return "Recording status cannot be confirmed. Recheck to resume live updates.";
    case "error":
      return "Live transcript connection is unavailable. Recheck to reconnect.";
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
    {
      enabled: isDetailQueryEnabled(params),
      refetchInterval: (query) =>
        ["queued", "running"].includes(
          query.state.data?.meeting?.processingRetry?.status ?? "",
        )
          ? UPDATE_DELIVERY_REFRESH_MS
          : false,
    },
  );

  const queriedDetail = resolveDetail(detailQuery.data);
  const detail =
    queriedDetail?.id === params.selectedMeetingId ? queriedDetail : null;
  const acknowledgment = params.acknowledgedDelivery;
  const delivery =
    acknowledgment &&
    (!detail?.updateDelivery ||
      detail.updateDelivery.desiredRevision < acknowledgment.desiredRevision)
      ? acknowledgment
      : detail?.updateDelivery;
  const pollable = delivery?.pollable === true;
  const desiredRevision = delivery?.desiredRevision;
  const refetch = detailQuery.refetch;
  useEffect(() => {
    if (
      !params.opened ||
      !params.selectedGuildId ||
      !params.selectedMeetingId ||
      !pollable
    )
      return;
    let active = true;
    // Each fresh pending episode gets a bounded budget, including a later save.
    let remaining = MAX_UPDATE_DELIVERY_REFRESH_READS;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      if (!active || remaining-- <= 0) return;
      try {
        await refetch({ cancelRefetch: false });
      } catch {
        // Query errors retain canonical content; a later bounded read can recover.
      }
      if (active && remaining > 0)
        timer = setTimeout(() => void refresh(), UPDATE_DELIVERY_REFRESH_MS);
    };
    timer = setTimeout(() => void refresh(), UPDATE_DELIVERY_REFRESH_MS);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [
    params.opened,
    params.selectedGuildId,
    params.selectedMeetingId,
    pollable,
    desiredRevision,
    refetch,
  ]);

  const processingRetry = useProcessingRetry(params.selectedGuildId, detail);

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

  const displayStatus = resolveDisplayStatus(
    liveStream,
    meeting,
    liveStreamEnabled,
  );
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
    detailLoading: detailQuery.isLoading && !detail,
    detailError: detail ? null : detailQuery.error,
    liveStreamEnabled,
    liveStream,
    displayStatus,
    displayAttendees,
    displayEvents,
    timelineEmptyLabel,
    processingRetry,
  };
};
