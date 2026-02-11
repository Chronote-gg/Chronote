import { useEffect, useState } from "react";
import {
  AppShell,
  Box,
  Container,
  LoadingOverlay,
  Stack,
  Text,
  useComputedColorScheme,
  useMantineTheme,
} from "@mantine/core";
import type { MantineTheme } from "@mantine/core";
import PageHeader from "../../components/PageHeader";
import AuthBanner from "../../components/AuthBanner";
import SiteFooter from "../../components/SiteFooter";
import SiteHeader from "../../components/SiteHeader";
import Surface from "../../components/Surface";
import MeetingTimeline, {
  MEETING_TIMELINE_FILTERS,
} from "../../components/MeetingTimeline";
import MarkdownBody from "../../components/MarkdownBody";
import { useVisualMode } from "../../hooks/useVisualMode";
import { useSharePageMeta } from "../../hooks/useSharePageMeta";
import type {
  MeetingEvent,
  MeetingEventType,
} from "../../../types/meetingTimeline";
import {
  appBackground,
  pagePaddingX,
  portalBackground,
  shellBorder,
  shellHeaderBackground,
  shellHeights,
  shellShadow,
  uiOverlays,
} from "../../uiTokens";

type PublicMeeting = {
  title: string;
  summarySentence?: string;
  summaryLabel?: string;
  timestamp: string;
  duration: number;
  tags: string[];
  notes: string;
  transcript: string;
  archivedAt?: string;
  attendees: string[];
  events: MeetingEvent[];
};

type PublicMeetingViewProps = {
  meeting: PublicMeeting | null;
  share: { sharedByTag?: string; visibility: "server" | "public" } | null;
  isLoading: boolean;
  hasError: boolean;
  needsAuthHint: boolean;
};

const buildHeaderStyles = (
  theme: MantineTheme,
  isDark: boolean,
  visualMode: boolean,
) =>
  visualMode
    ? {
        borderBottom: shellBorder(theme, isDark),
        backgroundColor: shellHeaderBackground(isDark),
        backdropFilter: "blur(16px)",
        boxShadow: shellShadow(isDark),
        position: "static" as const,
      }
    : {
        borderBottom: shellBorder(theme, isDark),
        backgroundColor: shellHeaderBackground(isDark),
        backdropFilter: "blur(16px)",
        boxShadow: shellShadow(isDark),
      };

const buildMainStyles = (
  theme: MantineTheme,
  isDark: boolean,
  visualMode: boolean,
) =>
  visualMode
    ? {
        backgroundColor: appBackground(theme, isDark),
        paddingTop: 0,
        paddingBottom: 0,
        paddingInlineStart: 0,
        paddingInlineEnd: 0,
        minHeight: "auto",
        height: "auto",
        overflow: "visible",
      }
    : {
        backgroundColor: appBackground(theme, isDark),
      };

const formatDuration = (seconds: number) => {
  const safe = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safe / 60);
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours > 0) {
    return `${hours}h ${remainingMinutes}m`;
  }
  return `${minutes}m`;
};

export function PublicMeetingView({
  meeting,
  share,
  isLoading,
  hasError,
  needsAuthHint,
}: PublicMeetingViewProps) {
  const theme = useMantineTheme();
  const colorScheme = useComputedColorScheme("dark");
  const isDark = colorScheme === "dark";
  const visualMode = useVisualMode();

  useSharePageMeta();

  const [activeFilters, setActiveFilters] = useState<MeetingEventType[]>(
    MEETING_TIMELINE_FILTERS.map((filter) => filter.value),
  );

  const headerStyles = buildHeaderStyles(theme, isDark, visualMode);
  const mainStyles = buildMainStyles(theme, isDark, visualMode);
  const pageTitle = meeting?.title ?? "Shared meeting";

  useEffect(() => {
    // Always show all filters on load.
    setActiveFilters(MEETING_TIMELINE_FILTERS.map((filter) => filter.value));
  }, [meeting?.title]);

  const body = isLoading ? (
    <Text size="sm" c="dimmed">
      Loading shared meeting...
    </Text>
  ) : hasError || !meeting ? (
    <Stack gap="sm">
      <Text size="sm" c="dimmed">
        This shared meeting is unavailable.
      </Text>
      {needsAuthHint ? (
        <AuthBanner message="Connect Discord to view this meeting if it is shared server-only." />
      ) : null}
    </Stack>
  ) : (
    <Stack gap="lg">
      <PageHeader
        title={pageTitle}
        description={`${new Date(meeting.timestamp).toLocaleString()} | ${formatDuration(
          meeting.duration,
        )}`}
      />

      <AuthBanner message="Connect Discord to browse your own meeting library." />
      {share?.sharedByTag ? (
        <Text size="sm" c="dimmed">
          Shared by {share.sharedByTag}
        </Text>
      ) : null}

      <Surface p="lg">
        <Stack gap="xs">
          <Text fw={600}>Notes</Text>
          <MarkdownBody content={meeting.notes} />
        </Stack>
      </Surface>

      <Surface p="lg">
        <Stack gap="xs">
          <Text fw={600}>Transcript</Text>
          <MeetingTimeline
            events={meeting.events}
            activeFilters={activeFilters}
            onToggleFilter={(value) =>
              setActiveFilters((current: MeetingEventType[]) =>
                current.includes(value)
                  ? current.filter(
                      (filter: MeetingEventType) => filter !== value,
                    )
                  : [...current, value],
              )
            }
            height={520}
            title="Timeline"
            emptyLabel="Transcript is empty."
          />
        </Stack>
      </Surface>

      <Surface p="lg">
        <Stack gap="xs">
          <Text fw={600}>Attendees</Text>
          <Text size="sm" c="dimmed">
            {meeting.attendees.join(", ")}
          </Text>
        </Stack>
      </Surface>
    </Stack>
  );

  return (
    <AppShell
      padding={0}
      header={{ height: shellHeights.header }}
      style={{
        minHeight: visualMode ? "100vh" : undefined,
        height: visualMode ? "auto" : undefined,
        overflow: visualMode ? "visible" : undefined,
      }}
      styles={{
        header: headerStyles,
        main: mainStyles,
      }}
    >
      <AppShell.Header p="md">
        <SiteHeader
          showNavbarToggle={false}
          navbarOpened={false}
          onNavbarToggle={() => {}}
          context="marketing"
        />
      </AppShell.Header>
      <AppShell.Main>
        <Box
          py={{ base: "xl", md: "xl" }}
          style={{ backgroundImage: portalBackground(isDark) }}
        >
          <Container size="md" px={pagePaddingX}>
            <Surface
              p="lg"
              style={{ position: "relative", overflow: "hidden" }}
            >
              <LoadingOverlay
                visible={isLoading}
                overlayProps={uiOverlays.loading}
                loaderProps={{ size: "md" }}
              />
              {body}
            </Surface>
          </Container>
          <SiteFooter />
        </Box>
      </AppShell.Main>
    </AppShell>
  );
}

export type { PublicMeetingViewProps };
