import { useCallback, useMemo } from "react";
import { trpc } from "../../../services/trpc";
import { useInvalidateMeetingLists } from "../../../hooks/useInvalidateMeetingLists";
import {
  deriveSummary,
  filterMeetingItems,
  formatChannelLabel,
  formatDateLabel,
  formatDurationLabel,
  resolveMeetingTitle,
} from "../../../utils/meetingLibrary";
import { resolveNowMs } from "../../../utils/now";
import type {
  ArchiveFilter,
  MeetingListItem,
  MeetingSummaryRow,
} from "../types";

type UseLibraryMeetingsParams = {
  selectedGuildId: string | null;
  archiveFilter: ArchiveFilter;
  query: string;
  selectedTags: string[];
  selectedChannel: string | null;
  selectedRange: string;
};

type UseLibraryMeetingsResult = {
  filteredMeetings: MeetingListItem[];
  tagOptions: string[];
  channelOptions: Array<{ value: string; label: string }>;
  channelNameMap: Map<string, string>;
  listLoading: boolean;
  listError: boolean;
  invalidateMeetingLists: () => Promise<void>;
  handleRefresh: () => Promise<void>;
};

export const useLibraryMeetings = (
  params: UseLibraryMeetingsParams,
): UseLibraryMeetingsResult => {
  const trpcUtils = trpc.useUtils();
  const meetingsQuery = trpc.meetings.list.useQuery(
    {
      serverId: params.selectedGuildId ?? "",
      limit: 50,
      archivedOnly: params.archiveFilter === "archived",
      includeArchived: params.archiveFilter === "all",
    },
    { enabled: Boolean(params.selectedGuildId) },
  );

  const meetingRows = useMemo<MeetingSummaryRow[]>(
    () => meetingsQuery.data?.meetings ?? [],
    [meetingsQuery.data],
  );

  const channelNameMap = useMemo(() => {
    const map = new Map<string, string>();
    meetingRows.forEach((meeting) => {
      if (!meeting.channelId) return;
      if (meeting.channelName) {
        map.set(meeting.channelId, meeting.channelName);
      }
    });
    return map;
  }, [meetingRows]);

  const meetingItems = useMemo<MeetingListItem[]>(() => {
    return meetingRows.map((meetingRow) => {
      const channelLabel = formatChannelLabel(
        meetingRow.channelName,
        meetingRow.channelId,
      );
      const dateLabel = formatDateLabel(meetingRow.timestamp);
      const durationLabel = formatDurationLabel(meetingRow.duration);
      const title = resolveMeetingTitle({
        meetingName: meetingRow.meetingName,
        summaryLabel: meetingRow.summaryLabel,
        summarySentence: meetingRow.summarySentence,
        channelLabel,
      });
      const summary = deriveSummary(
        meetingRow.notes,
        meetingRow.summarySentence,
      );
      return {
        ...meetingRow,
        title,
        summary,
        dateLabel,
        durationLabel,
        channelLabel,
      };
    });
  }, [meetingRows, channelNameMap]);

  const nowMs = useMemo(() => resolveNowMs(), []);

  const filteredMeetings = useMemo(
    () =>
      filterMeetingItems(meetingItems, {
        query: params.query,
        selectedTags: params.selectedTags,
        selectedChannel: params.selectedChannel,
        selectedRange: params.selectedRange,
        nowMs,
      }),
    [
      meetingItems,
      params.query,
      params.selectedTags,
      params.selectedChannel,
      params.selectedRange,
      nowMs,
    ],
  );

  const tagOptions = useMemo(
    () =>
      Array.from(
        new Set(meetingRows.flatMap((meeting) => meeting.tags)),
      ).sort(),
    [meetingRows],
  );

  const channelOptions = useMemo(() => {
    const ids = new Set(
      meetingRows.map((meeting) => meeting.channelId).filter(Boolean),
    );
    return Array.from(ids).map((id) => ({
      value: id,
      label: formatChannelLabel(channelNameMap.get(id), id),
    }));
  }, [meetingRows, channelNameMap]);

  const listLoading = meetingsQuery.isLoading;
  const listError = Boolean(meetingsQuery.error);

  const invalidateMeetingLists = useInvalidateMeetingLists(
    params.selectedGuildId,
  );

  const handleRefresh = useCallback(async () => {
    if (!params.selectedGuildId) return;
    await Promise.all([
      invalidateMeetingLists(),
      trpcUtils.meetings.detail.invalidate(),
    ]);
  }, [params.selectedGuildId, invalidateMeetingLists, trpcUtils]);

  return {
    filteredMeetings,
    tagOptions,
    channelOptions,
    channelNameMap,
    listLoading,
    listError,
    invalidateMeetingLists,
    handleRefresh,
  };
};
