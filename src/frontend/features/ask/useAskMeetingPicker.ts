import type { Dispatch, SetStateAction, RefObject } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../trpc/router";
import { trpc } from "../../services/trpc";
import type { AskContextMeeting } from "./AskStartingState";

type StartingData = inferRouterOutputs<AppRouter>["ask"]["startingContext"];
type SearchData = inferRouterOutputs<AppRouter>["ask"]["searchMeetings"];
type Query<T> = { data?: T; isPending: boolean; isError: boolean };
function pickerData(
  query: string,
  debouncedQuery: string,
  starting: Query<StartingData>,
  search: Query<SearchData>,
) {
  if (query !== debouncedQuery)
    return { meetings: [], loading: true, failed: false };
  if (!query.trim())
    return {
      meetings: starting.data?.meetings ?? [],
      coverage: starting.data?.coverage.status,
      loading: starting.isPending,
      failed: starting.isError,
    };
  return {
    meetings: (search.data?.hits ?? []).map((hit) => ({
      id: hit.meeting.id,
      title: hit.title,
      timestamp: hit.startedAt,
    })),
    coverage: search.data?.coverage.status,
    semanticCoverage: search.data?.coverage.semanticStatus,
    nextCursor: search.data?.nextCursor,
    loading: search.isPending,
    failed: search.isError,
  };
}
export function canShowAskStarting(options: {
  serverId: string | null;
  listMode: string;
  isArchived: boolean;
  listBusy: boolean;
  conversationBusy: boolean;
  listError: unknown;
  conversationError: unknown;
  askAccessAllowed: boolean;
}) {
  return Boolean(
    options.serverId &&
    options.listMode === "mine" &&
    !options.isArchived &&
    !options.listBusy &&
    !options.conversationBusy &&
    !options.listError &&
    !options.conversationError &&
    options.askAccessAllowed,
  );
}
export function useAskMeetingPicker({
  selectedGuildId,
  askAccessAllowed,
  searchEnabled,
  startingVisible,
  settingsReady,
  messageCount,
  meetingQuery,
  debouncedMeetingQuery,
  meetingCursor,
  contextMeetings,
  setMeetingQuery,
  setMeetingCursor,
  setContextMeetings,
  setDraft,
  inputRef,
  pickerOpen,
}: {
  selectedGuildId: string | null;
  askAccessAllowed: boolean;
  searchEnabled: boolean;
  startingVisible: boolean;
  settingsReady: boolean;
  messageCount: number;
  meetingQuery: string;
  debouncedMeetingQuery: string;
  meetingCursor?: string;
  contextMeetings: AskContextMeeting[];
  setMeetingQuery: (query: string) => void;
  setMeetingCursor: (cursor: string | undefined) => void;
  setContextMeetings: Dispatch<SetStateAction<AskContextMeeting[]>>;
  setDraft: (draft: string) => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  pickerOpen: boolean;
}) {
  const startingContextQuery = trpc.ask.startingContext.useQuery(
    { serverId: selectedGuildId ?? "" },
    {
      enabled: Boolean(startingVisible && settingsReady && !messageCount),
      staleTime: 30_000,
    },
  );
  const meetingSearchQuery = trpc.ask.searchMeetings.useQuery(
    {
      serverId: selectedGuildId ?? "",
      query: debouncedMeetingQuery,
      cursor: meetingCursor,
      pageSize: 10,
    },
    {
      enabled: Boolean(
        selectedGuildId &&
        askAccessAllowed &&
        searchEnabled &&
        debouncedMeetingQuery.trim(),
      ),
      staleTime: 30_000,
    },
  );
  const data = pickerData(
    meetingQuery,
    debouncedMeetingQuery,
    startingContextQuery,
    meetingSearchQuery,
  );
  const pickerProps = {
    ...data,
    searchQuery: meetingQuery,
    onSearchChange: (value: string) => {
      setMeetingQuery(value);
      setMeetingCursor(undefined);
    },
    onLoadMore: data.nextCursor
      ? () => setMeetingCursor(data.nextCursor ?? undefined)
      : undefined,
    selectedIds: contextMeetings.map((meeting) => meeting.id),
    onRetry: () => {
      void (meetingQuery.trim()
        ? meetingSearchQuery.refetch()
        : startingContextQuery.refetch());
    },
    onExample: (question: string) => {
      setDraft(question);
      inputRef.current?.focus({ preventScroll: true });
    },
    onSelect: (meeting: AskContextMeeting) => {
      setContextMeetings((current) =>
        current.some((item) => item.id === meeting.id)
          ? current
          : [...current, meeting].slice(0, 3),
      );
      if (!pickerOpen) inputRef.current?.focus({ preventScroll: true });
    },
  };
  return { startingContextQuery, pickerProps };
}
