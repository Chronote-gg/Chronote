import { useMemo } from "react";
import { trpc } from "../../services/trpc";
import { useAuth } from "../../contexts/AuthContext";
import type { MeetingBrowseScope } from "../../../types/meetingBrowse";
import type { MeetingBrowseSearch } from "../../utils/meetingBrowseSearch";
import type { MeetingListItem } from "../library/types";
import {
  deriveMeetingSummary,
  filterMeetingItems,
  formatChannelLabel,
  formatDateLabel,
  formatMeetingDurationLabel,
  formatRelativeRecencyLabel,
  resolveMeetingTitle,
} from "../../utils/meetingLibrary";

export function meetingBrowseScope(
  search: MeetingBrowseSearch,
): MeetingBrowseScope {
  return search.scope === "guild" && search.serverId
    ? { kind: "guild", serverId: search.serverId }
    : search.scope === "personal"
      ? { kind: "personal" }
      : { kind: "all" };
}
export function useMeetingBrowse(search: MeetingBrowseSearch, enabled = true) {
  const { protectedQueriesReady } = useAuth();
  const scope = meetingBrowseScope(search);
  const rangeInput = useMemo(() => {
    if (search.range === "today")
      return {
        range: "today" as const,
        timeZoneOffsetMinutes: new Date().getTimezoneOffset(),
      };
    if (search.range === "7") return { range: "past_7_days" as const };
    if (search.range === "30") {
      const now = new Date();
      return {
        range: "custom" as const,
        startDate: new Date(now.getTime() - 30 * 86400000).toISOString(),
        endDate: now.toISOString(),
      };
    }
    if (search.range === "custom" && search.startDate && search.endDate)
      return {
        range: "custom" as const,
        startDate: search.startDate,
        endDate: search.endDate,
      };
    return { range: "all" as const };
  }, [search.range, search.startDate, search.endDate]);
  const query = trpc.meetings.myList.useInfiniteQuery(
    {
      mode: "accessible",
      limit: 25,
      ...rangeInput,
      browse: {
        scope,
        attendedOnly: search.attended,
        channelId: search.channelId,
      },
      tags: search.tags
        ? [
            ...new Set(
              search.tags
                .split(",")
                .map((tag) => tag.trim())
                .filter(Boolean),
            ),
          ].sort()
        : undefined,
      archivedOnly: search.archive === "archived" ? true : undefined,
      includeArchived: search.archive !== "active",
    },
    {
      enabled: enabled && protectedQueriesReady,
      placeholderData: undefined,
      getNextPageParam: (page) => page.nextCursor ?? undefined,
      refetchOnWindowFocus: "always",
    },
  );
  // Each filter input has its own query key. Never accumulate pages outside that key.
  const rows =
    enabled && protectedQueriesReady && !query.error
      ? (query.data?.pages.flatMap((page) => page.meetings) ?? [])
      : [];
  const items: MeetingListItem[] = rows.map((row) => {
    const meeting = { ...row, notes: "" };
    const channelLabel = formatChannelLabel(row.channelName, row.channelId);
    return {
      ...meeting,
      channelLabel,
      title: resolveMeetingTitle({ ...row, channelLabel }),
      summary: deriveMeetingSummary(meeting),
      dateLabel: formatDateLabel(row.timestamp),
      durationLabel: formatMeetingDurationLabel(meeting),
      recencyLabel: formatRelativeRecencyLabel(row.timestamp),
    };
  });
  const latest = query.data?.pages[query.data.pages.length - 1];
  return {
    scope,
    rows,
    items: filterMeetingItems(items, {
      query: search.q ?? "",
      selectedTags: [],
      selectedChannel: null,
      selectedRange: "all",
    }),
    isLoading: !protectedQueriesReady || query.isLoading,
    isFetching: query.isFetching,
    error: query.error,
    hasMore: latest?.hasMore === true,
    discoveryComplete:
      enabled &&
      protectedQueriesReady &&
      !query.error &&
      latest?.discoveryComplete === true,
    loadMore: () => {
      if (query.isFetching) return;
      if (query.error) {
        void query.refetch();
        return;
      }
      if (query.hasNextPage) void query.fetchNextPage();
    },
    refresh: () => query.refetch(),
  };
}
