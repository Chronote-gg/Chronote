import { Button, Group, Text } from "@mantine/core";
import Surface from "../../../components/Surface";
import type { useLiveMeetingStream } from "../../../hooks/useLiveMeetingStream";
export function MeetingDetailStreamNotice({
  status,
  onRecheck,
}: {
  status: ReturnType<typeof useLiveMeetingStream>["status"];
  onRecheck: () => void;
}) {
  if (status === "connecting")
    return (
      <Text role="status" size="sm" c="dimmed">
        Checking recording status...
      </Text>
    );
  if (status !== "unavailable" && status !== "error") return null;
  return (
    <Surface p="sm" tone="soft">
      <Group justify="space-between" wrap="wrap">
        <Text role="status" size="sm">
          {status === "unavailable"
            ? "Recording status cannot be confirmed."
            : "Unable to connect to the live transcript."}
        </Text>
        <Button size="xs" variant="light" onClick={onRecheck}>
          Recheck recording status
        </Button>
      </Group>
    </Surface>
  );
}
