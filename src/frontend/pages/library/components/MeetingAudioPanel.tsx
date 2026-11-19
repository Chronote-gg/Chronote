import type { Ref } from "react";
import { Divider, Group, Stack, Text, ThemeIcon } from "@mantine/core";
import { IconMicrophone } from "@tabler/icons-react";
import Surface from "../../../components/Surface";

type MeetingAudioPanelProps = {
  audioUrl?: string | null;
  accessEnabled?: boolean;
  audioRef?: Ref<HTMLAudioElement>;
  onPlaybackTimeChange?: (seconds: number | null) => void;
};

export function MeetingAudioPanel({
  audioUrl,
  accessEnabled = true,
  audioRef,
  onPlaybackTimeChange,
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
          ref={audioRef}
          controls
          preload="metadata"
          onPlaying={(event) =>
            onPlaybackTimeChange?.(event.currentTarget.currentTime)
          }
          onTimeUpdate={(event) => {
            const audio = event.currentTarget;
            onPlaybackTimeChange?.(
              audio.paused || audio.ended ? null : audio.currentTime,
            );
          }}
          onPause={() => onPlaybackTimeChange?.(null)}
          onEnded={() => onPlaybackTimeChange?.(null)}
          onEmptied={() => onPlaybackTimeChange?.(null)}
          onError={() => onPlaybackTimeChange?.(null)}
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
