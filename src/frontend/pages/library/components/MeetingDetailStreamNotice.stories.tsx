import type { Meta, StoryObj } from "@storybook/react";
import { MeetingDetailStreamNotice } from "./MeetingDetailStreamNotice";
const meta = {
  title: "Library/MeetingDetailStreamNotice",
  component: MeetingDetailStreamNotice,
  tags: ["r5-fix1"],
  args: { status: "unavailable", onRecheck: () => {} },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 760, margin: 24 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof MeetingDetailStreamNotice>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Unavailable: Story = {};
export const ConnectionError: Story = { args: { status: "error" } };
export const Rechecking: Story = { args: { status: "connecting" } };
