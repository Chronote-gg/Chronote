import type { Meta, StoryObj } from "@storybook/react";
import { PublicMeetingNotes } from "./PublicMeetingView";
const meta: Meta<typeof PublicMeetingNotes> = {
  title: "Sharing/PublicMeetingNotes",
  tags: ["recording-outcomes"],
  component: PublicMeetingNotes,
  args: {
    meeting: {
      notes:
        "## Saved decision\n\nThe generated fixture approved the release checklist.",
      capture: {
        kind: "interrupted",
        startedAt: "2026-01-01T00:00:00Z",
        detectedAt: "2026-01-01T01:00:00Z",
        endedAt: null,
      },
      recoveryNotice: "Saved recording recovery finished.",
    },
  },
};
export default meta;
type Story = StoryObj<typeof PublicMeetingNotes>;
export const Interrupted: Story = {};
export const Complete: Story = {
  args: {
    meeting: {
      notes:
        "## Saved decision\n\nThe generated fixture approved the release checklist.",
    },
  },
};
