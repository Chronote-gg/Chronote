import { Badge, Divider, Group, Paper, Stack, Text } from "@mantine/core";

const DECISIONS = [
  "Community game night moves to Saturdays at 8pm ET.",
  "Prize pool for the spring tournament is capped at $150.",
];

const ACTION_ITEMS = [
  "Alex posts the new schedule in the announcements channel by Friday.",
  "Sam confirms whether the sponsor still wants a banner slot.",
];

/**
 * An illustrative example of what Chronote posts back to a channel. The
 * content is invented for the marketing page and is not a real meeting.
 */
export function SampleSummary() {
  return (
    <Paper
      withBorder
      radius="md"
      p="lg"
      data-testid="sample-summary"
      style={{ borderLeftWidth: 3 }}
    >
      <Stack gap="md">
        <Group justify="space-between" align="flex-start" wrap="wrap" gap="xs">
          <Stack gap={2}>
            <Text fw={600}>Community sync</Text>
            <Text size="xs" c="dimmed">
              38 minutes, 5 people
            </Text>
          </Stack>
          <Badge variant="light" size="sm">
            Example
          </Badge>
        </Group>

        <Stack gap={6}>
          <Text size="xs" fw={600} c="dimmed" tt="uppercase">
            Decisions
          </Text>
          {DECISIONS.map((decision) => (
            <Text key={decision} size="sm">
              {decision}
            </Text>
          ))}
        </Stack>

        <Stack gap={6}>
          <Text size="xs" fw={600} c="dimmed" tt="uppercase">
            Action items
          </Text>
          {ACTION_ITEMS.map((item) => (
            <Text key={item} size="sm">
              {item}
            </Text>
          ))}
        </Stack>

        <Divider />

        <Stack gap={4}>
          <Text size="sm" fs="italic">
            "Let's keep Saturdays and see if attendance holds for a month."
          </Text>
          <Text size="xs" c="dimmed" ff="monospace">
            Jordan, 00:12:34
          </Text>
        </Stack>
      </Stack>
    </Paper>
  );
}

export default SampleSummary;
