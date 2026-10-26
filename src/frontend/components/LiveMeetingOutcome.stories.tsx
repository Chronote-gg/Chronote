import type { Meta, StoryObj } from "@storybook/react";
import { LiveMeetingOutcome } from "./LiveMeetingOutcome";
const meta: Meta<typeof LiveMeetingOutcome> = {
  title: "Meetings/LiveMeetingOutcome",
  tags: ["recording-outcomes"],
  component: LiveMeetingOutcome,
  args: {
    status: "interrupted",
    meeting: {
      capture: {
        kind: "interrupted",
        startedAt: "2026-01-01T00:00:00Z",
        detectedAt: "2026-01-01T01:00:00Z",
        endedAt: null,
      },
      recoveryNotice: "Recovering saved recording.",
    },
  },
};
export default meta;
type Story = StoryObj<typeof LiveMeetingOutcome>;
export const Interrupted: Story = {};
export const Unavailable: Story = {
  args: { status: "unavailable", meeting: null },
};
export const Complete: Story = { args: { status: "complete", meeting: null } };
