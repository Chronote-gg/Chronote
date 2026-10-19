import type { Meta, StoryObj } from "@storybook/react";
import { Anchor, Button, Paper, Stack, Text } from "@mantine/core";

// Matches the private acknowledgment contract in test/commands/startMeeting.test.ts.
// Fictional labels stand in for Discord mentions; this is not a native Discord capture.
function DiscordPayloadPreview({
  sameChannel = false,
}: {
  sameChannel?: boolean;
}) {
  return (
    <Stack p="md" maw={620}>
      <Text size="sm" c="dimmed">
        Fictional Discord payload preview
      </Text>
      <Paper withBorder p="md">
        <Stack gap="sm">
          <Text size="xs">
            Only you can see this · Invoked in #
            {sameChannel ? "meeting-notes" : "general"}
          </Text>
          <Text>
            Recording started in <strong>Voice Lounge</strong>. Controls and
            notes are in #meeting-notes.
          </Text>
          <Anchor href="https://discord.com/channels/111111111111111111/222222222222222222/333333333333333333">
            View recording
          </Anchor>
        </Stack>
      </Paper>
      <Paper withBorder p="md">
        <Stack gap="sm">
          <Text size="xs">#meeting-notes · Published recording message</Text>
          <Text fw={600}>Meeting Started</Text>
          <Text>Voice Lounge</Text>
          <Button disabled>End Meeting</Button>
        </Stack>
      </Paper>
      <Text size="xs" c="dimmed">
        Example message link and controls only. No Discord action is performed.
      </Text>
    </Stack>
  );
}
const meta = {
  title: "Discord/NotesDestination",
  tags: ["notes-destination"],
  component: DiscordPayloadPreview,
} satisfies Meta<typeof DiscordPayloadPreview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const DifferentChannel: Story = {};
export const SameChannel: Story = { args: { sameChannel: true } };
