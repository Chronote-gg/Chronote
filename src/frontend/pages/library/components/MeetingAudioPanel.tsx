import { Divider, Group, Stack, Text, ThemeIcon } from "@mantine/core";
import { IconMicrophone } from "@tabler/icons-react";
import Surface from "../../../components/Surface";

type MeetingAudioPanelProps = {
  audioUrl?: string | null;
  accessEnabled?: boolean;
};

export function MeetingAudioPanel({
  audioUrl,
  accessEnabled = true,
}: MeetingAudioPanelProps) {
  return (
    <Surface p="md" tone="soft">
      <Group gap="sm" align="center" wrap="wrap">
        <ThemeIcon variant="light" color="cyan">
          <IconMicrophone size={16} />
        </ThemeIcon>
        <Stack gap={0}>
          <Text fw={600}>Audio</Text>
          <Text size="sm" c="dimmed">
            Playback for the full recording.
          </Text>
        </Stack>
      </Group>
      <Divider my="sm" />
      {!accessEnabled ? (
        <Text size="sm" c="dimmed">
          Audio recording access is disabled for this server.
        </Text>
      ) : audioUrl ? (
        <audio
          controls
          preload="metadata"
          style={{ width: "100%" }}
          src={audioUrl}
        />
      ) : (
        <Text size="sm" c="dimmed">
          Audio isn't available for this meeting yet.
        </Text>
      )}
    </Surface>
  );
}

export default MeetingAudioPanel;
