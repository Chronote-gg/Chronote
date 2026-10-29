import { useMemo } from "react";
import type { MeetingBrowseScope } from "../../../types/meetingBrowse";
import { useAuth } from "../../contexts/AuthContext";
import { trpc } from "../../services/trpc";
import { meetingDateRangeState } from "../../utils/meetingBrowseDates";
import type { MeetingBrowseSearch } from "../../utils/meetingBrowseSearch";
import {
  deriveMeetingSummary,
  filterMeetingItems,
  formatChannelLabel,
  formatDateLabel,
  formatMeetingDurationLabel,
  formatRelativeRecencyLabel,
  resolveMeetingTitle,
} from "../../utils/meetingLibrary";
import type { MeetingListItem } from "../library/types";

export function meetingBrowseScope(
  search: MeetingBrowseSearch,
): MeetingBrowseScope {
  return search.scope === "guild" && search.serverId
    ? { kind: "guild", serverId: search.serverId }
    : search.scope === "personal"
      ? { kind: "personal" }
      : { kind: "all" };
}
function meetingBrowseRangeInput(search: MeetingBrowseSearch) {
  if (search.range === "today")
    return {
      range: "today" as const,
      timeZoneOffsetMinutes: new Date().getTimezoneOffset(),
    };
  if (search.range === "7") return { range: "past_7_days" as const };
  if (search.range === "30" || search.range === "90") {
    const now = new Date();
    return {
      range: "custom" as const,
      startDate: new Date(
        now.getTime() - Number(search.range) * 86400000,
      ).toISOString(),
      endDate: now.toISOString(),
    };
  }
  if (search.range === "custom")
    return {
      range: "custom" as const,
      startDate: search.startDate,
      endDate: search.endDate,
    };
  return { range: "all" as const };
}
function meetingBrowseQueryInput(
  search: MeetingBrowseSearch,
  scope: MeetingBrowseScope,
  rangeInput: ReturnType<typeof meetingBrowseRangeInput>,
) {
  return {
    mode: "accessible" as const,
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
  };
}
export function useMeetingBrowse(search: MeetingBrowseSearch, enabled = true) {
  const { protectedQueriesReady } = useAuth();
  const scope = meetingBrowseScope(search);
  const rangeReady = meetingDateRangeState(search) === "ready";
  const canBrowse = enabled && protectedQueriesReady && rangeReady;
  const rangeInput = useMemo(
    () => meetingBrowseRangeInput(search),
    [search.range, search.startDate, search.endDate],
  );
  const query = trpc.meetings.myList.useInfiniteQuery(
    meetingBrowseQueryInput(search, scope, rangeInput),
    {
      enabled: canBrowse,
      placeholderData: undefined,
      getNextPageParam: (page) => page.nextCursor ?? undefined,
      refetchOnWindowFocus: "always",
    },
  );
  const showResults = canBrowse && !query.error;
  // Each filter input has its own query key. Never accumulate pages outside that key.
  const rows = showResults
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
    isLoading: !protectedQueriesReady || (rangeReady && query.isLoading),
    isFetching: query.isFetching,
    error: query.error,
    hasMore: latest?.hasMore === true,
    discoveryComplete: showResults && latest?.discoveryComplete === true,
    loadMore: () => {
      if (!canBrowse || query.isFetching) return;
      if (query.error) {
        void query.refetch();
        return;
      }
      if (query.hasNextPage) void query.fetchNextPage();
    },
    refresh: () => (canBrowse ? query.refetch() : Promise.resolve(undefined)),
  };
}
