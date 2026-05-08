import { useDeferredValue, useMemo, useState } from "react";
import {
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
  resolveMeetingTitle,
} from "../utils/meetingLibrary";
import type {
  ArchiveFilter,
  MeetingListItem,
  MeetingSummaryRow,
} from "./library/types";

type MyMeetingsMode = "attended" | "accessible";
type MyMeetingsRange = "today" | "7" | "30";
type MyMeetingsRangeInput =
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

const MS_PER_DAY = 1000 * 60 * 60 * 24;

const resolveRangeInput = (range: MyMeetingsRange): MyMeetingsRangeInput => {
  const now = new Date();
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
      durationLabel: formatDurationLabel(meetingRow.duration),
      channelLabel,
    };
  });

export default function MyMeetings() {
  const navigate = useNavigate({ from: "/portal/meetings" });
  const { guilds } = useGuildContext();
  const [mode, setMode] = useState<MyMeetingsMode>("attended");
  const [selectedRange, setSelectedRange] = useState<MyMeetingsRange>("7");
  const [archiveFilter, setArchiveFilter] = useState<ArchiveFilter>("active");
  const [selectedServers, setSelectedServers] = useState<string[]>([]);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);

  const rangeInput = useMemo(
    () => resolveRangeInput(selectedRange),
    [selectedRange],
  );
  const meetingsQuery = trpc.meetings.myList.useQuery({
    mode,
    limit: 100,
    includeArchived: archiveFilter !== "active",
    serverIds: selectedServers.length ? selectedServers : undefined,
    ...rangeInput,
  });

  const meetingRows = useMemo(
    () => toMeetingRows(meetingsQuery.data?.meetings ?? []),
    [meetingsQuery.data],
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

  const openMeeting = (meetingId: string) => {
    const meeting = filteredMeetings.find((item) => item.id === meetingId);
    if (!meeting?.serverId) return;
    navigate({
      to: "/portal/server/$serverId/library",
      params: { serverId: meeting.serverId },
      search: { meetingId: meeting.id },
    });
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
            onChange={(value) =>
              setMode(value === "accessible" ? value : "attended")
            }
            data-testid="my-meetings-mode"
            data={[
              { value: "attended", label: "Meetings I attended" },
              { value: "accessible", label: "Meetings I can access" },
            ]}
          />
          <FormSelect
            value={selectedRange}
            onChange={(value) =>
              setSelectedRange(
                value === "today" || value === "30" ? value : "7",
              )
            }
            data-testid="my-meetings-range"
            data={[
              { value: "today", label: "Today" },
              { value: "7", label: "Last 7 days" },
              { value: "30", label: "Last 30 days" },
            ]}
          />
          <MultiSelect
            data={serverOptions}
            value={selectedServers}
            onChange={setSelectedServers}
            placeholder="Servers"
            searchable
            clearable
            data-testid="my-meetings-servers"
          />
          <MultiSelect
            data={tagOptions}
            value={selectedTags}
            onChange={setSelectedTags}
            placeholder="Tags"
            searchable
            clearable
            data-testid="my-meetings-tags"
          />
          <FormSelect
            value={archiveFilter}
            onChange={(value) =>
              setArchiveFilter(
                value === "archived" || value === "all" ? value : "active",
              )
            }
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
          {filteredMeetings.length} meetings
        </Text>
        <Group gap="xs" align="center">
          <Text size="xs" c="dimmed">
            Sorted by recency
          </Text>
          <RefreshButton
            onClick={() => meetingsQuery.refetch()}
            size="xs"
            variant="subtle"
            data-testid="my-meetings-refresh"
          />
        </Group>
      </Group>
      <MeetingList
        items={filteredMeetings}
        listLoading={meetingsQuery.isLoading}
        listError={Boolean(meetingsQuery.error)}
        onSelect={openMeeting}
        selectedMeetingId={null}
      />
    </Stack>
  );
}
