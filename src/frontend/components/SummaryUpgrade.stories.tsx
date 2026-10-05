import { Button, Group, Stack, Text } from "@mantine/core";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, within } from "storybook/test";
import { SUMMARY_UPGRADE } from "../../utils/summaryUpgrade";

// Discord owns the rendering. This story previews the posted copy and link row.
function SummaryUpgradePreview() {
  return (
    <Stack p="lg" maw={560} style={{ background: "#313338", color: "#DBDEE1" }}>
      <Stack
        p="md"
        gap="sm"
        style={{ background: "#2B2D31", borderLeft: "4px solid #00ae86" }}
      >
        <Text fw={700}>Weekly team meeting</Text>
        <Text>The team agreed on the launch date and assigned follow-ups.</Text>
        <Text size="sm">Duration: 30 minutes</Text>
        <Stack gap={4}>
          <Text fw={700}>{SUMMARY_UPGRADE.heading}</Text>
          <Text size="sm">{SUMMARY_UPGRADE.body}</Text>
        </Stack>
      </Stack>
      <Group gap="sm">
        <Button
          component="a"
          href="https://chronote.test/portal/meetings/example/meeting"
          color="gray"
          style={{ backgroundColor: "#4e5058", color: "#f2f3f5" }}
        >
          Open in Chronote
        </Button>
        <Button
          component="a"
          href="https://chronote.test/upgrade/select-server?serverId=example&plan=basic"
          color="gray"
          style={{ backgroundColor: "#4e5058", color: "#f2f3f5" }}
        >
          {SUMMARY_UPGRADE.button}
        </Button>
      </Group>
    </Stack>
  );
}

const meta: Meta<typeof SummaryUpgradePreview> = {
  title: "Discord/SummaryUpgrade",
  component: SummaryUpgradePreview,
  tags: ["summary-upgrade"],
};
export default meta;
type Story = StoryObj<typeof SummaryUpgradePreview>;
export const FreeServer: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("link", { name: "Upgrade", exact: true }),
    ).toHaveAttribute(
      "href",
      "https://chronote.test/upgrade/select-server?serverId=example&plan=basic",
    );
    await expect(canvas.getByText(SUMMARY_UPGRADE.body)).toBeVisible();
  },
};
