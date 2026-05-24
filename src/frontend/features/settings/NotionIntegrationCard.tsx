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

type AutomationConfig = NonNullable<AutomationStatus["automation"]>;

type AutomationFormState = {
  destinationPageId: string | null;
  autoExportEnabled: boolean;
  channelIds: string[];
  tagDraft: string;
};

type NotionIntegrationHeaderProps = {
  status?: AutomationStatus;
  loading: boolean;
  busy: boolean;
  automation?: AutomationConfig;
  onConnect: () => void;
};

type AutomationBadgeProps = {
  automation?: AutomationConfig;
};

type NotionStatusAlertsProps = {
  status?: AutomationStatus;
  automation?: AutomationConfig;
};

type AutomationErrorAlertProps = {
  lastError?: string;
};

type DestinationLinkProps = {
  automation?: AutomationConfig;
};

type DestinationSearchProps = {
  search: string;
  setSearch: (value: string) => void;
  controlsDisabled: boolean;
  destinationLoading: boolean;
  onSearchDestinations: (query: string) => void;
};

type AutomationActionsProps = {
  automation?: AutomationConfig;
  busy: boolean;
  loading: boolean;
  saveDisabled: boolean;
  onDisable: () => Promise<void>;
  onSave: () => Promise<void>;
};

type AutomationBadgeState = {
  color: "teal" | "gray";
  label: string;
};

type StatusAlertState = {
  color: "gray" | "yellow" | "blue" | "teal" | "red";
  message: string;
  warningIcon?: boolean;
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

const getAutomationFormState = (
  automation?: AutomationConfig,
): AutomationFormState => ({
  destinationPageId: automation?.destinationPageId ?? null,
  autoExportEnabled: automation?.enabled ?? true,
  channelIds: automation?.channelIds ?? [],
  tagDraft: automation?.tags.join(", ") ?? "",
});

const buildChannelOptions = (voiceChannels: ChannelOption[]) =>
  voiceChannels.map((channel) => ({
    value: channel.value,
    label: channel.label,
  }));

const shouldDisableControls = (
  status: AutomationStatus | undefined,
  busy: boolean,
) => busy || !status?.configured || !status.userConnected;

const shouldDisableSave = ({
  loading,
  controlsDisabled,
  destinationPageId,
}: {
  loading: boolean;
  controlsDisabled: boolean;
  destinationPageId: string | null;
}) => loading || controlsDisabled || !destinationPageId;

const isConnectDisabled = (
  status: AutomationStatus | undefined,
  loading: boolean,
  busy: boolean,
) => loading || busy || !status?.configured;

const getConnectLabel = (status?: AutomationStatus) =>
  status?.userConnected ? "Reconnect Notion" : "Connect Notion";

const getAutomationBadgeState = (
  automation?: AutomationConfig,
): AutomationBadgeState | null => {
  if (!automation) return null;
  return {
    color: automation.enabled ? "teal" : "gray",
    label: automation.enabled ? "Auto-export on" : "Configured",
  };
};

const getStatusAlertState = ({
  status,
  automation,
}: NotionStatusAlertsProps): StatusAlertState => {
  if (!status?.configured) {
    return {
      color: "gray",
      message: "Notion export is not configured for this Chronote environment.",
    };
  }
  if (!status.userConnected) {
    return {
      color: "yellow",
      message:
        "Connect Notion before choosing an automatic export destination.",
      warningIcon: true,
    };
  }
  if (!automation) {
    return {
      color: "blue",
      message: `Connected to ${workspaceLabel(status)}. Choose a destination page to enable automation.`,
    };
  }
  if (!automation.ownerConnected) {
    return {
      color: "red",
      message: "Reconnect Notion to restore automatic exports for this server.",
    };
  }
  return {
    color: "teal",
    message: `Automation uses ${workspaceLabel(status)} and exports to ${automation.destinationTitle ?? "the selected page"}.`,
  };
};

const buildSaveInput = ({
  destinationPageId,
  autoExportEnabled,
  channelIds,
  tagDraft,
}: AutomationFormState): SaveAutomationInput | null => {
  if (!destinationPageId) return null;
  return {
    destinationPageId,
    autoExportEnabled,
    channelIds,
    tags: parseTags(tagDraft) ?? [],
  };
};

function NotionIntegrationHeader({
  status,
  loading,
  busy,
  automation,
  onConnect,
}: NotionIntegrationHeaderProps) {
  return (
    <Group justify="space-between" align="flex-start" wrap="wrap">
      <Stack gap={4}>
        <Group gap="xs">
          <IconPlugConnected size={18} />
          <Text fw={600}>Notion integration</Text>
          <AutomationBadge automation={automation} />
        </Group>
        <Text size="sm" c="dimmed">
          Export completed meeting notes to a shared Notion page destination.
        </Text>
      </Stack>
      <Button
        variant="light"
        onClick={onConnect}
        disabled={isConnectDisabled(status, loading, busy)}
      >
        {getConnectLabel(status)}
      </Button>
    </Group>
  );
}

function AutomationBadge({ automation }: AutomationBadgeProps) {
  const badge = getAutomationBadgeState(automation);
  if (!badge) return null;
  return (
    <Badge color={badge.color} variant="light">
      {badge.label}
    </Badge>
  );
}

function NotionStatusAlerts({ status, automation }: NotionStatusAlertsProps) {
  const alert = getStatusAlertState({ status, automation });
  return (
    <Alert
      icon={alert.warningIcon ? <IconAlertTriangle size={16} /> : undefined}
      color={alert.color}
      variant="light"
    >
      {alert.message}
    </Alert>
  );
}

function AutomationErrorAlert({ lastError }: AutomationErrorAlertProps) {
  if (!lastError) return null;
  return (
    <Alert icon={<IconAlertTriangle size={16} />} color="red" variant="light">
      Latest Notion automation error: {lastError}
    </Alert>
  );
}

function DestinationLink({ automation }: DestinationLinkProps) {
  if (!automation?.destinationUrl) return null;
  return (
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
  );
}

function DestinationSearch({
  search,
  setSearch,
  controlsDisabled,
  destinationLoading,
  onSearchDestinations,
}: DestinationSearchProps) {
  return (
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
  );
}

function AutomationActions({
  automation,
  busy,
  loading,
  saveDisabled,
  onDisable,
  onSave,
}: AutomationActionsProps) {
  return (
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
      <Button onClick={onSave} disabled={saveDisabled} loading={busy}>
        Save Notion automation
      </Button>
    </Group>
  );
}

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
    const nextState = getAutomationFormState(automation);
    setDestinationPageId(nextState.destinationPageId);
    setAutoExportEnabled(nextState.autoExportEnabled);
    setChannelIds(nextState.channelIds);
    setTagDraft(nextState.tagDraft);
  }, [automation]);

  const destinationOptions = buildDestinationOptions(
    destinationPages,
    automation,
  );
  const channelOptions = buildChannelOptions(voiceChannels);

  const controlsDisabled = shouldDisableControls(status, busy);
  const saveDisabled = shouldDisableSave({
    loading,
    controlsDisabled,
    destinationPageId,
  });

  const handleSave = async () => {
    const input = buildSaveInput({
      destinationPageId,
      autoExportEnabled,
      channelIds,
      tagDraft,
    });
    if (!input) return;
    await onSave(input);
  };

  return (
    <Surface p="lg" data-testid="settings-notion-integration">
      <Stack gap="md">
        <NotionIntegrationHeader
          status={status}
          loading={loading}
          busy={busy}
          automation={automation}
          onConnect={onConnect}
        />

        <NotionStatusAlerts status={status} automation={automation} />

        <AutomationErrorAlert lastError={automation?.lastError} />

        <DestinationSearch
          search={search}
          setSearch={setSearch}
          controlsDisabled={controlsDisabled}
          destinationLoading={destinationLoading}
          onSearchDestinations={onSearchDestinations}
        />

        <Select
          label="Destination page"
          placeholder="Select a Notion page"
          data={destinationOptions}
          value={destinationPageId}
          onChange={setDestinationPageId}
          searchable
          disabled={controlsDisabled}
        />

        <DestinationLink automation={automation} />

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

        <AutomationActions
          automation={automation}
          busy={busy}
          loading={loading}
          saveDisabled={saveDisabled}
          onDisable={onDisable}
          onSave={handleSave}
        />
      </Stack>
    </Surface>
  );
}
