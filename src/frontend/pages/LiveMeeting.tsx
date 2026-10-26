import { useEffect, useRef, useState } from "react";
import {
  Badge,
  Button,
  Center,
  Divider,
  Group,
  Loader,
  Stack,
  Switch,
  Text,
  Title,
} from "@mantine/core";
import { IconRefresh } from "@tabler/icons-react";
import { LiveMeetingOutcome } from "../components/LiveMeetingOutcome";
import { useParams } from "@tanstack/react-router";
import PageHeader from "../components/PageHeader";
import Surface from "../components/Surface";
import MeetingTimeline, {
  MEETING_TIMELINE_FILTERS,
} from "../components/MeetingTimeline";
import { buildApiUrl } from "../services/apiClient";
import { useAuth } from "../contexts/AuthContext";
import { useLiveMeetingStream } from "../hooks/useLiveMeetingStream";
import { formatDateTimeLabel } from "../utils/meetingLibrary";
import type { MeetingEventType } from "../../types/meetingTimeline";
import { MEETING_STATUS } from "../../types/meetingLifecycle";

const buildLoginUrl = () => {
  const base = buildApiUrl("/auth/discord");
  if (typeof window === "undefined") {
    return base;
  }
  return `${base}?redirect=${encodeURIComponent(window.location.href)}`;
};

const resolveStreamStatusLabel = (status: string) => {
  switch (status) {
    case "unavailable":
      return "Status unavailable";
    case MEETING_STATUS.INTERRUPTED:
      return "Interrupted";
    case MEETING_STATUS.FAILED:
      return "Failed";
    case MEETING_STATUS.STARTING:
      return "Starting";
    case MEETING_STATUS.PROCESSING:
      return "Processing";
    case MEETING_STATUS.COMPLETE:
      return "Complete";
    case MEETING_STATUS.CANCELLED:
      return "Cancelled";
    case "live":
      return "Live";
    default:
      return null;
  }
};

const resolveTimelineEmptyLabel = (status: string) => {
  switch (status) {
    case "unavailable":
      return "Live transcript updates are unavailable.";
    case MEETING_STATUS.INTERRUPTED:
      return "Recording was interrupted. Saved content may be incomplete.";
    case MEETING_STATUS.FAILED:
      return "Recording could not finish.";
    case MEETING_STATUS.STARTING:
      return "Recording is starting.";
    case MEETING_STATUS.PROCESSING:
      return "Meeting finished. Waiting for notes and timeline updates.";
    case MEETING_STATUS.CANCELLED:
      return "Meeting cancelled.";
    default:
      return "Waiting for the first transcript line...";
  }
};

export default function LiveMeeting() {
  const params = useParams({
    from: "/live/$guildId/$meetingId",
  });
  const { state: authState, loading: authLoading } = useAuth();
  const [autoScroll, setAutoScroll] = useState(true);
  const [activeFilters, setActiveFilters] = useState<MeetingEventType[]>(
    MEETING_TIMELINE_FILTERS.map((filter) => filter.value),
  );
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const stream = useLiveMeetingStream({
    guildId: params.guildId,
    meetingId: params.meetingId,
    enabled: authState === "authenticated",
  });

  useEffect(() => {
    if (!autoScroll) return;
    const viewport = viewportRef.current;
    if (!viewport) return;
    viewport.scrollTo({ top: viewport.scrollHeight, behavior: "smooth" });
  }, [stream.events, autoScroll]);

  if (authState === "unauthenticated") {
    return (
      <Stack gap="lg" data-testid="live-meeting-page">
        <PageHeader
          title="Live meeting"
          description="Sign in to view the live transcript."
        />
        <Surface p="lg">
          <Stack gap="sm" align="center">
            <Text size="sm" c="dimmed" ta="center">
              This live transcript requires Discord sign in with access to the
              voice channel.
            </Text>
            <Button component="a" href={buildLoginUrl()}>
              Sign in with Discord
            </Button>
          </Stack>
        </Surface>
      </Stack>
    );
  }

  if (authState === "unknown" || authLoading) {
    return (
      <Center py="xl">
        <Stack gap="xs" align="center">
          <Loader color="brand" />
          <Text c="dimmed">Checking sign in status...</Text>
        </Stack>
      </Center>
    );
  }

  const meeting = stream.meeting;
  const statusLabel = resolveStreamStatusLabel(stream.status);

  return (
    <Stack gap="lg" data-testid="live-meeting-page">
      <PageHeader
        title="Live meeting"
        description="Live transcript updates as the meeting progresses."
      />
      <Surface p="lg">
        <Group justify="space-between" align="center" wrap="wrap">
          <Stack gap={4}>
            <Group gap="xs" align="center" wrap="wrap">
              <Title order={3}>
                {meeting ? `#${meeting.channelName}` : "Loading meeting..."}
              </Title>
              {statusLabel ? (
                <Badge
                  color={
                    statusLabel === "Live"
                      ? "red"
                      : statusLabel === "Processing"
                        ? "yellow"
                        : "gray"
                  }
                  variant="light"
                >
                  {statusLabel}
                </Badge>
              ) : null}
            </Group>
            <Text size="sm" c="dimmed">
              {meeting
                ? `Started ${formatDateTimeLabel(meeting.startedAt)}`
                : "Connecting to live stream..."}
            </Text>
          </Stack>
        </Group>
        <Divider my="sm" />
        <LiveMeetingOutcome status={stream.status} meeting={stream.meeting} />
        <MeetingTimeline
          events={stream.events}
          activeFilters={activeFilters}
          onToggleFilter={(value) =>
            setActiveFilters((current) =>
              current.includes(value)
                ? current.filter((filter) => filter !== value)
                : [...current, value],
            )
          }
          height={520}
          title="Live transcript"
          emptyLabel={resolveTimelineEmptyLabel(stream.status)}
          headerActions={
            <>
              <Switch
                label="Auto-scroll"
                checked={autoScroll}
                onChange={(event) => setAutoScroll(event.currentTarget.checked)}
              />
              <Button
                size="xs"
                variant="subtle"
                leftSection={<IconRefresh size={14} />}
                onClick={stream.retry}
              >
                Retry
              </Button>
            </>
          }
          viewportRef={viewportRef}
        />
      </Surface>
    </Stack>
  );
}
