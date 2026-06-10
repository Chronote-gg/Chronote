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
  IconPlus,
  IconRefresh,
  IconTrash,
} from "@tabler/icons-react";
import Surface from "../../components/Surface";
import { uiOverlays } from "../../uiTokens";
import type { ChannelOverride } from "../../utils/settingsChannels";
import { formatChannelLabel } from "../../utils/settingsChannels";

type ChannelOverridesCardProps = {
  busy: boolean;
  refreshing: boolean;
  overrides: ChannelOverride[];
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
  overrides,
  onRefresh,
  onAdd,
  onSelect,
  onRemove,
  availableVoiceChannels,
}: ChannelOverridesCardProps) {
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

        {overrides.length === 0 ? (
          <Surface tone="soft" p="md">
            <Text c="dimmed" size="sm">
              No channel overrides yet. Add one to customize recording,
              chat-to-speech, or context per voice channel.
            </Text>
          </Surface>
        ) : (
          <Stack gap="xs">
            {overrides.map((override) => (
              <Surface
                key={override.channelId}
                p="sm"
                withBorder
                style={{ cursor: "pointer" }}
                onClick={() => onSelect(override.channelId)}
                data-testid="settings-override"
              >
                <Group justify="space-between" align="center" wrap="nowrap">
                  <Stack gap={2}>
                    <Text fw={600}>{override.voiceLabel}</Text>
                    <Text size="xs" c="dimmed">
                      Status/notes:{" "}
                      {override.textLabel
                        ? formatChannelLabel({
                            value: override.channelId,
                            label: override.textLabel,
                            botAccess: true,
                            missingPermissions: [],
                          })
                        : "Defaults"}
                    </Text>
                  </Stack>
                  <Stack gap={2} align="flex-end">
                    <Text size="xs" c="dimmed">
                      {override.autoRecordEnabled
                        ? "Auto-record on"
                        : "Auto-record off"}
                    </Text>
                    <Text size="xs" c="dimmed">
                      {override.chatTtsEnabled === undefined
                        ? "Chat TTS default"
                        : override.chatTtsEnabled
                          ? "Chat TTS on"
                          : "Chat TTS off"}
                    </Text>
                    <Text size="xs" c="dimmed">
                      {override.chatTtsTtsOnlyEnabled === undefined
                        ? "TTS-only default"
                        : override.chatTtsTtsOnlyEnabled
                          ? "TTS-only on"
                          : "TTS-only off"}
                    </Text>
                  </Stack>
                  {onRemove ? (
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
            ))}
          </Stack>
        )}
      </Stack>
    </Surface>
  );
}
