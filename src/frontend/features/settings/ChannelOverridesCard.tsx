import {
  ActionIcon,
  Button,
  Group,
  LoadingOverlay,
  Stack,
  Text,
  ThemeIcon,
} from "@mantine/core";
import {
  IconBroadcast,
  IconPencil,
  IconPlus,
  IconRefresh,
  IconTrash,
} from "@tabler/icons-react";
import Surface from "../../components/Surface";
import { uiOverlays } from "../../uiTokens";
import type {
  ChannelOption,
  ChannelOverride,
} from "../../utils/settingsChannels";

type ChannelOverridesCardProps = {
  busy: boolean;
  refreshing: boolean;
  recordAllEnabled: boolean;
  overrides: ChannelOverride[];
  voiceChannels: ChannelOption[];
  defaultNotesChannelId: string | null;
  defaultNotesLabel?: string;
  availableVoiceChannels: {
    value: string;
    label: string;
    disabled?: boolean;
  }[];
  onRefresh: () => void;
  onAdd: () => void;
  onSelect: (channelId: string) => void;
  onRemove?: (override: ChannelOverride) => void;
};

export function ChannelOverridesCard({
  busy,
  refreshing,
  recordAllEnabled,
  overrides,
  onRefresh,
  onAdd,
  onSelect,
  onRemove,
  availableVoiceChannels,
  voiceChannels,
  defaultNotesChannelId,
  defaultNotesLabel,
}: ChannelOverridesCardProps) {
  const channelIds = Array.from(
    new Set([
      ...voiceChannels.map((channel) => channel.value),
      ...overrides.map((override) => override.channelId),
    ]),
  );
  return (
    <Surface
      p="lg"
      style={{ position: "relative", overflow: "hidden" }}
      data-testid="settings-overrides"
    >
      <LoadingOverlay
        visible={busy}
        data-testid="settings-loading-overrides"
        overlayProps={uiOverlays.loading}
        loaderProps={{ size: "md" }}
      />
      <Stack gap="md">
        <Group justify="space-between" gap="sm" wrap="wrap">
          <Group gap="sm">
            <ThemeIcon variant="light" color="brand">
              <IconBroadcast size={18} />
            </ThemeIcon>
            <Text fw={600}>Channel overrides</Text>
          </Group>
          <Group gap="sm">
            <Button
              variant="subtle"
              leftSection={<IconRefresh size={16} />}
              onClick={onRefresh}
              loading={refreshing}
              disabled={busy}
              data-testid="settings-refresh-channels"
            >
              Refresh channels
            </Button>
            <Button
              leftSection={<IconPlus size={16} />}
              onClick={onAdd}
              disabled={availableVoiceChannels.length === 0}
              data-testid="settings-add-channel"
            >
              Add override
            </Button>
          </Group>
        </Group>

        {channelIds.length === 0 ? (
          <Surface tone="soft" p="md">
            <Text c="dimmed" size="sm">
              No channel overrides yet. Add one to customize recording,
              chat-to-speech, or context per voice channel.
            </Text>
          </Surface>
        ) : (
          <Stack gap="xs">
            {channelIds.map((channelId) => (
              <ChannelOverrideRow
                key={channelId}
                channelId={channelId}
                override={overrides.find(
                  (entry) => entry.channelId === channelId,
                )}
                voiceLabel={
                  voiceChannels.find((channel) => channel.value === channelId)
                    ?.label ?? "Unknown channel"
                }
                defaultNotesChannelId={defaultNotesChannelId}
                defaultNotesLabel={defaultNotesLabel}
                recordAllEnabled={recordAllEnabled}
                onSelect={onSelect}
                onRemove={onRemove}
              />
            ))}
          </Stack>
        )}
      </Stack>
    </Surface>
  );
}

const booleanStatus = (label: string, value: boolean | undefined) =>
  `${label} ${value === undefined ? "default" : value ? "on" : "off"}`;

function notesSummary(
  override: ChannelOverride | undefined,
  defaultChannelId: string | null,
  defaultLabel: string | undefined,
) {
  const text =
    override?.textLabel ??
    (defaultChannelId
      ? (defaultLabel ?? "Unavailable notes channel")
      : undefined);
  const source =
    override?.textChannelId !== undefined
      ? " \u00b7 Voice channel override"
      : defaultChannelId
        ? " \u00b7 Server default"
        : "";
  return `${text ?? "No notes channel configured. Manually started meetings use the command channel."}${source}`;
}

function recordingStatus(
  override: ChannelOverride | undefined,
  recordAllEnabled: boolean,
) {
  return override?.autoRecordEnabled
    ? "Auto-record on \u00b7 Voice channel override"
    : `${booleanStatus("Auto-record", recordAllEnabled)} \u00b7 Server default`;
}

type ChannelOverrideRowProps = Pick<
  ChannelOverridesCardProps,
  | "defaultNotesChannelId"
  | "defaultNotesLabel"
  | "recordAllEnabled"
  | "onSelect"
  | "onRemove"
> & {
  channelId: string;
  voiceLabel: string;
  override: ChannelOverride | undefined;
};

function ChannelOverrideRow({
  channelId,
  voiceLabel,
  override,
  defaultNotesChannelId,
  defaultNotesLabel,
  recordAllEnabled,
  onSelect,
  onRemove,
}: ChannelOverrideRowProps) {
  const label = override?.voiceLabel ?? voiceLabel;
  return (
    <Surface p="sm" withBorder data-testid="settings-override">
      <Group justify="space-between" align="center" wrap="nowrap">
        <Stack gap={2}>
          <Text fw={600}>{label}</Text>
          <Text size="xs" c="dimmed">
            {notesSummary(override, defaultNotesChannelId, defaultNotesLabel)}
          </Text>
        </Stack>
        <Stack gap={2} align="flex-end">
          <Text size="xs" c="dimmed">
            {recordingStatus(override, recordAllEnabled)}
          </Text>
          <Text size="xs" c="dimmed">
            {booleanStatus("Chat TTS", override?.chatTtsEnabled)}
          </Text>
          <Text size="xs" c="dimmed">
            {booleanStatus("TTS-only", override?.chatTtsTtsOnlyEnabled)}
          </Text>
        </Stack>
        <ActionIcon
          variant="subtle"
          aria-label={`Edit ${label}`}
          onClick={() => onSelect(channelId)}
        >
          <IconPencil size={16} />
        </ActionIcon>
        {onRemove && override ? (
          <ActionIcon
            variant="subtle"
            color="red"
            aria-label="Remove override"
            onClick={(event) => {
              event.stopPropagation();
              onRemove(override);
            }}
          >
            <IconTrash size={16} />
          </ActionIcon>
        ) : null}
      </Group>
    </Surface>
  );
}
