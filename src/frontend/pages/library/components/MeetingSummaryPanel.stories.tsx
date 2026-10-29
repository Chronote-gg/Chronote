import { Stack, Text } from "@mantine/core";
import Surface from "../../../components/Surface";
import { MeetingUpdateDeliveryStatus } from "./MeetingUpdateDeliveryStatus";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, within } from "storybook/test";
import { MeetingSummaryPanel } from "./MeetingSummaryPanel";

const meta: Meta<typeof MeetingSummaryPanel> = {
  title: "Library/MeetingSummaryPanel",
  tags: ["recording-outcomes"],
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
export const InterruptedRecording: Story = {
  args: {
    capture: {
      kind: "interrupted",
      startedAt: "2026-01-01T00:00:00Z",
      detectedAt: "2026-01-01T01:00:00Z",
      endedAt: null,
    },
    captureCoverage: {
      kind: "verified",
      savedDurationMs: 42500,
      lastConfirmedCaptureAt: "2026-01-01T00:00:43Z",
    },
    recoveryNotice: "Saved recording recovery finished.",
  },
};
export const InterruptedLongNotes: Story = {
  args: {
    ...InterruptedRecording.args,
    notes: Array.from(
      { length: 24 },
      (_, index) => `- Generated saved decision ${index + 1}.`,
    ).join("\n"),
  },
  play: async ({ canvasElement }) => {
    const viewport = within(canvasElement).getByTestId(
      "meeting-summary-scroll-viewport",
    );
    await expect(viewport.scrollHeight).toBeGreaterThan(viewport.clientHeight);
    viewport.scrollTop = 60;
    await expect(viewport.scrollTop).toBeGreaterThan(0);
    viewport.scrollTop = 0;
  },
};

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
export const RecoveryNeedsReview: Story = {
  args: {
    summary: "",
    notes: "",
    capture: {
      kind: "complete",
      startedAt: "2026-01-01T00:00:00Z",
      endedAt: "2026-01-01T00:00:30Z",
    },
    recovery: { disposition: "needs_reconciliation", stage: "verification" },
    recoveryNotice:
      "Recovery needs review. Processing or delivery could not be confirmed.",
    copyDisabled: true,
  },
};
export const NotesDisabledAfterRecovery: Story = {
  args: {
    summary: "",
    notes: "",
    processing: {
      transcription: "partial",
      notes: "skipped",
      summary: "skipped",
    },
    capture: {
      kind: "interrupted",
      startedAt: "2026-01-01T00:00:00Z",
      detectedAt: "2026-01-01T01:00:00Z",
      endedAt: null,
    },
    recovery: { disposition: "done", stage: "notes", outcome: "disabled" },
    recoveryNotice:
      "Recovery finished with the original transcription and notes settings.",
    copyDisabled: true,
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

export const ProcessingRetryAvailable: Story = {
  args: {
    ...NotesGenerationFailed.args,
    processingRetry: {
      view: {
        eligible: true,
        requiresReplaceConfirm: false,
        attemptsRemaining: 3,
      },
      pending: false,
      onRetry: () => undefined,
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

export const ConstrainedDrawerWithDeliveryStatus: Story = {
  tags: ["meeting-update-constrained-drawer"],
  args: {
    notes: Array.from(
      { length: 24 },
      (_, index) => `- Canonical meeting decision ${index + 1}.`,
    ).join("\n"),
  },
  render: (args) => (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: 540,
        maxWidth: 500,
      }}
    >
      <MeetingUpdateDeliveryStatus
        delivery={{
          status: "held",
          reason: "initial_publication_unsettled",
          pollable: false,
          desiredRevision: 1,
          syncedRevision: null,
          lastSuccess: null,
        }}
      />
      <Stack
        gap="md"
        style={{ flex: 1, minHeight: 0, overflowY: "auto" }}
        data-testid="constrained-drawer-scroll"
      >
        <Surface p="md">
          <Text fw={600}>Audio recording</Text>
          <div style={{ height: 80 }} />
        </Surface>
        <MeetingSummaryPanel {...args} />
        <Surface p="md">
          <Text fw={600}>Attendees</Text>
          <Text>Speaker A, Speaker B</Text>
        </Surface>
        <Surface p="md">
          <Text fw={600}>Full transcript</Text>
          <Text>
            View the speaker timeline and transcript events in fullscreen.
          </Text>
        </Surface>
      </Stack>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const summary = canvas.getByTestId("meeting-summary-scroll-viewport");
    await expect(summary.clientHeight).toBeGreaterThan(64);
    await expect(summary.scrollHeight).toBeGreaterThan(summary.clientHeight);
    summary.scrollTop = 60;
    await expect(summary.scrollTop).toBeGreaterThan(0);
    summary.scrollTop = 0;
    const body = canvas.getByTestId("constrained-drawer-scroll");
    await expect(body.scrollHeight).toBeGreaterThan(body.clientHeight);
    body.scrollTop = 60;
    await expect(body.scrollTop).toBeGreaterThan(0);
    body.scrollTop = 0;
  },
};
