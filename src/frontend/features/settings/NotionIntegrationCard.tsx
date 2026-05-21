import { useEffect, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Group,
  MultiSelect,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
} from "@mantine/core";
import {
  IconAlertTriangle,
  IconExternalLink,
  IconPlugConnected,
  IconSearch,
} from "@tabler/icons-react";
import Surface from "../../components/Surface";
import { parseTags } from "../../../utils/tags";
import type { ChannelOption } from "../../utils/settingsChannels";

type DestinationPage = {
  id: string;
  title: string;
  url?: string;
};

type AutomationStatus = {
  configured: boolean;
  userConnected: boolean;
  workspaceName?: string;
  automation?: {
    enabled: boolean;
    ownerConnected: boolean;
    workspaceName?: string;
    destinationPageId: string;
    destinationTitle?: string;
    destinationUrl?: string;
    channelIds: string[];
    tags: string[];
    lastError?: string;
  };
};

type SaveAutomationInput = {
  destinationPageId: string;
  autoExportEnabled: boolean;
  channelIds: string[];
  tags: string[];
};

type NotionIntegrationCardProps = {
  status?: AutomationStatus;
  loading: boolean;
  busy: boolean;
  destinationPages: DestinationPage[];
  destinationLoading: boolean;
  voiceChannels: ChannelOption[];
  onConnect: () => void;
  onSearchDestinations: (query: string) => void;
  onSave: (input: SaveAutomationInput) => Promise<void>;
  onDisable: () => Promise<void>;
};

const buildDestinationOptions = (
  pages: DestinationPage[],
  current?: AutomationStatus["automation"],
) => {
  const byId = new Map<string, { value: string; label: string }>();
  if (current) {
    byId.set(current.destinationPageId, {
      value: current.destinationPageId,
      label: current.destinationTitle ?? current.destinationPageId,
    });
  }
  pages.forEach((page) => {
    byId.set(page.id, { value: page.id, label: page.title });
  });
  return Array.from(byId.values());
};

const workspaceLabel = (status?: AutomationStatus) =>
  status?.workspaceName ?? status?.automation?.workspaceName ?? "Notion";

export function NotionIntegrationCard({
  status,
  loading,
  busy,
  destinationPages,
  destinationLoading,
  voiceChannels,
  onConnect,
  onSearchDestinations,
  onSave,
  onDisable,
}: NotionIntegrationCardProps) {
  const automation = status?.automation;
  const [search, setSearch] = useState("");
  const [destinationPageId, setDestinationPageId] = useState<string | null>(
    null,
  );
  const [autoExportEnabled, setAutoExportEnabled] = useState(true);
  const [channelIds, setChannelIds] = useState<string[]>([]);
  const [tagDraft, setTagDraft] = useState("");

  useEffect(() => {
    setDestinationPageId(automation?.destinationPageId ?? null);
    setAutoExportEnabled(automation?.enabled ?? true);
    setChannelIds(automation?.channelIds ?? []);
    setTagDraft(automation?.tags.join(", ") ?? "");
  }, [automation]);

  const destinationOptions = buildDestinationOptions(
    destinationPages,
    automation,
  );
  const channelOptions = voiceChannels.map((channel) => ({
    value: channel.value,
    label: channel.label,
  }));

  const controlsDisabled =
    busy || !status?.configured || !status?.userConnected;
  const saveDisabled = loading || controlsDisabled || !destinationPageId;

  const handleSave = async () => {
    if (!destinationPageId) return;
    await onSave({
      destinationPageId,
      autoExportEnabled,
      channelIds,
      tags: parseTags(tagDraft) ?? [],
    });
  };

  return (
    <Surface p="lg" data-testid="settings-notion-integration">
      <Stack gap="md">
        <Group justify="space-between" align="flex-start" wrap="wrap">
          <Stack gap={4}>
            <Group gap="xs">
              <IconPlugConnected size={18} />
              <Text fw={600}>Notion integration</Text>
              {automation?.enabled ? (
                <Badge color="teal" variant="light">
                  Auto-export on
                </Badge>
              ) : automation ? (
                <Badge color="gray" variant="light">
                  Configured
                </Badge>
              ) : null}
            </Group>
            <Text size="sm" c="dimmed">
              Export completed meeting notes to a shared Notion page
              destination.
            </Text>
          </Stack>
          <Button
            variant="light"
            onClick={onConnect}
            disabled={loading || busy || !status?.configured}
          >
            {status?.userConnected ? "Reconnect Notion" : "Connect Notion"}
          </Button>
        </Group>

        {!status?.configured ? (
          <Alert color="gray" variant="light">
            Notion export is not configured for this Chronote environment.
          </Alert>
        ) : !status.userConnected ? (
          <Alert
            icon={<IconAlertTriangle size={16} />}
            color="yellow"
            variant="light"
          >
            Connect Notion before choosing an automatic export destination.
          </Alert>
        ) : automation ? (
          <Alert
            color={automation.ownerConnected ? "teal" : "red"}
            variant="light"
          >
            {automation.ownerConnected
              ? `Automation uses ${workspaceLabel(status)} and exports to ${automation.destinationTitle ?? "the selected page"}.`
              : "Reconnect Notion to restore automatic exports for this server."}
          </Alert>
        ) : (
          <Alert color="blue" variant="light">
            Connected to {workspaceLabel(status)}. Choose a destination page to
            enable automation.
          </Alert>
        )}

        {automation?.lastError ? (
          <Alert
            icon={<IconAlertTriangle size={16} />}
            color="red"
            variant="light"
          >
            Latest Notion automation error: {automation.lastError}
          </Alert>
        ) : null}

        <Group align="end">
          <TextInput
            label="Find destination page"
            placeholder="Search shared Notion pages"
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
            disabled={controlsDisabled}
            style={{ flex: 1 }}
          />
          <Button
            leftSection={<IconSearch size={16} />}
            variant="default"
            onClick={() => onSearchDestinations(search)}
            loading={destinationLoading}
            disabled={controlsDisabled}
          >
            Search
          </Button>
        </Group>

        <Select
          label="Destination page"
          placeholder="Select a Notion page"
          data={destinationOptions}
          value={destinationPageId}
          onChange={setDestinationPageId}
          searchable
          disabled={controlsDisabled}
        />

        {automation?.destinationUrl ? (
          <Button
            component="a"
            href={automation.destinationUrl}
            target="_blank"
            rel="noopener noreferrer"
            variant="subtle"
            leftSection={<IconExternalLink size={16} />}
            style={{ alignSelf: "flex-start" }}
          >
            Open destination in Notion
          </Button>
        ) : null}

        <Switch
          label="Automatically export completed meetings"
          description="Chronote remains the source of truth and syncs later Chronote note edits one-way to Notion."
          checked={autoExportEnabled}
          onChange={(event) =>
            setAutoExportEnabled(event.currentTarget.checked)
          }
          disabled={controlsDisabled}
        />

        <MultiSelect
          label="Only these voice channels"
          description="Leave empty to export every completed meeting in this server."
          placeholder={
            channelIds.length === 0 ? "All voice channels" : undefined
          }
          data={channelOptions}
          value={channelIds}
          onChange={setChannelIds}
          searchable
          clearable
          disabled={controlsDisabled}
        />

        <TextInput
          label="Only these tags"
          description="Comma-separated. Leave empty to export meetings with any tags."
          placeholder="campaign, recap"
          value={tagDraft}
          onChange={(event) => setTagDraft(event.currentTarget.value)}
          disabled={controlsDisabled}
        />

        <Group justify="flex-end">
          {automation ? (
            <Button
              variant="default"
              onClick={onDisable}
              disabled={busy || loading}
            >
              Disable automation
            </Button>
          ) : null}
          <Button onClick={handleSave} disabled={saveDisabled} loading={busy}>
            Save Notion automation
          </Button>
        </Group>
      </Stack>
    </Surface>
  );
}
