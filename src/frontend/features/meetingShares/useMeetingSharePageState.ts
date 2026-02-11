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

export function useMeetingSharePageState(): MeetingSharePageState {
  const auth = useAuth();
  const params = useParams({ strict: false }) as {
    serverId?: string;
    shareId?: string;
  };

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

  const meeting =
    publicQuery.data?.meeting ?? sharedQuery.data?.meeting ?? null;
  const share = publicQuery.data?.share ?? sharedQuery.data?.share ?? null;

  const waitingForAuthCheck =
    !meeting &&
    publicQuery.isFetched &&
    Boolean(publicQuery.error) &&
    auth.state === "unknown";

  const isLoading =
    publicQuery.isLoading ||
    waitingForAuthCheck ||
    (!publicQuery.data &&
      auth.state === "authenticated" &&
      sharedQuery.isLoading);

  const hasError =
    !meeting &&
    publicQuery.isFetched &&
    auth.state !== "unknown" &&
    (auth.state !== "authenticated" || sharedQuery.isFetched);

  const needsAuthHint =
    !meeting &&
    auth.state === "unauthenticated" &&
    publicQuery.isFetched &&
    Boolean(publicQuery.error);

  return {
    meeting,
    share: share ?? null,
    isLoading,
    hasError,
    needsAuthHint,
    authState: auth.state,
  };
}
