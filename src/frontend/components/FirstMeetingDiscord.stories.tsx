import type { Meta, StoryObj } from "@storybook/react";
import { Box, Button, Group, Stack, Text } from "@mantine/core";
import { expect, within } from "storybook/test";
import { z } from "zod";
import { buildFirstMeetingInstallerMessage } from "../../utils/firstMeetingGuide";
import MarkdownBody from "./MarkdownBody";

const serializedMessage = z.object({
  content: z.string(),
  components: z.array(
    z.object({
      components: z.array(z.object({ label: z.string(), url: z.string() })),
    }),
  ),
});
function InstallerPreview() {
  const payload = serializedMessage.parse(
    JSON.parse(
      JSON.stringify(
        buildFirstMeetingInstallerMessage({
          guildId: "12345678901234567890",
          serverName: "Engineering HQ",
          siteUrl: "https://chronote.gg",
        }),
      ),
    ),
  );
  return (
    <Box
      p="lg"
      style={{
        background: "#313338",
        color: "#DBDEE1",
        maxWidth: 720,
        minHeight: "100vh",
      }}
    >
      <Stack gap="md">
        <Group gap="xs">
          <Text fw={700} c="#F2F3F5">
            Chronote
          </Text>
          <Text size="xs" c="#949BA4">
            APP · Direct message
          </Text>
        </Group>
        <MarkdownBody content={payload.content} />
        <Group>
          {payload.components
            .flatMap((row) => row.components)
            .map((button) => (
              <Button
                key={button.label}
                component="a"
                href={button.url}
                color="gray"
                variant="filled"
                style={{ background: "#4e5058", color: "#fff" }}
              >
                {button.label}
              </Button>
            ))}
        </Group>
      </Stack>
    </Box>
  );
}
const meta = {
  title: "Discord/FirstMeeting",
  tags: ["first-meeting"],
  component: InstallerPreview,
} satisfies Meta<typeof InstallerPreview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const InstallerGuide: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByText("Engineering HQ", { exact: true }),
    ).toBeVisible();
    await expect(canvas.getByText("Join a voice channel.")).toBeVisible();
    await expect(
      canvas.getByText("/startmeeting", { exact: true }),
    ).toBeVisible();
    await expect(
      canvas.getByText("End meeting", { exact: true }),
    ).toBeVisible();
    await expect(
      canvas.getByText(
        "Your notes will be posted with the recording and saved in your meeting library.",
      ),
    ).toBeVisible();
    await expect(
      canvas.getByRole("link", { name: "Open portal" }),
    ).toHaveAttribute(
      "href",
      "https://chronote.gg/portal/meetings?scope=guild&serverId=12345678901234567890",
    );
    await expect(
      canvas.getByRole("link", { name: "Open Engineering HQ" }),
    ).toHaveAttribute(
      "href",
      "https://discord.com/channels/12345678901234567890",
    );
    await expect(canvas.queryByText("/onboard")).not.toBeInTheDocument();
  },
};
export const InstallerGuideMobile: Story = { ...InstallerGuide };
export const InstallerGuideTablet: Story = { ...InstallerGuide };
