import { Box } from "@mantine/core";
import type { Meta, StoryObj } from "@storybook/react";
import MeetingSources from "./MeetingSources";
const meta = {
  title: "Components/MeetingSources",
  component: MeetingSources,
  tags: ["unified-meetings"],
  render: (args) => (
    <Box w="100%" maw={300}>
      <MeetingSources {...args} />
    </Box>
  ),
  args: {
    sources: [
      { id: "one", name: "Design team" },
      { id: "previous", name: "Previous community", retainedAccess: true },
    ],
    scope: { kind: "all" },
    onSelect: () => {},
  },
} satisfies Meta<typeof MeetingSources>;
export default meta;
type Story = StoryObj<typeof meta>;
export const All: Story = {};
export const Personal: Story = { args: { scope: { kind: "personal" } } };
export const MissingIcon: Story = {
  args: {
    sources: [{ id: "bad", name: "Missing icon server", icon: "invalid" }],
    scope: { kind: "guild", serverId: "bad" },
  },
};
export const LongSources: Story = {
  args: {
    sources: Array.from({ length: 30 }, (_, index) => ({
      id: String(index),
      name: `Server ${index} with a very long community name that wraps clearly`,
    })),
  },
};
export const Mobile: Story = {
  parameters: { viewport: { defaultViewport: "mobile1" } },
  args: { scope: { kind: "personal" } },
};
