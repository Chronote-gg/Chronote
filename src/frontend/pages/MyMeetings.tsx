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
type SelectOption = { value: string; label: string };

const MS_PER_DAY = 1000 * 60 * 60 * 24;
const MY_MEETINGS_PAGE_SIZE = 25;
const MY_MEETINGS_MODE_OPTIONS: SelectOption[] = [
  { value: "attended", label: "Meetings I attended" },
  { value: "accessible", label: "Meetings I can access" },
];
const MY_MEETINGS_RANGE_OPTIONS: SelectOption[] = [
  { value: "all", label: "All time" },
  { value: "today", label: "Today" },
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
];
const MY_MEETINGS_ARCHIVE_OPTIONS: SelectOption[] = [
  { value: "active", label: "Active" },
  { value: "archived", label: "Archived" },
  { value: "all", label: "All" },
];

const resetThenSet = <T,>(
  resetPagination: () => void,
  setValue: (value: T) => void,
  value: T,
) => {
  resetPagination();
  setValue(value);
};

const resolveModeSelection = (value: string | null): MyMeetingsMode =>
  value === "accessible" ? "accessible" : "attended";

const resolveRangeSelection = (value: string | null): MyMeetingsRange =>
  value === "today" || value === "30" || value === "7" ? value : "all";

const resolveArchiveSelection = (value: string | null): ArchiveFilter =>
  value === "archived" || value === "all" ? value : "active";

const optionalArray = (values: string[]) =>
  values.length ? values : undefined;

const resolveArchivedOnly = (archiveFilter: ArchiveFilter) =>
  archiveFilter === "archived" ? true : undefined;

const formatLoadedMeetingsCount = (count: number, hasMore: boolean) =>
  hasMore ? `Showing ${count} loaded meetings` : `${count} meetings`;

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

const mergeLoadedMeetingPage = (
  currentPages: LoadedMeetingsPage[],
  pageCursor: string | null,
  data: MyMeetingsPageData,
) => {
  const page = { cursor: pageCursor, data };
  if (pageCursor === null) return [page];
  const existingIndex = currentPages.findIndex(
    (currentPage) => currentPage.cursor === pageCursor,
  );
  if (existingIndex < 0) return [...currentPages, page];
  return currentPages.map((currentPage, index) =>
    index === existingIndex ? page : currentPage,
  );
};

const useLoadedMeetingPages = (
  data: MyMeetingsPageData | undefined,
  pageCursor: string | null,
) => {
  const [loadedPages, setLoadedPages] = useState<LoadedMeetingsPage[]>([]);

  useEffect(() => {
    if (!data) return;
    setLoadedPages((currentPages) =>
      mergeLoadedMeetingPage(currentPages, pageCursor, data),
    );
  }, [data, pageCursor]);

  return { loadedPages, setLoadedPages };
};

const resolveLatestLoadedPage = (loadedPages: LoadedMeetingsPage[]) =>
  loadedPages[loadedPages.length - 1]?.data;

const resolveNextCursor = (latestPage?: MyMeetingsPageData) =>
  latestPage?.nextCursor ?? null;

const hasMoreLoadedMeetings = (
  latestPage: MyMeetingsPageData | undefined,
  nextCursor: string | null,
) => {
  if (!latestPage?.hasMore) return false;
  return Boolean(nextCursor);
};

const resetMyMeetingsPagination = (
  setLoadedPages: (pages: LoadedMeetingsPage[]) => void,
  setPageCursor: (cursor: string | null) => void,
) => {
  setLoadedPages([]);
  setPageCursor(null);
};

type LoadMyMeetingsPageInput = {
  isFetching: boolean;
  nextCursor: string | null;
  pageCursor: string | null;
  setPageCursor: (cursor: string | null) => void;
};

const loadMyMeetingsPage = ({
  isFetching,
  nextCursor,
  pageCursor,
  setPageCursor,
}: LoadMyMeetingsPageInput) => {
  if (!nextCursor || isFetching || nextCursor === pageCursor) return;
  setPageCursor(nextCursor);
};

type RefreshMyMeetingsInput = {
  pageCursor: string | null;
  refetch: () => unknown;
  setLoadedPages: (pages: LoadedMeetingsPage[]) => void;
  setPageCursor: (cursor: string | null) => void;
};

const refreshMyMeetings = ({
  pageCursor,
  refetch,
  setLoadedPages,
  setPageCursor,
}: RefreshMyMeetingsInput) => {
  setLoadedPages([]);
  if (pageCursor === null) {
    void refetch();
    return;
  }
  setPageCursor(null);
};

type MyMeetingsFiltersProps = {
  archiveFilter: ArchiveFilter;
  mode: MyMeetingsMode;
  onArchiveFilterChange: (value: ArchiveFilter) => void;
  onModeChange: (value: MyMeetingsMode) => void;
  onQueryChange: (value: string) => void;
  onSelectedRangeChange: (value: MyMeetingsRange) => void;
  onSelectedServersChange: (value: string[]) => void;
  onSelectedTagsChange: (value: string[]) => void;
  query: string;
  selectedRange: MyMeetingsRange;
  selectedServers: string[];
  selectedTags: string[];
  serverOptions: SelectOption[];
  tagOptions: string[];
};

function MyMeetingsFilters({
  archiveFilter,
  mode,
  onArchiveFilterChange,
  onModeChange,
  onQueryChange,
  onSelectedRangeChange,
  onSelectedServersChange,
  onSelectedTagsChange,
  query,
  selectedRange,
  selectedServers,
  selectedTags,
  serverOptions,
  tagOptions,
}: MyMeetingsFiltersProps) {
  return (
    <Surface p="lg" tone="soft">
      <SimpleGrid cols={{ base: 1, md: 3 }} spacing="md">
        <TextInput
          value={query}
          onChange={(event) => onQueryChange(event.currentTarget.value)}
          placeholder="Search my meetings"
          leftSection={<IconSearch size={16} />}
          data-testid="my-meetings-search"
        />
        <FormSelect
          value={mode}
          onChange={(value) => onModeChange(resolveModeSelection(value))}
          data-testid="my-meetings-mode"
          data={MY_MEETINGS_MODE_OPTIONS}
        />
        <FormSelect
          value={selectedRange}
          onChange={(value) =>
            onSelectedRangeChange(resolveRangeSelection(value))
          }
          data-testid="my-meetings-range"
          data={MY_MEETINGS_RANGE_OPTIONS}
        />
        <MultiSelect
          data={serverOptions}
          value={selectedServers}
          onChange={onSelectedServersChange}
          placeholder="Servers"
          searchable
          clearable
          data-testid="my-meetings-servers"
        />
        <MultiSelect
          data={tagOptions}
          value={selectedTags}
          onChange={onSelectedTagsChange}
          placeholder="Tags"
          searchable
          clearable
          data-testid="my-meetings-tags"
        />
        <FormSelect
          value={archiveFilter}
          onChange={(value) =>
            onArchiveFilterChange(resolveArchiveSelection(value))
          }
          data-testid="my-meetings-archive-filter"
          data={MY_MEETINGS_ARCHIVE_OPTIONS}
        />
      </SimpleGrid>
    </Surface>
  );
}

type MyMeetingsToolbarProps = {
  countLabel: string;
  onRefresh: () => void;
};

function MyMeetingsToolbar({ countLabel, onRefresh }: MyMeetingsToolbarProps) {
  return (
    <Group justify="space-between" align="center" wrap="wrap">
      <Text c="dimmed" size="sm">
        {countLabel}
      </Text>
      <Group gap="xs" align="center">
        <Text size="xs" c="dimmed">
          Sorted by recency
        </Text>
        <RefreshButton
          onClick={onRefresh}
          size="xs"
          variant="subtle"
          data-testid="my-meetings-refresh"
        />
      </Group>
    </Group>
  );
}

type MyMeetingsLoadMoreProps = {
  loadingMore: boolean;
  nextCursor: string | null;
  onLoadMore: () => void;
};

function MyMeetingsLoadMore({
  loadingMore,
  nextCursor,
  onLoadMore,
}: MyMeetingsLoadMoreProps) {
  return (
    <Group justify="center">
      <Button
        variant="light"
        color="brand"
        onClick={onLoadMore}
        loading={loadingMore}
        disabled={!nextCursor}
        data-testid="my-meetings-load-more"
      >
        Load more
      </Button>
    </Group>
  );
}

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
  const deferredQuery = useDeferredValue(query);

  const rangeInput = useMemo(
    () => resolveRangeInput(selectedRange),
    [selectedRange],
  );
  const meetingsQuery = trpc.meetings.myList.useQuery({
    mode,
    limit: MY_MEETINGS_PAGE_SIZE,
    cursor: pageCursor ?? undefined,
    archivedOnly: resolveArchivedOnly(archiveFilter),
    includeArchived: archiveFilter !== "active",
    serverIds: optionalArray(selectedServers),
    tags: optionalArray(selectedTags),
    ...rangeInput,
  });

  const { loadedPages, setLoadedPages } = useLoadedMeetingPages(
    meetingsQuery.data,
    pageCursor,
  );
  const latestPage = resolveLatestLoadedPage(loadedPages);
  const nextCursor = resolveNextCursor(latestPage);
  const hasMore = hasMoreLoadedMeetings(latestPage, nextCursor);
  const listLoading = meetingsQuery.isLoading && loadedPages.length === 0;
  const loadingMore = meetingsQuery.isFetching && loadedPages.length > 0;
  const resetPagination = () =>
    resetMyMeetingsPagination(setLoadedPages, setPageCursor);
  const loadMore = () =>
    loadMyMeetingsPage({
      isFetching: meetingsQuery.isFetching,
      nextCursor,
      pageCursor,
      setPageCursor,
    });
  const refreshMeetings = () =>
    refreshMyMeetings({
      pageCursor,
      refetch: meetingsQuery.refetch,
      setLoadedPages,
      setPageCursor,
    });
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
  const countLabel = formatLoadedMeetingsCount(
    filteredMeetings.length,
    hasMore,
  );
  const listFooter = hasMore ? (
    <MyMeetingsLoadMore
      loadingMore={loadingMore}
      nextCursor={nextCursor}
      onLoadMore={loadMore}
    />
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
      <MyMeetingsFilters
        archiveFilter={archiveFilter}
        mode={mode}
        onArchiveFilterChange={(value) =>
          resetThenSet(resetPagination, setArchiveFilter, value)
        }
        onModeChange={(value) => resetThenSet(resetPagination, setMode, value)}
        onQueryChange={setQuery}
        onSelectedRangeChange={(value) =>
          resetThenSet(resetPagination, setSelectedRange, value)
        }
        onSelectedServersChange={(value) =>
          resetThenSet(resetPagination, setSelectedServers, value)
        }
        onSelectedTagsChange={(value) =>
          resetThenSet(resetPagination, setSelectedTags, value)
        }
        query={query}
        selectedRange={selectedRange}
        selectedServers={selectedServers}
        selectedTags={selectedTags}
        serverOptions={serverOptions}
        tagOptions={tagOptions}
      />
      <MyMeetingsToolbar countLabel={countLabel} onRefresh={refreshMeetings} />
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
