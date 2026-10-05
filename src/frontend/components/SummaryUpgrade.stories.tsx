import { Button, Group, Stack, Text } from "@mantine/core";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, within } from "storybook/test";
import {
  buildSummaryUpgradeBody,
  SUMMARY_UPGRADE,
} from "../../utils/summaryUpgrade";

// Discord owns the rendering. This story previews the posted copy and link row.
function SummaryUpgradePreview({ recordedSeconds = 5400, notes = false }) {
  return (
    <Stack p="lg" maw={560} style={{ background: "#313338", color: "#DBDEE1" }}>
      <Stack
        p="md"
        gap="sm"
        style={{ background: "#2B2D31", borderLeft: "4px solid #00ae86" }}
      >
        <Text fw={700}>{notes ? "Meeting Notes" : "Weekly team meeting"}</Text>
        <Text>
          {notes
            ? "Decisions: launch next Friday. Follow-ups: confirm the schedule and prepare the announcement."
            : "The team agreed on the launch date and assigned follow-ups."}
        </Text>
        {!notes && <Text size="sm">Duration: 30 minutes</Text>}
        <Stack gap={4}>
          <Text fw={700}>{SUMMARY_UPGRADE.heading}</Text>
          <Text size="sm">{buildSummaryUpgradeBody(recordedSeconds)}</Text>
        </Stack>
      </Stack>
      <Group gap="sm">
        {!notes && (
          <Button
            component="a"
            href="https://chronote.test/portal/meetings/example/meeting"
            color="gray"
            style={{ backgroundColor: "#4e5058", color: "#f2f3f5" }}
          >
            Open in Chronote
          </Button>
        )}
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
    await expect(canvas.getByText(buildSummaryUpgradeBody(5400))).toBeVisible();
  },
};
export const NotesAtSixtyMinutes: Story = {
  args: { recordedSeconds: 3600, notes: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(buildSummaryUpgradeBody(3600))).toBeVisible();
    await expect(
      canvas.getByRole("link", { name: "Upgrade", exact: true }),
    ).toBeVisible();
    await expect(
      canvas.queryByRole("link", { name: "Open in Chronote" }),
    ).not.toBeInTheDocument();
  },
};
export const NotesAboveTenHours: Story = {
  args: { recordedSeconds: 37800, notes: true },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText(
        /Your server has recorded 10 hours across/,
      ),
    ).toBeVisible();
  },
};
