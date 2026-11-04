import { Badge, Button, Group, Text } from "@mantine/core";
import { IconExternalLink, IconSettings } from "@tabler/icons-react";
import Surface from "../../../components/Surface";
import type { NotionAutomationStatus } from "../../../../types/notionIntegration";
type LibraryNotionAutomation = NonNullable<
  NotionAutomationStatus["automation"]
>;

const getNotionStatusTone = (automation?: LibraryNotionAutomation) => {
  if (!automation) return "blue";
  if (!automation.enabled) return "gray";
  return automation.lastError || !automation.ownerConnected ? "red" : "teal";
};

const getNotionStatusCopy = (automation?: LibraryNotionAutomation) => {
  if (!automation) {
    return "Notion automation is available. Choose a shared destination in Server Settings to auto-export completed meetings.";
  }
  if (!automation.enabled) {
    return "Notion automation is configured but paused for this server.";
  }
  if (automation.lastError || !automation.ownerConnected) {
    return "Notion automation needs attention before exports can recover.";
  }
  return `Notion auto-export is on${automation.destinationTitle ? ` to ${automation.destinationTitle}` : ""}.`;
};

export function LibraryNotionStatus({
  status,
  canManage,
  onOpenSettings,
}: {
  status?: NotionAutomationStatus;
  canManage: boolean;
  onOpenSettings: () => void;
}) {
  const automation = status?.automation;
  if (!status?.configured || (!automation && !canManage)) return null;

  return (
    <Surface p="md" data-testid="library-notion-status">
      <Group justify="space-between" align="center" wrap="wrap">
        <Group gap="sm" align="center" wrap="wrap">
          <Badge color={getNotionStatusTone(automation)} variant="light">
            Notion
          </Badge>
          <Text size="sm" c="dimmed">
            {getNotionStatusCopy(automation)}
          </Text>
        </Group>
        <Group gap="xs">
          {automation?.destinationUrl ? (
            <Button
              component="a"
              href={automation.destinationUrl}
              target="_blank"
              rel="noopener noreferrer"
              variant="subtle"
              size="xs"
              leftSection={<IconExternalLink size={14} />}
            >
              Open destination
            </Button>
          ) : null}
          {canManage ? (
            <Button
              variant="light"
              size="xs"
              leftSection={<IconSettings size={14} />}
              onClick={onOpenSettings}
            >
              Notion settings
            </Button>
          ) : null}
        </Group>
      </Group>
    </Surface>
  );
}
