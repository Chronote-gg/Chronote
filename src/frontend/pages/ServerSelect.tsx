import { Stack } from "@mantine/core";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect } from "react";
import { useGuildContext } from "../contexts/GuildContext";
import PageHeader from "../components/PageHeader";
import ServerPicker from "../components/ServerPicker";
import { usePortalStore } from "../stores/portalStore";

export default function ServerSelect() {
  const { guilds, loading, selectedGuildId, setSelectedGuildId } =
    useGuildContext();
  const navigate = useNavigate();
  const search = useSearch({ from: "/portal/select-server" });
  const promoCode = search.promo?.trim() ?? "";
  const hasPromo = promoCode.length > 0;
  const setLastServerId = usePortalStore((state) => state.setLastServerId);
  useEffect(() => {
    if (selectedGuildId) {
      setSelectedGuildId(null);
    }
  }, [selectedGuildId, setSelectedGuildId]);

  return (
    <Stack gap="xl" data-testid="server-select">
      <PageHeader
        title="Choose a server"
        description="Choose a server to continue."
      />
      <ServerPicker
        guilds={guilds}
        loading={loading}
        selectedGuildId={selectedGuildId}
        sections={[
          {
            title: "Servers you manage",
            filter: (guild) => guild.canManage,
          },
          {
            title: "View-only servers",
            filter: (guild) => !guild.canManage,
          },
        ]}
        onSelect={(guildId) => {
          setSelectedGuildId(guildId);
          setLastServerId(guildId);
        }}
        onAction={(guild) => {
          if (guild.canManage && hasPromo) {
            navigate({
              to: "/portal/server/$serverId/billing",
              params: { serverId: guild.id },
              search: { promo: promoCode },
            });
          } else {
            navigate({
              to: "/portal/meetings",
              search: {
                scope: "guild",
                serverId: guild.id,
                attended: false,
                range: "all",
                archive: "active",
              },
            });
          }
        }}
        actionLabel={() => "Open server"}
        actionDisabled={() => false}
        emptyTitle="No servers found"
        emptyDescription="We could not find any servers with Chronote installed yet."
        cardTestId="server-card"
        actionTestId="server-open"
      />
    </Stack>
  );
}
