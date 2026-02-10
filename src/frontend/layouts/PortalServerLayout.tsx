import { useEffect, useMemo } from "react";
import {
  Navigate,
  Outlet,
  useNavigate,
  useParams,
  useRouterState,
  useSearch,
} from "@tanstack/react-router";
import { useGuildContext } from "../contexts/GuildContext";
import { usePortalStore } from "../stores/portalStore";
import { trpc } from "../services/trpc";
import { useInvalidateMeetingLists } from "../hooks/useInvalidateMeetingLists";
import MeetingDetailDrawer from "../pages/library/components/MeetingDetailDrawer";

export default function PortalServerLayout() {
  const { serverId } = useParams({ strict: false }) as { serverId?: string };
  const navigateAsk = useNavigate({ from: "/portal/server/$serverId/ask" });
  const navigateLibrary = useNavigate({
    from: "/portal/server/$serverId/library",
  });
  const activeRouteId = useRouterState({
    select: (state) => state.matches[state.matches.length - 1]?.routeId,
  });
  const isAskRoute = activeRouteId === "/portal/server/$serverId/ask";
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const { selectedGuildId, setSelectedGuildId, guilds, loading } =
    useGuildContext();
  const setLastServerId = usePortalStore((state) => state.setLastServerId);
  const activeServerId = serverId ?? selectedGuildId ?? null;
  const selectedMeetingId =
    typeof search.meetingId === "string" ? search.meetingId : null;
  const canManageSelectedGuild =
    activeServerId != null &&
    guilds.find((guild) => guild.id === activeServerId)?.canManage === true;

  const channelsQuery = trpc.servers.channels.useQuery(
    { serverId: activeServerId ?? "" },
    { enabled: Boolean(activeServerId && canManageSelectedGuild) },
  );
  const channelNameMap = useMemo(() => {
    const map = new Map<string, string>();
    const voiceChannels = channelsQuery.data?.voiceChannels ?? [];
    const textChannels = channelsQuery.data?.textChannels ?? [];
    [...voiceChannels, ...textChannels].forEach((channel) => {
      map.set(channel.id, channel.name);
    });
    return map;
  }, [channelsQuery.data]);
  const invalidateMeetingLists = useInvalidateMeetingLists(activeServerId);

  useEffect(() => {
    if (!serverId || loading) return;
    if (selectedGuildId !== serverId) {
      setSelectedGuildId(serverId);
    }
    setLastServerId(serverId);
  }, [serverId, loading, selectedGuildId, setSelectedGuildId, setLastServerId]);

  if (loading) {
    return null;
  }

  if (serverId && guilds.length > 0 && !guilds.some((g) => g.id === serverId)) {
    return <Navigate to="/portal/select-server" />;
  }

  return (
    <>
      <Outlet />
      <MeetingDetailDrawer
        opened={Boolean(selectedMeetingId && activeServerId)}
        selectedMeetingId={selectedMeetingId}
        selectedGuildId={activeServerId}
        canManageSelectedGuild={canManageSelectedGuild}
        channelNameMap={channelNameMap}
        invalidateMeetingLists={invalidateMeetingLists}
        onClose={() =>
          (isAskRoute ? navigateAsk : navigateLibrary)({
            search: (prev) => ({
              ...prev,
              meetingId: undefined,
              eventId: undefined,
              fullScreen: undefined,
            }),
          })
        }
      />
    </>
  );
}
