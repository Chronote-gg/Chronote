import type { Meta, StoryObj } from "@storybook/react";
import { expect, within } from "storybook/test";
import { MeetingSummaryPanel } from "./MeetingSummaryPanel";

const meta: Meta<typeof MeetingSummaryPanel> = {
  title: "Library/MeetingSummaryPanel",
  component: MeetingSummaryPanel,
  render: (args) => (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: 360,
        maxWidth: 720,
      }}
    >
      <MeetingSummaryPanel {...args} />
    </div>
  ),
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

export const Default: Story = {};

export const EmptyRecording: Story = {
  args: {
    summary: "",
    notes: "",
    copyDisabled: true,
    processing: {
      transcription: "empty",
      notes: "skipped",
      summary: "skipped",
    },
  },
};

export const PartialTranscript: Story = {
  args: {
    processing: {
      transcription: "partial",
      notes: "generated",
      summary: "generated",
    },
  },
};

export const LongPartialTranscript: Story = {
  args: {
    notes: Array.from(
      { length: 24 },
      (_, index) => `- Surviving transcript detail ${index + 1}.`,
    ).join("\n"),
    processing: {
      transcription: "partial",
      notes: "generated",
      summary: "generated",
    },
  },
  play: async ({ canvasElement }) => {
    const viewport = within(canvasElement).getByTestId(
      "meeting-summary-scroll-viewport",
    );
    await expect(viewport.scrollHeight).toBeGreaterThan(viewport.clientHeight);
    viewport.scrollTop = 48;
    await expect(viewport.scrollTop).toBeGreaterThan(0);
    viewport.scrollTop = 0;
  },
};

export const TranscriptionFailed: Story = {
  args: {
    summary: "",
    notes: "",
    copyDisabled: true,
    processing: {
      transcription: "failed",
      notes: "skipped",
      summary: "skipped",
    },
  },
};

export const NotesGenerationFailed: Story = {
  args: {
    summary: "",
    notes: "",
    copyDisabled: true,
    processing: {
      transcription: "ready",
      notes: "failed",
      summary: "skipped",
    },
  },
};

export const LegacyUnavailable: Story = {
  args: {
    summary: "Notes will appear after the meeting is processed.",
    notes: "No notes recorded.",
    copyDisabled: true,
  },
};
