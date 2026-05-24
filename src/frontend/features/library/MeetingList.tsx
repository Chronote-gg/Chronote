import type { ReactNode } from "react";
import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Center,
  Group,
  Loader,
  Stack,
  Text,
  ThemeIcon,
} from "@mantine/core";
import {
  IconChevronRight,
  IconFilter,
  IconServer,
  IconUsers,
} from "@tabler/icons-react";
import Surface from "../../components/Surface";
import type { MeetingStatus } from "../../../types/meetingLifecycle";
import { MEETING_STATUS } from "../../../types/meetingLifecycle";
import type { MeetingListItem } from "../../pages/library/types";
import classes from "./MeetingList.module.css";

const renderListStatusBadge = (status?: MeetingStatus) => {
  switch (status) {
    case MEETING_STATUS.IN_PROGRESS:
      return (
        <Badge color="red" variant="light">
          Live
        </Badge>
      );
    case MEETING_STATUS.PROCESSING:
      return (
        <Badge color="yellow" variant="light">
          Processing
        </Badge>
      );
    default:
      return null;
  }
};

type MeetingListProps = {
  items: MeetingListItem[];
  listLoading: boolean;
  listError: boolean;
  onSelect: (meetingId: string) => void;
  selectedMeetingId: string | null;
  emptyTitle?: string;
  emptyDescription?: string;
  emptyActionLabel?: string;
  onEmptyAction?: () => void;
  emptyActionTestId?: string;
  footer?: ReactNode;
};

export function MeetingList({
  items,
  listLoading,
  listError,
  onSelect,
  selectedMeetingId,
  emptyTitle = "No meetings match these filters yet.",
  emptyDescription,
  emptyActionLabel,
  onEmptyAction,
  emptyActionTestId,
  footer,
}: MeetingListProps) {
  return (
    <Surface
      p={0}
      className={classes.list}
      style={{ position: "relative" }}
      data-testid="library-list"
    >
      {listLoading ? (
        <Center
          py="xl"
          style={{ minHeight: 240 }}
          data-testid="library-loading"
        >
          <Loader color="brand" />
        </Center>
      ) : listError ? (
        <Center py="xl">
          <Text c="dimmed">Unable to load meetings. Try again shortly.</Text>
        </Center>
      ) : items.length === 0 ? (
        <Center py="xl">
          <Stack gap="xs" align="center">
            <ThemeIcon variant="light" color="gray">
              <IconFilter size={16} />
            </ThemeIcon>
            <Text c="dimmed">{emptyTitle}</Text>
            {emptyDescription ? (
              <Text c="dimmed" size="sm" ta="center">
                {emptyDescription}
              </Text>
            ) : null}
            {emptyActionLabel && onEmptyAction ? (
              <Button
                variant="light"
                color="brand"
                size="sm"
                onClick={onEmptyAction}
                data-testid={emptyActionTestId}
              >
                {emptyActionLabel}
              </Button>
            ) : null}
          </Stack>
        </Center>
      ) : (
        <Stack gap={0}>
          {items.map((meetingItem) => (
            <Box
              key={meetingItem.id}
              px={{ base: "md", md: "lg" }}
              py="md"
              onClick={() => onSelect(meetingItem.id)}
              className={classes.row}
              data-selected={selectedMeetingId === meetingItem.id}
              data-testid="library-meeting-row"
              data-meeting-id={meetingItem.id}
            >
              <Group justify="space-between" align="flex-start" wrap="nowrap">
                <Stack gap="xs" style={{ flex: 1, minWidth: 0 }}>
                  <Group gap="xs" align="center">
                    <Text fw={600} truncate>
                      {meetingItem.title}
                    </Text>
                    {meetingItem.archivedAt ? (
                      <Badge size="xs" variant="light" color="gray">
                        Archived
                      </Badge>
                    ) : null}
                    {renderListStatusBadge(meetingItem.status)}
                  </Group>
                  <Text size="xs" c="dimmed">
                    {meetingItem.summary || "No summary yet."}
                  </Text>
                  <Group gap="md" align="center" mt={2}>
                    <Group gap={4} align="center">
                      {meetingItem.recencyLabel ? (
                        <Badge size="xs" variant="light" color="brand">
                          {meetingItem.recencyLabel}
                        </Badge>
                      ) : null}
                      <Text size="xs" c="dimmed">
                        {meetingItem.dateLabel} | {meetingItem.durationLabel}
                      </Text>
                    </Group>
                    <Group gap={4} align="center">
                      <IconUsers size={14} />
                      <Text size="xs" c="dimmed">
                        {meetingItem.channelLabel}
                      </Text>
                    </Group>
                    {meetingItem.serverName ? (
                      <Group gap={4} align="center">
                        <IconServer size={14} />
                        <Text size="xs" c="dimmed">
                          {meetingItem.serverName}
                        </Text>
                      </Group>
                    ) : null}
                    {meetingItem.tags.length ? (
                      <Text size="xs" c="dimmed">
                        Tags: {meetingItem.tags.join(", ")}
                      </Text>
                    ) : null}
                  </Group>
                </Stack>
                <ActionIcon
                  variant="subtle"
                  aria-label="Open details"
                  className={classes.chevron}
                >
                  <IconChevronRight size={16} />
                </ActionIcon>
              </Group>
            </Box>
          ))}
          {footer ? (
            <Box px={{ base: "md", md: "lg" }} py="md">
              {footer}
            </Box>
          ) : null}
        </Stack>
      )}
    </Surface>
  );
}
