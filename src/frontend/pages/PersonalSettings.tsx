import { useState } from "react";
import { Stack } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import PageHeader from "../components/PageHeader";
import { useAuth } from "../contexts/AuthContext";
import { NotionIntegrationCard } from "../features/settings/NotionIntegrationCard";
import { buildApiUrl } from "../services/apiClient";
import { trpc } from "../services/trpc";
import { buildPersonalMeetingGuildId } from "../../utils/meetingOwnership";

export default function PersonalSettings() {
  const { user } = useAuth();
  const trpcUtils = trpc.useUtils();
  const [notionDestinationSearch, setNotionDestinationSearch] = useState<
    string | null
  >(null);
  const personalServerId = user ? buildPersonalMeetingGuildId(user.id) : "";

  const notionStatusQuery = trpc.notion.automationStatus.useQuery(
    { serverId: personalServerId },
    { enabled: Boolean(personalServerId) },
  );
  const notionDestinationQuery = trpc.notion.destinationPages.useQuery(
    { serverId: personalServerId, query: notionDestinationSearch ?? "" },
    {
      enabled: Boolean(personalServerId) && notionDestinationSearch !== null,
    },
  );
  const saveNotionAutomationMutation =
    trpc.notion.saveAutomationConfig.useMutation();
  const disableNotionAutomationMutation =
    trpc.notion.disableAutomation.useMutation();

  const handleConnectNotion = () => {
    const redirect = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    const url = `${buildApiUrl("/api/notion/connect")}?redirect=${encodeURIComponent(
      redirect,
    )}`;
    window.location.assign(url);
  };

  const handleSaveNotionAutomation = async (input: {
    destinationPageId: string;
    autoExportEnabled: boolean;
    channelIds: string[];
    tags: string[];
  }) => {
    if (!personalServerId) return;
    try {
      await saveNotionAutomationMutation.mutateAsync({
        serverId: personalServerId,
        ...input,
      });
      notifications.show({ message: "Personal Notion automation saved." });
      await trpcUtils.notion.automationStatus.invalidate({
        serverId: personalServerId,
      });
    } catch (error) {
      const message =
        error instanceof Error && error.message
          ? error.message
          : "Unable to save personal Notion automation right now.";
      notifications.show({ color: "red", message });
    }
  };

  const handleDisableNotionAutomation = async () => {
    if (!personalServerId) return;
    try {
      await disableNotionAutomationMutation.mutateAsync({
        serverId: personalServerId,
      });
      notifications.show({ message: "Personal Notion automation disabled." });
      await trpcUtils.notion.automationStatus.invalidate({
        serverId: personalServerId,
      });
    } catch (error) {
      const message =
        error instanceof Error && error.message
          ? error.message
          : "Unable to disable personal Notion automation right now.";
      notifications.show({ color: "red", message });
    }
  };

  const notionBusy =
    saveNotionAutomationMutation.isPending ||
    disableNotionAutomationMutation.isPending;

  return (
    <Stack gap="xl" data-testid="personal-settings-page">
      <PageHeader
        title="Personal settings"
        description="Manage your Chronote account preferences and personal integrations."
      />

      {user ? (
        <NotionIntegrationCard
          personal
          status={notionStatusQuery.data}
          loading={notionStatusQuery.isLoading || notionStatusQuery.isFetching}
          busy={notionBusy}
          destinationPages={notionDestinationQuery.data?.pages ?? []}
          destinationLoading={
            notionDestinationQuery.isLoading ||
            notionDestinationQuery.isFetching
          }
          voiceChannels={[]}
          onConnect={handleConnectNotion}
          onSearchDestinations={(query) => {
            const next = query.trim();
            setNotionDestinationSearch(next);
            if (notionDestinationSearch === next) {
              void notionDestinationQuery.refetch();
            }
          }}
          onSave={handleSaveNotionAutomation}
          onDisable={handleDisableNotionAutomation}
        />
      ) : null}
    </Stack>
  );
}
