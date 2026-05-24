import { useDeferredValue, useEffect, useMemo, useState } from "react";
import {
  Button,
  Group,
  MultiSelect,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { IconSearch } from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";
import PageHeader from "../components/PageHeader";
import FormSelect from "../components/FormSelect";
import { RefreshButton } from "../components/RefreshButton";
import Surface from "../components/Surface";
import { MeetingList } from "../features/library/MeetingList";
import { useGuildContext } from "../contexts/GuildContext";
import { trpc } from "../services/trpc";
import {
  deriveSummary,
  filterMeetingItems,
  formatChannelLabel,
  formatDateLabel,
  formatDurationLabel,
  formatRelativeRecencyLabel,
  resolveMeetingTitle,
} from "../utils/meetingLibrary";
import type {
  ArchiveFilter,
  MeetingListItem,
  MeetingSummaryRow,
} from "./library/types";

type MyMeetingsMode = "attended" | "accessible";
type MyMeetingsRange = "all" | "today" | "7" | "30";
type MyMeetingsRangeInput =
  | { range: "all" }
  | { range: "today"; timeZoneOffsetMinutes: number }
  | { range: "custom"; startDate: string; endDate: string }
  | { range: "past_7_days" };
type MyMeetingsApiRow = Omit<
  MeetingSummaryRow,
  "notes" | "notesChannelId" | "notesMessageId"
> & {
  notes?: string;
  notesChannelId?: string;
  notesMessageId?: string;
  notesAvailable?: boolean;
};
type MyMeetingsPageData = {
  meetings: MyMeetingsApiRow[];
  hasMore?: boolean;
  nextCursor?: string | null;
};
type LoadedMeetingsPage = {
  cursor: string | null;
  data: MyMeetingsPageData;
};

const MS_PER_DAY = 1000 * 60 * 60 * 24;
const MY_MEETINGS_PAGE_SIZE = 25;

const resolveRangeInput = (range: MyMeetingsRange): MyMeetingsRangeInput => {
  const now = new Date();
  if (range === "all") return { range: "all" };
  if (range === "today") {
    return {
      range: "today",
      timeZoneOffsetMinutes: now.getTimezoneOffset(),
    };
  }
  if (range === "30") {
    return {
      range: "custom",
      startDate: new Date(now.getTime() - 30 * MS_PER_DAY).toISOString(),
      endDate: now.toISOString(),
    };
  }
  return { range: "past_7_days" };
};

const archiveMatches = (
  meeting: MeetingListItem,
  archiveFilter: ArchiveFilter,
) => {
  if (archiveFilter === "archived") return Boolean(meeting.archivedAt);
  if (archiveFilter === "all") return true;
  return !meeting.archivedAt;
};

const toMeetingRows = (meetings: MyMeetingsApiRow[]): MeetingSummaryRow[] =>
  meetings.map((meeting) => ({
    ...meeting,
    notes: "",
    audioAvailable: meeting.audioAvailable,
    transcriptAvailable: meeting.transcriptAvailable,
  }));

const toMeetingItems = (meetingRows: MeetingSummaryRow[]): MeetingListItem[] =>
  meetingRows.map((meetingRow) => {
    const channelLabel = formatChannelLabel(
      meetingRow.channelName,
      meetingRow.channelId,
    );
    return {
      ...meetingRow,
      title: resolveMeetingTitle({
        meetingName: meetingRow.meetingName,
        summaryLabel: meetingRow.summaryLabel,
        summarySentence: meetingRow.summarySentence,
        channelLabel,
      }),
      summary: deriveSummary(meetingRow.notes, meetingRow.summarySentence),
      dateLabel: formatDateLabel(meetingRow.timestamp),
      recencyLabel: formatRelativeRecencyLabel(meetingRow.timestamp),
      durationLabel: formatDurationLabel(meetingRow.duration),
      channelLabel,
    };
  });

export default function MyMeetings() {
  const navigate = useNavigate({ from: "/portal/meetings" });
  const { guilds } = useGuildContext();
  const [mode, setMode] = useState<MyMeetingsMode>("attended");
  const [selectedRange, setSelectedRange] = useState<MyMeetingsRange>("all");
  const [archiveFilter, setArchiveFilter] = useState<ArchiveFilter>("active");
  const [selectedServers, setSelectedServers] = useState<string[]>([]);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [pageCursor, setPageCursor] = useState<string | null>(null);
  const [loadedPages, setLoadedPages] = useState<LoadedMeetingsPage[]>([]);
  const deferredQuery = useDeferredValue(query);

  const rangeInput = useMemo(
    () => resolveRangeInput(selectedRange),
    [selectedRange],
  );
  const meetingsQuery = trpc.meetings.myList.useQuery({
    mode,
    limit: MY_MEETINGS_PAGE_SIZE,
    cursor: pageCursor ?? undefined,
    archivedOnly: archiveFilter === "archived" ? true : undefined,
    includeArchived: archiveFilter !== "active",
    serverIds: selectedServers.length ? selectedServers : undefined,
    tags: selectedTags.length ? selectedTags : undefined,
    ...rangeInput,
  });

  useEffect(() => {
    if (!meetingsQuery.data) return;
    setLoadedPages((currentPages) => {
      const page = { cursor: pageCursor, data: meetingsQuery.data };
      if (pageCursor === null) return [page];
      const existingIndex = currentPages.findIndex(
        (currentPage) => currentPage.cursor === pageCursor,
      );
      if (existingIndex < 0) return [...currentPages, page];
      return currentPages.map((currentPage, index) =>
        index === existingIndex ? page : currentPage,
      );
    });
  }, [meetingsQuery.data, pageCursor]);

  const resetPagination = () => {
    setLoadedPages([]);
    setPageCursor(null);
  };

  const latestPage = loadedPages[loadedPages.length - 1]?.data;
  const nextCursor = latestPage?.nextCursor ?? null;
  const hasMore = Boolean(latestPage?.hasMore && nextCursor);
  const loadMore = () => {
    if (!nextCursor || meetingsQuery.isFetching || nextCursor === pageCursor) {
      return;
    }
    setPageCursor(nextCursor);
  };

  const refreshMeetings = () => {
    setLoadedPages([]);
    if (pageCursor === null) {
      void meetingsQuery.refetch();
      return;
    }
    setPageCursor(null);
  };

  const loadedMeetings = useMemo(
    () => loadedPages.flatMap((page) => page.data.meetings),
    [loadedPages],
  );

  const meetingRows = useMemo(
    () => toMeetingRows(loadedMeetings),
    [loadedMeetings],
  );
  const meetingItems = useMemo(
    () => toMeetingItems(meetingRows),
    [meetingRows],
  );
  const filteredMeetings = useMemo(
    () =>
      filterMeetingItems(
        meetingItems.filter((meeting) =>
          archiveMatches(meeting, archiveFilter),
        ),
        {
          query: deferredQuery,
          selectedTags,
          selectedChannel: null,
          selectedRange: "all",
        },
      ),
    [archiveFilter, deferredQuery, meetingItems, selectedTags],
  );
  const tagOptions = useMemo(
    () =>
      Array.from(
        new Set(meetingRows.flatMap((meeting) => meeting.tags)),
      ).sort(),
    [meetingRows],
  );
  const serverOptions = useMemo(
    () => guilds.map((guild) => ({ value: guild.id, label: guild.name })),
    [guilds],
  );
  const listLoading = meetingsQuery.isLoading && loadedPages.length === 0;
  const loadingMore = meetingsQuery.isFetching && loadedPages.length > 0;
  const countLabel = hasMore
    ? `Showing ${filteredMeetings.length} loaded meetings`
    : `${filteredMeetings.length} meetings`;
  const listFooter = hasMore ? (
    <Group justify="center">
      <Button
        variant="light"
        color="brand"
        onClick={loadMore}
        loading={loadingMore}
        disabled={!nextCursor}
        data-testid="my-meetings-load-more"
      >
        Load more
      </Button>
    </Group>
  ) : null;

  const openMeeting = (meetingId: string) => {
    const meeting = filteredMeetings.find((item) => item.id === meetingId);
    if (!meeting?.serverId) return;
    navigate({
      to: "/portal/meetings/$serverId/$meetingId",
      params: { serverId: meeting.serverId, meetingId: meeting.id },
    });
  };
  const openServerSelect = () => {
    navigate({ to: "/portal/select-server" });
  };

  return (
    <Stack gap="lg" data-testid="my-meetings-page">
      <PageHeader
        title="My Meetings"
        description="Meetings across every server you can access, sorted by recency."
      />
      <Surface p="lg" tone="soft">
        <SimpleGrid cols={{ base: 1, md: 3 }} spacing="md">
          <TextInput
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Search my meetings"
            leftSection={<IconSearch size={16} />}
            data-testid="my-meetings-search"
          />
          <FormSelect
            value={mode}
            onChange={(value) => {
              resetPagination();
              setMode(value === "accessible" ? value : "attended");
            }}
            data-testid="my-meetings-mode"
            data={[
              { value: "attended", label: "Meetings I attended" },
              { value: "accessible", label: "Meetings I can access" },
            ]}
          />
          <FormSelect
            value={selectedRange}
            onChange={(value) => {
              resetPagination();
              setSelectedRange(
                value === "today" || value === "30" || value === "7"
                  ? value
                  : "all",
              );
            }}
            data-testid="my-meetings-range"
            data={[
              { value: "all", label: "All time" },
              { value: "today", label: "Today" },
              { value: "7", label: "Last 7 days" },
              { value: "30", label: "Last 30 days" },
            ]}
          />
          <MultiSelect
            data={serverOptions}
            value={selectedServers}
            onChange={(value) => {
              resetPagination();
              setSelectedServers(value);
            }}
            placeholder="Servers"
            searchable
            clearable
            data-testid="my-meetings-servers"
          />
          <MultiSelect
            data={tagOptions}
            value={selectedTags}
            onChange={(value) => {
              resetPagination();
              setSelectedTags(value);
            }}
            placeholder="Tags"
            searchable
            clearable
            data-testid="my-meetings-tags"
          />
          <FormSelect
            value={archiveFilter}
            onChange={(value) => {
              resetPagination();
              setArchiveFilter(
                value === "archived" || value === "all" ? value : "active",
              );
            }}
            data-testid="my-meetings-archive-filter"
            data={[
              { value: "active", label: "Active" },
              { value: "archived", label: "Archived" },
              { value: "all", label: "All" },
            ]}
          />
        </SimpleGrid>
      </Surface>
      <Group justify="space-between" align="center" wrap="wrap">
        <Text c="dimmed" size="sm">
          {countLabel}
        </Text>
        <Group gap="xs" align="center">
          <Text size="xs" c="dimmed">
            Sorted by recency
          </Text>
          <RefreshButton
            onClick={refreshMeetings}
            size="xs"
            variant="subtle"
            data-testid="my-meetings-refresh"
          />
        </Group>
      </Group>
      <MeetingList
        items={filteredMeetings}
        listLoading={listLoading}
        listError={Boolean(meetingsQuery.error) && loadedPages.length === 0}
        onSelect={openMeeting}
        selectedMeetingId={null}
        emptyTitle="No meetings found here yet."
        emptyDescription="Choose a server to browse its Library, Ask threads, billing, and settings."
        emptyActionLabel="View servers"
        onEmptyAction={openServerSelect}
        emptyActionTestId="my-meetings-view-servers"
        footer={listFooter}
      />
    </Stack>
  );
}
