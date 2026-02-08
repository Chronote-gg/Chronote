import type {
  ComponentType,
  HTMLAttributes,
  ReactNode,
  RefObject,
} from "react";
import {
  Box,
  Button,
  Center,
  Group,
  ScrollArea,
  Stack,
  Text,
  ThemeIcon,
  useComputedColorScheme,
  useMantineTheme,
} from "@mantine/core";
import {
  IconFilter,
  IconMessageCircle,
  IconMicrophone,
  IconSpeakerphone,
  IconSparkles,
  IconUsers,
} from "@tabler/icons-react";
import type {
  MeetingEvent,
  MeetingEventType,
} from "../../types/meetingTimeline";
import { uiSpacing } from "../uiTokens";

export const MEETING_TIMELINE_FILTERS: Array<{
  value: MeetingEventType;
  label: string;
}> = [
  { value: "voice", label: "Voice" },
  { value: "chat", label: "Chat" },
  { value: "tts", label: "Spoken chat" },
  { value: "presence", label: "Joins/Leaves" },
  { value: "bot", label: "Bot" },
];

const EVENT_META: Record<
  MeetingEventType,
  {
    color: string;
    label: string;
    icon: ComponentType<{ size?: number }>;
  }
> = {
  voice: { color: "brand", label: "Voice", icon: IconMicrophone },
  chat: { color: "cyan", label: "Chat", icon: IconMessageCircle },
  tts: { color: "teal", label: "Spoken chat", icon: IconSpeakerphone },
  presence: { color: "gray", label: "Join/leave", icon: IconUsers },
  bot: { color: "violet", label: "Chronote", icon: IconSparkles },
};

type MeetingTimelineProps = {
  events: MeetingEvent[];
  activeFilters: MeetingEventType[];
  onToggleFilter?: (filter: MeetingEventType) => void;
  height: number | string;
  emptyLabel: string;
  title?: string;
  headerActions?: ReactNode;
  showFilters?: boolean;
  viewportRef?: RefObject<HTMLDivElement | null>;
  viewportProps?: HTMLAttributes<HTMLDivElement>;
};

export default function MeetingTimeline({
  events,
  activeFilters,
  onToggleFilter,
  height,
  emptyLabel,
  title = "Timeline",
  headerActions,
  showFilters = true,
  viewportRef,
  viewportProps,
}: MeetingTimelineProps) {
  const theme = useMantineTheme();
  const scheme = useComputedColorScheme("dark");
  const isDark = scheme === "dark";
  const isFillHeight = height === "100%";
  const toggleFilter = onToggleFilter ?? (() => {});
  const visibleEvents = showFilters
    ? events.filter((event) => activeFilters.includes(event.type))
    : events;

  const scrollAreaProps = isFillHeight
    ? { style: { flex: 1, minHeight: 0 } }
    : { h: height };

  return (
    <Stack
      gap="sm"
      style={
        isFillHeight ? { minHeight: 0, flex: 1, height: "100%" } : undefined
      }
    >
      <Group justify="space-between" align="center" wrap="wrap">
        <Group gap="sm">
          <ThemeIcon variant="light" color="brand">
            <IconFilter size={16} />
          </ThemeIcon>
          <Text fw={600}>{title}</Text>
        </Group>
        <Group gap="xs" align="center" wrap="wrap">
          {headerActions}
          {showFilters
            ? MEETING_TIMELINE_FILTERS.map((filter) => {
                const isActive = activeFilters.includes(filter.value);
                return (
                  <Button
                    key={filter.value}
                    size="xs"
                    variant={isActive ? "light" : "subtle"}
                    color={isActive ? "cyan" : "gray"}
                    onClick={() => toggleFilter(filter.value)}
                  >
                    {filter.label}
                  </Button>
                );
              })
            : null}
        </Group>
      </Group>
      <ScrollArea
        {...scrollAreaProps}
        type="always"
        offsetScrollbars
        scrollbarSize={10}
        viewportRef={viewportRef}
        viewportProps={viewportProps}
        data-visual-scroll
        styles={{
          viewport: {
            paddingRight: `var(--mantine-spacing-${uiSpacing.scrollAreaGutter})`,
          },
        }}
      >
        {visibleEvents.length === 0 ? (
          <Center py="xl">
            <Text size="sm" c="dimmed">
              {emptyLabel}
            </Text>
          </Center>
        ) : (
          <Stack gap={0}>
            {visibleEvents.map((event, index) => {
              const safeId = event.id.replace(/[^\w-]/g, "");
              const anchorId = `timeline-${safeId || index}`;
              const meta = EVENT_META[event.type];
              const Icon = meta.icon;
              const showMetaLabel = Boolean(event.speaker);
              return (
                <Box
                  key={event.id}
                  id={anchorId}
                  data-event-id={event.id}
                  data-timeline-anchor={anchorId}
                  px="sm"
                  py="sm"
                  style={{
                    borderBottom: `1px solid ${
                      isDark ? theme.colors.dark[5] : theme.colors.gray[2]
                    }`,
                  }}
                >
                  <Group gap="sm" align="flex-start" wrap="nowrap">
                    <ThemeIcon variant="light" color={meta.color} size={32}>
                      <Icon size={16} />
                    </ThemeIcon>
                    <Stack gap={4} style={{ flex: 1, minWidth: 0 }}>
                      <Group gap="xs" align="baseline" wrap="wrap">
                        <Text fw={700} size="sm">
                          {event.speaker ?? meta.label}
                        </Text>
                        <Text size="xs" c="dimmed">
                          {event.time}
                        </Text>
                        {showMetaLabel ? (
                          <Text size="xs" c="dimmed">
                            • {meta.label}
                          </Text>
                        ) : null}
                      </Group>
                      <Text size="sm" c="dimmed">
                        {event.text}
                      </Text>
                    </Stack>
                  </Group>
                </Box>
              );
            })}
          </Stack>
        )}
      </ScrollArea>
    </Stack>
  );
}
