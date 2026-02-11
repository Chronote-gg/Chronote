import { Badge, Button, Group, Stack, Text } from "@mantine/core";
import {
  IconArchive,
  IconArchiveOff,
  IconDownload,
  IconFilter,
  IconLink,
} from "@tabler/icons-react";
import {
  MEETING_STATUS,
  type MeetingStatus,
} from "../../../../types/meetingLifecycle";
import type { MeetingDetails } from "../../../utils/meetingLibrary";
import { formatDateTimeLabel } from "../../../utils/meetingLibrary";

type MeetingDetailHeaderProps = {
  meeting: MeetingDetails;
  displayStatus: MeetingStatus;
  canManageSelectedGuild: boolean;
  endMeetingPreflightLoading: boolean;
  archivePending: boolean;
  sharePending: boolean;
  fullScreen: boolean;
  onEndMeeting: () => void;
  onDownload: () => void;
  onShare: () => void;
  onArchiveToggle: () => void;
  onToggleFullScreen: () => void;
};

export default function MeetingDetailHeader({
  meeting,
  displayStatus,
  canManageSelectedGuild,
  endMeetingPreflightLoading,
  archivePending,
  sharePending,
  fullScreen,
  onEndMeeting,
  onDownload,
  onShare,
  onArchiveToggle,
  onToggleFullScreen,
}: MeetingDetailHeaderProps) {
  return (
    <Stack gap={4}>
      <Group justify="flex-end" align="center" wrap="wrap">
        {displayStatus === MEETING_STATUS.IN_PROGRESS &&
        canManageSelectedGuild ? (
          <Button
            color="red"
            variant="light"
            loading={endMeetingPreflightLoading}
            onClick={onEndMeeting}
          >
            End meeting
          </Button>
        ) : null}
        <Button
          variant="light"
          leftSection={<IconDownload size={16} />}
          onClick={onDownload}
          data-testid="meeting-download"
        >
          Download
        </Button>
        <Button
          variant="light"
          leftSection={<IconLink size={16} />}
          onClick={onShare}
          disabled={sharePending}
          data-testid="meeting-share"
        >
          Share
        </Button>
        <Button
          variant="subtle"
          leftSection={
            meeting.archivedAt ? (
              <IconArchiveOff size={16} />
            ) : (
              <IconArchive size={16} />
            )
          }
          onClick={onArchiveToggle}
          loading={archivePending}
          data-testid={
            meeting.archivedAt ? "meeting-unarchive" : "meeting-archive"
          }
        >
          {meeting.archivedAt ? "Unarchive" : "Archive"}
        </Button>
        <Button
          variant={fullScreen ? "outline" : "light"}
          leftSection={<IconFilter size={16} />}
          onClick={onToggleFullScreen}
          data-testid="meeting-fullscreen-toggle"
        >
          {fullScreen ? "Exit fullscreen" : "Open fullscreen"}
        </Button>
      </Group>
      <Text size="sm" c="dimmed">
        {meeting.dateLabel} | {meeting.durationLabel} | {meeting.channel}
      </Text>
      {meeting.archivedAt ? (
        <Text size="xs" c="dimmed">
          Archived on {formatDateTimeLabel(meeting.archivedAt)}
        </Text>
      ) : null}
      <Group gap="xs" wrap="wrap">
        {meeting.tags.map((tag) => (
          <Badge key={tag} variant="light" color="gray">
            {tag}
          </Badge>
        ))}
      </Group>
    </Stack>
  );
}
