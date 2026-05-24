import { useMemo } from "react";
import { Stack, Text } from "@mantine/core";
import { useNavigate, useParams } from "@tanstack/react-router";
import PageHeader from "../components/PageHeader";
import Surface from "../components/Surface";
import { useGuildContext } from "../contexts/GuildContext";
import { useInvalidateMeetingLists } from "../hooks/useInvalidateMeetingLists";
import { trpc } from "../services/trpc";
import MeetingDetailDrawer from "./library/components/MeetingDetailDrawer";

export default function MeetingDetail() {
  const { serverId, meetingId } = useParams({
    from: "/portal/meetings/$serverId/$meetingId",
  });
  const navigate = useNavigate({
    from: "/portal/meetings/$serverId/$meetingId",
  });
  const { guilds } = useGuildContext();
  const guild = guilds.find((item) => item.id === serverId) ?? null;
  const canManageSelectedGuild = guild?.canManage === true;

  const channelsQuery = trpc.servers.channels.useQuery(
    { serverId },
    { enabled: canManageSelectedGuild },
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
  const invalidateMeetingLists = useInvalidateMeetingLists(serverId);

  return (
    <Stack gap="lg" data-testid="meeting-detail-page">
      <PageHeader
        title="Meeting details"
        description="A direct link to one meeting you can access from My Meetings."
      />
      <Surface p="lg" tone="soft">
        <Text size="sm" c="dimmed">
          {guild?.name
            ? `This meeting belongs to ${guild.name}.`
            : "This meeting may belong to a server you no longer browse directly."}
        </Text>
      </Surface>
      <MeetingDetailDrawer
        opened
        selectedMeetingId={meetingId}
        selectedGuildId={serverId}
        canManageSelectedGuild={canManageSelectedGuild}
        channelNameMap={channelNameMap}
        invalidateMeetingLists={invalidateMeetingLists}
        onFullScreenChange={(fullScreen) =>
          navigate({
            search: (prev) => ({
              ...prev,
              fullScreen: fullScreen ? true : undefined,
            }),
          })
        }
        onClose={() => navigate({ to: "/portal/meetings" })}
      />
    </Stack>
  );
}
