import { useParams } from "@tanstack/react-router";
import { trpc } from "../../services/trpc";
import { useAuth } from "../../contexts/AuthContext";
import type { MeetingEvent } from "../../../types/meetingTimeline";

type MeetingShareVisibility = "server" | "public";

export type MeetingShareMeta = {
  shareId: string;
  visibility: MeetingShareVisibility;
  sharedAt?: string;
  sharedByTag?: string;
};

export type SharedMeeting = {
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

export type MeetingSharePageState = {
  meeting: SharedMeeting | null;
  share: MeetingShareMeta | null;
  isLoading: boolean;
  hasError: boolean;
  needsAuthHint: boolean;
  authState: ReturnType<typeof useAuth>["state"];
};

type MeetingShareRouteParams = {
  serverId?: string;
  shareId?: string;
};

type MeetingShareQueryState = {
  meeting: SharedMeeting | null;
  share: MeetingShareMeta | null;
  waitingForAuthCheck: boolean;
  isLoading: boolean;
  hasError: boolean;
  needsAuthHint: boolean;
};

type MeetingShareQueryInput = {
  data: { meeting?: SharedMeeting; share?: MeetingShareMeta } | undefined;
  isFetched: boolean;
  isLoading: boolean;
  error: unknown;
};

type SharedMeetingQueryInput = {
  data: { meeting?: SharedMeeting; share?: MeetingShareMeta } | undefined;
  isFetched: boolean;
  isLoading: boolean;
};

function getMeetingFromQueries(
  publicMeeting: SharedMeeting | undefined,
  sharedMeeting: SharedMeeting | undefined,
) {
  return publicMeeting ?? sharedMeeting ?? null;
}

function getShareFromQueries(
  publicShare: MeetingShareMeta | undefined,
  sharedShare: MeetingShareMeta | undefined,
) {
  return publicShare ?? sharedShare ?? null;
}

function isWaitingForAuthCheck(
  meeting: SharedMeeting | null,
  publicFetched: boolean,
  publicHasError: boolean,
  authState: ReturnType<typeof useAuth>["state"],
) {
  if (meeting) {
    return false;
  }
  if (!publicFetched) {
    return false;
  }
  if (!publicHasError) {
    return false;
  }
  return authState === "unknown";
}

function isSharePageLoading(
  publicLoading: boolean,
  waitingForAuthCheck: boolean,
  publicHasData: boolean,
  authState: ReturnType<typeof useAuth>["state"],
  sharedLoading: boolean,
) {
  if (publicLoading) {
    return true;
  }
  if (waitingForAuthCheck) {
    return true;
  }
  if (publicHasData) {
    return false;
  }
  if (authState !== "authenticated") {
    return false;
  }
  return sharedLoading;
}

function hasSharePageError(
  meeting: SharedMeeting | null,
  publicFetched: boolean,
  authState: ReturnType<typeof useAuth>["state"],
  sharedFetched: boolean,
) {
  if (meeting) {
    return false;
  }
  if (!publicFetched) {
    return false;
  }
  if (authState === "unknown") {
    return false;
  }
  if (authState !== "authenticated") {
    return true;
  }
  return sharedFetched;
}

function needsAuthHintForShare(
  meeting: SharedMeeting | null,
  authState: ReturnType<typeof useAuth>["state"],
  publicFetched: boolean,
  publicHasError: boolean,
) {
  if (meeting) {
    return false;
  }
  if (authState !== "unauthenticated") {
    return false;
  }
  if (!publicFetched) {
    return false;
  }
  return publicHasError;
}

function buildMeetingShareQueryState(
  authState: ReturnType<typeof useAuth>["state"],
  publicQuery: MeetingShareQueryInput,
  sharedQuery: SharedMeetingQueryInput,
): MeetingShareQueryState {
  const meeting = getMeetingFromQueries(
    publicQuery.data?.meeting,
    sharedQuery.data?.meeting,
  );
  const share = getShareFromQueries(
    publicQuery.data?.share,
    sharedQuery.data?.share,
  );
  const publicHasError = Boolean(publicQuery.error);

  const waitingForAuthCheck = isWaitingForAuthCheck(
    meeting,
    publicQuery.isFetched,
    publicHasError,
    authState,
  );

  const isLoading = isSharePageLoading(
    publicQuery.isLoading,
    waitingForAuthCheck,
    Boolean(publicQuery.data),
    authState,
    sharedQuery.isLoading,
  );

  const hasError = hasSharePageError(
    meeting,
    publicQuery.isFetched,
    authState,
    sharedQuery.isFetched,
  );

  const needsAuthHint = needsAuthHintForShare(
    meeting,
    authState,
    publicQuery.isFetched,
    publicHasError,
  );

  return {
    meeting,
    share,
    waitingForAuthCheck,
    isLoading,
    hasError,
    needsAuthHint,
  };
}

export function useMeetingSharePageState(): MeetingSharePageState {
  const auth = useAuth();
  const params = useParams({ strict: false }) as MeetingShareRouteParams;

  const hasParams = Boolean(params.serverId && params.shareId);

  const publicQuery = trpc.meetingShares.getPublicMeeting.useQuery(
    {
      serverId: params.serverId ?? "",
      shareId: params.shareId ?? "",
    },
    { enabled: hasParams },
  );

  const sharedQuery = trpc.meetingShares.getSharedMeeting.useQuery(
    {
      serverId: params.serverId ?? "",
      shareId: params.shareId ?? "",
    },
    { enabled: hasParams && auth.state === "authenticated" },
  );

  const queryState = buildMeetingShareQueryState(
    auth.state,
    {
      data: publicQuery.data,
      isFetched: publicQuery.isFetched,
      isLoading: publicQuery.isLoading,
      error: publicQuery.error,
    },
    {
      data: sharedQuery.data,
      isFetched: sharedQuery.isFetched,
      isLoading: sharedQuery.isLoading,
    },
  );

  return {
    meeting: queryState.meeting,
    share: queryState.share,
    isLoading: queryState.isLoading,
    hasError: queryState.hasError,
    needsAuthHint: queryState.needsAuthHint,
    authState: auth.state,
  };
}
