import type { Meta, StoryObj } from "@storybook/react";
import { MeetingSummaryPanel } from "./MeetingSummaryPanel";

const meta: Meta<typeof MeetingSummaryPanel> = {
  title: "Library/MeetingSummaryPanel",
  component: MeetingSummaryPanel,
  args: {
    summary:
      "Speaker A ran a brief microphone and transcription check by counting from one to eight, continuing the recent series of short audio verification tests.",
    notes:
      '- Speaker A performed a brief mic and transcription check by counting: "Testing 1 2 3 4 5 6 7 8."\n- Continued the pattern from recent sessions of short voice verification tests.',
    summaryFeedback: null,
    feedbackPending: false,
    copyDisabled: false,
    onFeedbackUp: () => undefined,
    onFeedbackDown: () => undefined,
    onCopySummary: () => undefined,
    onSuggestCorrection: () => undefined,
  },
};

export default meta;

type Story = StoryObj<typeof MeetingSummaryPanel>;

export const Default: Story = {
  render: (args) => (
    <div style={{ height: 360, maxWidth: 720 }}>
      <MeetingSummaryPanel {...args} />
    </div>
  ),
};
