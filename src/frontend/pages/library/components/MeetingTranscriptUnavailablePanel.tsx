import { Text } from "@mantine/core";
import Surface from "../../../components/Surface";

export function MeetingTranscriptUnavailablePanel() {
  return (
    <Surface p="md" tone="soft">
      <Text fw={600}>Transcript unavailable</Text>
      <Text size="sm" c="dimmed">
        Transcript access is disabled for this server.
      </Text>
    </Surface>
  );
}

export default MeetingTranscriptUnavailablePanel;
